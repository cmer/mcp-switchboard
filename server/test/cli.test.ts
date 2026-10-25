import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb, PRE_MULTIUSER_BACKUP, type Db } from "../src/db/index.js";
import { adminSessions, users } from "../src/db/schema.js";
import { openCliDb, runCli, resetPassword, setLoginMode, USAGE, type CliIo } from "../src/cli.js";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { issueSetupCode } from "../src/core/setupCodes.js";
import { createUser, defaultUserId, getUserByUsername } from "../src/core/users.js";
import { hashPassword, loadOrCreateKey, verifyPassword } from "../src/lib/crypto.js";
import { readAccessSettings, readLoginMode, readSetting, writeSetting } from "../src/lib/settings.js";

let tmp: string;
let db: Db;
let out: string[];
let err: string[];
let closed: number;

function io(overrides: Partial<CliIo> = {}): CliIo {
  return {
    version: "9.9.9-test",
    dataDir: tmp,
    out: (m) => out.push(m),
    err: (m) => err.push(m),
    interactive: false,
    promptHidden: async () => {
      throw new Error("unexpected prompt");
    },
    readStdin: async () => "",
    openDb: () => db,
    closeDb: () => void closed++,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-cli-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  out = [];
  err = [];
  closed = 0;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedBob() {
  const bob = createUser(db, { username: "bob" });
  db.update(users).set({ passwordHash: hashPassword("old-pass") }).where(eq(users.id, bob.id)).run();
  issueSetupCode(db, bob.id);
  db.insert(adminSessions).values({ id: "s1", userId: bob.id, createdAt: Date.now() }).run();
  db.insert(adminSessions).values({ id: "s2", userId: defaultUserId(db), createdAt: Date.now() }).run();
  return bob;
}

describe("reset-password", () => {
  it("sets the password directly, voids a pending setup code and drops only that user's sessions", () => {
    const bob = seedBob();
    resetPassword(db, "bob", "fresh-pass");
    const row = getUserByUsername(db, "bob")!;
    expect(verifyPassword("fresh-pass", row.passwordHash!)).toBe(true);
    expect(verifyPassword("old-pass", row.passwordHash!)).toBe(false);
    expect(row).toMatchObject({ setupCodeHash: null, setupCodeExpiresAt: null });
    expect(db.select().from(adminSessions).where(eq(adminSessions.userId, bob.id)).all()).toEqual([]);
    expect(db.select().from(adminSessions).all().map((s) => s.id)).toEqual(["s2"]);
  });

  it("works for the Default user when it has no password yet", () => {
    resetPassword(db, "admin", "brand-new");
    expect(verifyPassword("brand-new", getUserByUsername(db, "admin")!.passwordHash!)).toBe(true);
  });

  it("rejects unknown users and short passwords", () => {
    expect(() => resetPassword(db, "ghost", "long-enough")).toThrow(/No user named "ghost"/);
    createUser(db, { username: "bob" });
    expect(() => resetPassword(db, "bob", "abc")).toThrow(/at least 4/);
  });

  it("reads the password from stdin without a terminal", async () => {
    seedBob();
    const code = await runCli(["reset-password", "bob", "--password-stdin"], io({ readStdin: async () => "piped-pass\n" }));
    expect(code).toBe(0);
    expect(verifyPassword("piped-pass", getUserByUsername(db, "bob")!.passwordHash!)).toBe(true);
    expect(out.join("\n")).toContain("bob");
    expect(closed).toBe(1);
  });

  it("works end to end from a real piped stdin, beside an open database", () => {
    // What `printf '%s' "$PW" | docker compose exec -T switchboard node dist/index.js reset-password admin --password-stdin` runs.
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const run = (input: string, ...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
        input,
        encoding: "utf8",
        env: { ...process.env, DATA_DIR: tmp },
        cwd: path.dirname(path.dirname(entry)),
        timeout: 30_000,
      });

    const reset = run("piped-no-newline", "reset-password", "admin", "--password-stdin");
    expect(reset.status, reset.stderr).toBe(0);
    expect(verifyPassword("piped-no-newline", getUserByUsername(db, "admin")!.passwordHash!)).toBe(true);

    const status = run("", "status", "--json");
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ dataDir: tmp, defaultUser: { username: "admin", hasPassword: true } });

    const empty = run("", "reset-password", "admin", "--password-stdin");
    expect(empty.status).toBe(1);
    expect(empty.stderr).toMatch(/at least 4/);
  }, 60_000);

  it("prompts twice on a terminal and insists the two match", async () => {
    seedBob();
    const typed = ["first-pass", "other-pass"];
    const prompts: string[] = [];
    const terminal = io({
      interactive: true,
      promptHidden: async (q) => {
        prompts.push(q);
        return typed.shift()!;
      },
    });
    expect(await runCli(["reset-password", "bob"], terminal)).toBe(1);
    expect(err.join("\n")).toMatch(/don't match/);
    expect(prompts).toHaveLength(2);
    expect(verifyPassword("old-pass", getUserByUsername(db, "bob")!.passwordHash!)).toBe(true);

    typed.push("same-pass", "same-pass");
    expect(await runCli(["reset-password", "bob"], terminal)).toBe(0);
    expect(verifyPassword("same-pass", getUserByUsername(db, "bob")!.passwordHash!)).toBe(true);
  });

  it("refuses to prompt without a terminal, and checks the username before asking for a password", async () => {
    seedBob();
    expect(await runCli(["reset-password", "bob"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/--password-stdin/);

    err.length = 0;
    const terminal = io({ interactive: true });
    expect(await runCli(["reset-password", "ghost"], terminal)).toBe(1); // promptHidden would throw "unexpected prompt"
    expect(err.join("\n")).toMatch(/No user named "ghost"/);
    expect(closed).toBe(2);
  });

  it("needs exactly one username", async () => {
    expect(await runCli(["reset-password"], io())).toBe(1);
    expect(await runCli(["reset-password", "a", "b"], io())).toBe(1);
    expect(await runCli(["reset-password", "--bogus"], io())).toBe(1);
    expect(err.every((m) => m.includes("Usage:"))).toBe(true);
  });
});

describe("login-mode", () => {
  it("stores password mode", async () => {
    resetPassword(db, "admin", "admin-pass");
    writeSetting(db, "loginMode", "something-else");
    expect(await runCli(["login-mode", "password"], io())).toBe(0);
    expect(readSetting(db, "loginMode")).toBe("password");
    expect(readLoginMode(db)).toBe("password");
    expect(closed).toBe(1);
  });

  it("refuses password mode while the Default user has no password", async () => {
    writeSetting(db, "loginMode", "cloudflare");
    expect(await runCli(["login-mode", "password"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/reset-password admin/);
    expect(readSetting(db, "loginMode")).toBe("cloudflare");
    expect(closed).toBe(1);
  });

  it("rejects other modes and missing arguments", async () => {
    expect(() => setLoginMode(db, "cloudflare")).toThrow(/Unknown login mode/);
    expect(await runCli(["login-mode", "cloudflare"], io())).toBe(1); // flags are required
    expect(await runCli(["login-mode", "bogus"], io())).toBe(1);
    expect(await runCli(["login-mode"], io())).toBe(1);
    expect(readSetting(db, "loginMode")).toBeNull();
  });
});

const TEAM = ["--team-domain", "acme.cloudflareaccess.com", "--aud", "aud-1"];

function setEmailFor(username: string, email: string | null): void {
  db.update(users).set({ email }).where(eq(users.username, username)).run();
}

function readyAdmin(email = "admin@example.com"): void {
  resetPassword(db, "admin", "admin-pass");
  setEmailFor("admin", email);
}

describe("login-mode cloudflare", () => {
  it("is refused while the Default user has no password, and changes nothing", async () => {
    setEmailFor("admin", "admin@example.com");
    expect(await runCli(["login-mode", "cloudflare", ...TEAM], io())).toBe(1);
    expect(err.join("\n")).toMatch(/reset-password admin/);
    expect(err.join("\n")).toMatch(/way back in/);
    expect(readSetting(db, "loginMode")).toBeNull();
    expect(readAccessSettings(db)).toEqual({ teamDomain: null, audTags: [] });
    expect(closed).toBe(1);
  });

  it("is refused while the Default user has no email", async () => {
    resetPassword(db, "admin", "admin-pass");
    expect(await runCli(["login-mode", "cloudflare", ...TEAM], io())).toBe(1);
    expect(err.join("\n")).toMatch(/user email admin/);
    expect(readLoginMode(db)).toBe("password");
  });

  it("rejects a team domain that isn't cloudflareaccess.com", async () => {
    readyAdmin();
    for (const domain of ["evil.example.com", "https://acme.cloudflareaccess.com.evil.com", "   "]) {
      err.length = 0;
      expect(await runCli(["login-mode", "cloudflare", "--team-domain", domain, "--aud", "a"], io())).toBe(1);
      expect(err.join("\n")).toMatch(/team domain/);
    }
    expect(readLoginMode(db)).toBe("password");
    expect(readAccessSettings(db).teamDomain).toBeNull();
  });

  it("needs at least one AUD tag and a team domain", async () => {
    readyAdmin();
    expect(await runCli(["login-mode", "cloudflare", "--team-domain", "acme"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/AUD tag/);
    expect(await runCli(["login-mode", "cloudflare", "--aud", "a"], io())).toBe(1);
    expect(await runCli(["login-mode", "cloudflare", "--team-domain", "acme", "--aud"], io())).toBe(1);
    expect(await runCli(["login-mode", "cloudflare", "--team-domain", "acme", "--aud", "  "], io())).toBe(1);
    expect(readLoginMode(db)).toBe("password");
  });

  it("stores the normalised config, switches the mode, drops every session and names the way back", async () => {
    readyAdmin();
    seedBob();
    const code = await runCli(
      ["login-mode", "cloudflare", "--team-domain", "ACME", "--aud", "aud-1", "--aud=aud-2", "--aud", "aud-1"],
      io(),
    );
    expect(code).toBe(0);
    expect(readLoginMode(db)).toBe("cloudflare");
    expect(readAccessSettings(db)).toEqual({ teamDomain: "https://acme.cloudflareaccess.com", audTags: ["aud-1", "aud-2"] });
    expect(db.select().from(adminSessions).all()).toEqual([]);
    const text = out.join("\n");
    expect(text).toContain("https://acme.cloudflareaccess.com");
    expect(text).toContain("admin@example.com");
    expect(text).toContain("mcp-switchboard login-mode password");
    expect(closed).toBe(1);
  });

  it("keeps sessions when only updating the config of an instance already in Access mode", async () => {
    readyAdmin();
    expect(await runCli(["login-mode", "cloudflare", ...TEAM], io())).toBe(0);
    db.insert(adminSessions).values({ id: "later", userId: defaultUserId(db), createdAt: Date.now() }).run();
    expect(await runCli(["login-mode", "cloudflare", "--team-domain", "other", "--aud", "aud-9"], io())).toBe(0);
    expect(db.select().from(adminSessions).all().map((s) => s.id)).toEqual(["later"]);
    expect(readAccessSettings(db).audTags).toEqual(["aud-9"]);
  });

  it("can be undone with login-mode password", async () => {
    readyAdmin();
    await runCli(["login-mode", "cloudflare", ...TEAM], io());
    expect(await runCli(["login-mode", "password"], io())).toBe(0);
    expect(readLoginMode(db)).toBe("password");
  });
});

describe("user email", () => {
  it("sets, replaces and clears an email", async () => {
    seedBob();
    expect(await runCli(["user", "email", "bob", "  Bob@Example.com "], io())).toBe(0);
    expect(getUserByUsername(db, "bob")!.email).toBe("Bob@Example.com");
    expect(await runCli(["user", "email", "bob", "bob2@example.com"], io())).toBe(0);
    expect(getUserByUsername(db, "bob")!.email).toBe("bob2@example.com");
    expect(await runCli(["user", "email", "bob", "--clear"], io())).toBe(0);
    expect(getUserByUsername(db, "bob")!.email).toBeNull();
    expect(closed).toBe(3);
  });

  it("refuses an email another user has, ignoring case, but lets a user keep their own", async () => {
    seedBob();
    setEmailFor("admin", "shared@example.com");
    expect(await runCli(["user", "email", "bob", "SHARED@example.com"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/already in use/);
    expect(getUserByUsername(db, "bob")!.email).toBeNull();
    expect(await runCli(["user", "email", "admin", "Shared@Example.com"], io())).toBe(0);
  });

  it("explains unknown users and invalid emails", async () => {
    expect(await runCli(["user", "email", "ghost", "a@b.co"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/No user named "ghost"/);
    err.length = 0;
    expect(await runCli(["user", "email", "admin", "not-an-email"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/email address/);
    expect(await runCli(["user", "email", "admin", " "], io())).toBe(1);
    expect(getUserByUsername(db, "admin")!.email).toBeNull();
  });

  it("needs the right arguments", async () => {
    const bad = [["user", "email"], ["user", "email", "bob"], ["user", "email", "bob", "a@b.co", "--clear"], ["user", "email", "bob", "x@y.zz", "extra"], ["user"], ["user", "frob"]];
    for (const args of bad) {
      err.length = 0;
      expect(await runCli(args, io())).toBe(1);
      expect(err[0]).toContain("Usage:");
    }
  });
});

describe("user list and status", () => {
  it("lists one line per user without secrets", async () => {
    seedBob();
    setEmailFor("bob", "bob@example.com");
    expect(await runCli(["user", "list"], io())).toBe(0);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^admin\s+admin\s+-\s+password=no\s+disabled=no\s+default=yes$/);
    expect(out[1]).toMatch(/^bob\s+user\s+bob@example.com\s+password=yes\s+disabled=no\s+default=no$/);
    const bob = getUserByUsername(db, "bob")!;
    for (const secret of [bob.passwordHash!, bob.setupCodeHash!]) expect(out.join("\n")).not.toContain(secret);
  });

  it("emits the documented JSON shape and flags disabled users", async () => {
    const bob = seedBob();
    const row = getUserByUsername(db, "bob")!;
    db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, bob.id)).run();
    expect(await runCli(["user", "list", "--json"], io())).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual([
      { username: "admin", role: "admin", email: null, hasPassword: false, disabled: false, isDefault: true },
      { username: "bob", role: "user", email: null, hasPassword: true, disabled: true, isDefault: false },
    ]);
    expect(out.join("\n")).not.toContain(row.passwordHash!);
    expect(out.join("\n")).not.toContain(row.setupCodeHash!);
  });

  it("reports status as text and JSON", async () => {
    readyAdmin();
    seedBob();
    await runCli(["login-mode", "cloudflare", ...TEAM], io());
    out.length = 0;

    expect(await runCli(["status", "--json"], io())).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({
      version: "9.9.9-test",
      dataDir: tmp,
      loginMode: "cloudflare",
      access: { teamDomain: "https://acme.cloudflareaccess.com", audTags: ["aud-1"] },
      userCount: 2,
      defaultUser: { username: "admin", hasPassword: true, email: "admin@example.com" },
    });

    out.length = 0;
    expect(await runCli(["status"], io())).toBe(0);
    const text = out.join("\n");
    for (const part of ["9.9.9-test", tmp, "cloudflare", "https://acme.cloudflareaccess.com", "aud-1", "admin@example.com"]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain(getUserByUsername(db, "admin")!.passwordHash!);
    expect(await runCli(["status", "extra"], io())).toBe(1);
  });

  it("reports an unconfigured instance", async () => {
    expect(await runCli(["status", "--json"], io())).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({
      loginMode: "password",
      access: { teamDomain: null, audTags: [] },
      userCount: 1,
      defaultUser: { username: "admin", hasPassword: false, email: null },
    });
  });
});

describe("dispatch", () => {
  it("prints usage for --help and exits 0", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      out.length = 0;
      expect(await runCli([flag], io())).toBe(0);
      expect(out).toEqual([USAGE]);
    }
  });

  it("documents every subcommand in --help", () => {
    for (const part of ["status", "user list", "user email", "reset-password", "login-mode password", "login-mode cloudflare", "--team-domain", "--aud"]) {
      expect(USAGE).toContain(part);
    }
  });

  it("prints usage and exits 1 for an unknown subcommand, without touching the database", async () => {
    let opened = false;
    const code = await runCli(["frobnicate"], io({ openDb: () => ((opened = true), db) }));
    expect(code).toBe(1);
    expect(err[0]).toContain('Unknown command "frobnicate"');
    expect(err[0]).toContain("Usage:");
    expect(opened).toBe(false);
  });
});

describe("opening the database", () => {
  it("refuses a 1.x database instead of upgrading it under a running 1.x server", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-cli-1x-"));
    try {
      const old = new Database(path.join(dir, "switchboard.db"));
      old.exec("CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE)");
      old.close();

      expect(() => openCliDb(dir)).toThrow(/from 1\.x and hasn't been upgraded/);

      // Untouched: no backup, no users table, no owner column.
      expect(fs.existsSync(path.join(dir, PRE_MULTIUSER_BACKUP))).toBe(false);
      const check = new Database(path.join(dir, "switchboard.db"), { readonly: true });
      const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      const cols = check.prepare("PRAGMA table_info(servers)").all() as { name: string }[];
      check.close();
      expect(tables.map((t) => t.name)).not.toContain("users");
      expect(cols.map((c) => c.name)).not.toContain("user_id");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still refuses to conjure a database where there is none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-cli-none-"));
    try {
      expect(() => openCliDb(dir)).toThrow(/No switchboard database/);
      expect(fs.existsSync(path.join(dir, "switchboard.db"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
