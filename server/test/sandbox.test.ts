import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { closeDb, initDb } from "../src/db/index.js";
import { loadOrCreateKey } from "../src/lib/crypto.js";
import {
  bwrapArgs,
  checkHostPath,
  parseHostPaths,
  seatbeltProfile,
  StdioSandbox,
  type SandboxLayout,
} from "../src/lib/sandbox.js";
import { AdminSessionStore } from "../src/http/adminAuth.js";
import { createApp } from "../src/http/app.js";
import type { AppContext } from "../src/http/context.js";

const layout = (over: Partial<SandboxLayout> = {}): SandboxLayout => ({
  home: "/sb/server-1",
  readOnly: [],
  hostPaths: [],
  hidden: ["/data"],
  ...over,
});

const mergedUsr = (p: string) =>
  ({ "/bin": { type: "link", target: "usr/bin" }, "/lib": { type: "link", target: "usr/lib" } })[p] ?? null;

/** The `--flag src dest` triples of an argv, as "flag src" strings, in order. */
const mounts = (args: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (["--ro-bind", "--bind", "--ro-bind-try", "--symlink"].includes(args[i])) out.push(`${args[i]} ${args[i + 1]}`);
  }
  return out;
};

describe("bwrapArgs", () => {
  it("builds a fresh namespace set with the system read-only and only the server's home writable", () => {
    const args = bwrapArgs({ command: "npx", args: ["-y", "pkg"], env: {} }, layout(), { disableUserns: true, kind: mergedUsr });
    expect(args).toEqual(expect.arrayContaining(["--unshare-user", "--unshare-pid", "--die-with-parent", "--new-session", "--disable-userns"]));
    expect(args).not.toContain("--unshare-net");
    expect(args).not.toContain("--unshare-all");
    expect(mounts(args)).toEqual([
      "--ro-bind /usr",
      "--ro-bind /etc",
      "--symlink usr/bin",
      "--symlink usr/lib",
      "--ro-bind-try /run/systemd/resolve",
      "--bind /sb/server-1",
    ]);
    expect(args.slice(-6)).toEqual(["--chdir", "/sb/server-1", "--", "npx", "-y", "pkg"]);
  });

  it("leaves out --disable-userns when bubblewrap is too old for it", () => {
    const args = bwrapArgs({ command: "x", args: [], env: {} }, layout(), { disableUserns: false, kind: mergedUsr });
    expect(args).not.toContain("--disable-userns");
  });

  it("mounts host paths with their mode, parents before children, and skips runtime dirs under /usr", () => {
    const args = bwrapArgs(
      { command: "x", args: [], env: {}, cwd: "/srv/projects/app" },
      layout({
        readOnly: ["/usr/local", "/home/me/.nvm/versions/node/v22"],
        hostPaths: [
          { path: "/srv/projects/app", writable: true },
          { path: "/srv/projects", writable: false },
        ],
      }),
      { disableUserns: true, kind: () => null },
    );
    expect(mounts(args).slice(-4)).toEqual([
      "--bind /sb/server-1",
      "--ro-bind /srv/projects",
      "--bind /srv/projects/app",
      "--ro-bind /home/me/.nvm/versions/node/v22",
    ]);
    expect(args).not.toContain("/usr/local");
    expect(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2)).toEqual(["--chdir", "/srv/projects/app"]);
  });
});

describe("seatbeltProfile", () => {
  it("refuses writes, hides the protected paths, then reopens what the server may use", () => {
    const profile = seatbeltProfile(
      layout({ readOnly: ["/Users/me/.nvm"], hostPaths: [{ path: '/tmp/odd "dir"', writable: false }], hidden: ["/data", "/Users/me"] }),
    );
    const lines = profile.trim().split("\n");
    expect(lines[1]).toBe("(allow default)");
    expect(lines[2]).toBe("(deny file-write*)");
    expect(lines[3]).toContain('(subpath "/sb/server-1")');
    expect(lines[4]).toBe('(deny file-read* file-write* (subpath "/data") (subpath "/Users/me"))');
    expect(lines[5]).toBe('(allow file-read* (subpath "/Users/me/.nvm") (subpath "/tmp/odd \\"dir\\""))');
    expect(lines[6]).toBe('(allow file-read* file-write* (subpath "/sb/server-1"))');
  });
});

describe("host paths", () => {
  it("rejects relative paths, the root, and anything overlapping the protected paths", () => {
    expect(checkHostPath("projects", ["/data"])).toMatch(/absolute/);
    expect(checkHostPath("/", ["/data"])).toMatch(/whole filesystem/);
    expect(checkHostPath("/data/secret.key", ["/data"])).toMatch(/overlaps/);
    // Realpaths are compared, and a parent of a protected path overlaps it too.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sb-hostpath-"));
    fs.mkdirSync(path.join(parent, "data"));
    expect(checkHostPath(parent, [path.join(fs.realpathSync(parent), "data")])).toMatch(/overlaps/);
    fs.rmSync(parent, { recursive: true });
    expect(checkHostPath("/srv/projects", ["/data"])).toBeNull();
  });

  it("reads a malformed column as no host paths", () => {
    expect(parseHostPaths(null)).toEqual([]);
    expect(parseHostPaths("not json")).toEqual([]);
    expect(parseHostPaths('[{"path":"/a","writable":true},{"path":3}]')).toEqual([{ path: "/a", writable: true }]);
  });
});

describe("StdioSandbox", () => {
  let tmp: string;
  let sandbox: StdioSandbox;
  let available = false;

  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sb-sandbox-")));
    fs.mkdirSync(path.join(tmp, "data"));
    fs.writeFileSync(path.join(tmp, "data", "secret.key"), "TOPSECRET");
    fs.mkdirSync(path.join(tmp, "sandboxes", "server-2"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "sandboxes", "server-2", "theirs.txt"), "NEIGHBOUR");
    fs.mkdirSync(path.join(tmp, "shared"));
    fs.writeFileSync(path.join(tmp, "shared", "notes.txt"), "SHARED");
    sandbox = new StdioSandbox({ rootDir: path.join(tmp, "sandboxes"), dataDir: path.join(tmp, "data") });
    available = (await sandbox.probe()).available;
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const probeScript = `
    const fs = require("fs");
    const tryRead = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "DENIED"; } };
    const tryWrite = (p) => { try { fs.writeFileSync(p, "x"); return "OK"; } catch (e) { return "DENIED"; } };
    console.log(JSON.stringify({
      secret: tryRead(process.argv[1]),
      neighbour: tryRead(process.argv[2]),
      shared: tryRead(process.argv[3]),
      writeHome: tryWrite(require("path").join(process.env.HOME, "state.json")),
      writeShared: tryWrite(process.argv[3]),
      home: process.env.HOME,
      apiKey: process.env.API_KEY,
    }));`;

  function runWrapped(hostPaths: { path: string; writable: boolean }[] = []) {
    const wrapped = sandbox.wrap(
      {
        command: "node",
        args: [
          "-e",
          probeScript,
          path.join(tmp, "data", "secret.key"),
          path.join(tmp, "sandboxes", "server-2", "theirs.txt"),
          path.join(tmp, "shared", "notes.txt"),
        ],
        env: { PATH: process.env.PATH ?? "", API_KEY: "mine" },
      },
      { serverId: 1, hostPaths },
    );
    const res = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, cwd: wrapped.cwd, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`sandboxed node failed (${res.status}): ${res.stderr}`);
    return JSON.parse(res.stdout.trim().split("\n").pop()!);
  }

  it("keeps the data dir and other servers' homes out of reach, and gives the server its own home", (ctx) => {
    if (!available) ctx.skip();
    const out = runWrapped();
    expect(out.secret).toBe("DENIED");
    expect(out.neighbour).toBe("DENIED");
    // bubblewrap mounts only what's listed; Seatbelt hides only the protected paths and the home dir.
    if (sandbox.getStatus().kind === "bwrap") expect(out.shared).toBe("DENIED");
    expect(out.writeHome).toBe("OK");
    expect(out.home).toBe(path.join(tmp, "sandboxes", "server-1"));
    expect(out.apiKey).toBe("mine");
  });

  it("mounts a host path read-only unless it is marked writable", (ctx) => {
    if (!available) ctx.skip();
    const ro = runWrapped([{ path: path.join(tmp, "shared"), writable: false }]);
    expect(ro.shared).toBe("SHARED");
    expect(ro.writeShared).toBe("DENIED");
    const rw = runWrapped([{ path: path.join(tmp, "shared"), writable: true }]);
    expect(rw.writeShared).toBe("OK");
    expect(rw.secret).toBe("DENIED");
  });

  it("refuses a working directory outside the sandbox and a host path into the data dir", (ctx) => {
    if (!available) ctx.skip();
    expect(() => sandbox.wrap({ command: "node", args: [], env: {}, cwd: tmp }, { serverId: 1, hostPaths: [] })).toThrow(
      /outside the sandbox/,
    );
    expect(() =>
      sandbox.wrap({ command: "node", args: [], env: {} }, { serverId: 1, hostPaths: [{ path: tmp, writable: false }] }),
    ).toThrow(/overlaps/);
  });

  it("refuses to run anything where no sandbox exists", async () => {
    const none = new StdioSandbox({ rootDir: path.join(tmp, "none"), dataDir: path.join(tmp, "data"), platform: "win32" });
    expect((await none.probe()).available).toBe(false);
    expect(() => none.wrap({ command: "node", args: [], env: {} }, { serverId: 1, hostPaths: [] })).toThrow(
      /isn't available: No sandbox is available on win32/,
    );
  });
});

describe("sandbox settings via REST", () => {
  let tmp: string;
  let app: Hono;
  let admin: string;
  let bob: string;
  const restartStdio = vi.fn(async () => {});

  async function call(method: string, url: string, cookie: string, body?: unknown) {
    const res = await app.request(url, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: set?.match(/sb_session=[^;]+/)?.[0] };
  }

  const LOCAL = { name: "Files", slug: "files", type: "stdio", command: "npx", args: ["-y", "fs-server"] };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-sandbox-rest-"));
    loadOrCreateKey(tmp);
    const db = initDb(tmp);
    restartStdio.mockClear();
    const ctx = {
      db,
      hub: { notifyAgent: vi.fn(), dropAgentSessions: vi.fn(async () => {}), sessionCount: () => 0 },
      refresher: { cancel: vi.fn(), schedule: vi.fn() },
      manager: { reconcile: vi.fn(async () => {}), get: () => undefined, restartStdio, sandbox: undefined },
      adminSessions: new AdminSessionStore(db),
      version: "test",
    };
    app = createApp(ctx as unknown as AppContext, path.join(tmp, "no-web"), { serveMcp: false });
    admin = (await call("POST", "/api/auth/setup", "", { password: "admin-pass" })).cookie!;
    const created = await call("POST", "/api/users", admin, { username: "bob" });
    await call("PATCH", `/api/users/${created.body.user.id}`, admin, { canRunLocalCommands: true });
    bob = (await call("POST", "/api/auth/setup-code", "", { username: "bob", code: created.body.setupCode.code, password: "bob-pass" }))
      .cookie!;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("lets only the Admin turn a server's sandbox off or give it host paths", async () => {
    const own = await call("POST", "/api/servers", bob, LOCAL);
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ unsandboxed: false, hostPaths: [] });

    expect((await call("PATCH", `/api/servers/${own.body.id}`, bob, { unsandboxed: true })).status).toBe(403);
    const withPaths = await call("PATCH", `/api/servers/${own.body.id}`, bob, { hostPaths: [{ path: "/srv", writable: false }] });
    expect(withPaths.status).toBe(403);
    expect(withPaths.body.error).toMatch(/Only the Admin/);
    expect((await call("POST", "/api/servers", bob, { ...LOCAL, slug: "files-2", unsandboxed: true })).status).toBe(403);

    const mine = await call("POST", "/api/servers", admin, { ...LOCAL, hostPaths: [{ path: "/srv/projects", writable: true }] });
    expect(mine.status).toBe(201);
    expect(mine.body.hostPaths).toEqual([{ path: "/srv/projects", writable: true }]);
    const off = await call("PATCH", `/api/servers/${mine.body.id}`, admin, { unsandboxed: true, hostPaths: null });
    expect(off.body).toMatchObject({ unsandboxed: true, hostPaths: [] });
  });

  it("refuses a host path that reaches the switchboard's own data", async () => {
    for (const p of [path.join(config.dataDir, "secret.key"), config.sandboxDir, "/", "relative/dir"]) {
      const res = await call("POST", "/api/servers", admin, { ...LOCAL, hostPaths: [{ path: p, writable: false }] });
      expect(res.status, p).toBe(400);
    }
  });

  it("reports the sandbox to signed-in users and lets only the Admin turn it off", async () => {
    expect((await call("GET", "/api/auth/me", "")).body.sandbox).toBeUndefined();
    expect((await call("GET", "/api/auth/me", bob)).body.sandbox).toMatchObject({ enabled: true, available: false });

    expect((await call("POST", "/api/auth/settings", bob, { sandbox: false })).status).toBe(403);
    expect((await call("POST", "/api/auth/settings", admin, { sandbox: false })).status).toBe(200);
    expect(restartStdio).toHaveBeenCalledTimes(1);
    expect((await call("GET", "/api/auth/me", bob)).body.sandbox.enabled).toBe(false);
    // Saving the same value again doesn't bounce every local server.
    await call("POST", "/api/auth/settings", admin, { sandbox: false });
    expect(restartStdio).toHaveBeenCalledTimes(1);
  });
});
