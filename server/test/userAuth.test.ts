import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { adminSessions, agentServers, agents, servers, settings as settingsTable, userSettings, users } from "../src/db/schema.js";
import { defaultUserId, getUserByUsername } from "../src/core/users.js";
import { encrypt, loadOrCreateKey } from "../src/lib/crypto.js";
import { writeSetting } from "../src/lib/settings.js";
import { AdminSessionStore } from "../src/http/adminAuth.js";
import { createApp } from "../src/http/app.js";
import type { AppContext } from "../src/http/context.js";

let tmp: string;
let db: Db;
let app: Hono;
let sessions: AdminSessionStore;
let hub: { dropAgentSessions: ReturnType<typeof vi.fn>; notifyAgent: ReturnType<typeof vi.fn> };
let refresher: { cancel: ReturnType<typeof vi.fn> };
let manager: { reconcile: ReturnType<typeof vi.fn> };

interface Reply {
  status: number;
  body: any;
  cookie?: string;
}

/** Cookie-aware JSON call into the app; `cookie` is the `sb_session=…` pair as a browser would send it. */
async function call(method: string, url: string, body?: unknown, cookie?: string): Promise<Reply> {
  const res = await app.request(url, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    cookie: set?.match(/sb_session=[^;]+/)?.[0],
  };
}

/** First-run setup: the Default user picks a password and comes back signed in. */
async function setUpAdmin(password = "admin-pass"): Promise<string> {
  const res = await call("POST", "/api/auth/setup", { password });
  expect(res.status).toBe(200);
  return res.cookie!;
}

/** Admin creates `username`; the new user redeems the setup code and is signed in. */
async function addUser(admin: string, username: string, password = "user-pass") {
  const created = await call("POST", "/api/users", { username }, admin);
  expect(created.status).toBe(201);
  const redeemed = await call("POST", "/api/auth/setup-code", {
    username,
    code: created.body.setupCode.code,
    password,
  });
  expect(redeemed.status).toBe(200);
  return { id: created.body.user.id as number, cookie: redeemed.cookie!, password };
}

/** The stored text, so "never written" (null) and "written off" ("0") stay distinguishable. */
function rawUserSetting(userId: number, key: string): string | null {
  return (
    db
      .select()
      .from(userSettings)
      .where(and(eq(userSettings.userId, userId), eq(userSettings.key, key)))
      .get()?.value ?? null
  );
}

function addServer(userId: number, slug: string) {
  return db
    .insert(servers)
    .values({ userId, slug, name: `Secret ${slug}`, type: "stdio", command: "secret-cmd", createdAt: 1, updatedAt: 1 })
    .returning()
    .get();
}

function addAgent(userId: number, slug: string) {
  return db
    .insert(agents)
    .values({ userId, slug, name: `Agent ${slug}`, tokenEnc: encrypt("tok"), createdAt: 1 })
    .returning()
    .get();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-userauth-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  sessions = new AdminSessionStore(db);
  hub = { dropAgentSessions: vi.fn(async () => {}), notifyAgent: vi.fn() };
  refresher = { cancel: vi.fn() };
  manager = { reconcile: vi.fn(async () => {}) };
  app = createApp(
    { db, hub, refresher, manager, adminSessions: sessions } as unknown as AppContext,
    path.join(tmp, "no-web"),
    { serveMcp: false },
  );
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("login by username", () => {
  it("runs first-run setup on the Default user, then logs in with username + password", async () => {
    const before = await call("GET", "/api/auth/me");
    expect(before.body).toMatchObject({ needsSetup: true, authenticated: false, user: null, loginMode: "password" });

    const cookie = await setUpAdmin();
    expect(getUserByUsername(db, "admin")!.passwordHash).not.toBeNull();
    const me = await call("GET", "/api/auth/me", undefined, cookie);
    expect(me.body).toMatchObject({
      needsSetup: false,
      authenticated: true,
      user: { username: "admin", role: "admin", email: null, canRunLocalCommands: true, isDefault: true },
    });
    expect((await call("POST", "/api/auth/setup", { password: "other-pass" })).status).toBe(409);

    await call("POST", "/api/auth/logout", undefined, cookie);
    expect((await call("GET", "/api/servers", undefined, cookie)).status).toBe(401);

    const login = await call("POST", "/api/auth/login", { username: "Admin", password: "admin-pass" });
    expect(login.status).toBe(200);
    expect((await call("GET", "/api/servers", undefined, login.cookie)).status).toBe(200);
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "nope" })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { username: "nobody", password: "admin-pass" })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { password: "admin-pass" })).status).toBe(400);
  });

  it("ignores the retired adminPasswordHash setting", async () => {
    writeSetting(db, "adminPasswordHash", "stale");
    expect((await call("GET", "/api/auth/me")).body.needsSetup).toBe(true);
  });

  it("puts the signed-in user on the request context", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    // /api/users is Admin-only: the 200 vs 403 proves the middleware resolved a different user each time.
    expect((await call("GET", "/api/users", undefined, admin)).status).toBe(200);
    expect((await call("GET", "/api/users", undefined, bob.cookie)).status).toBe(403);
    expect((await call("GET", "/api/users")).status).toBe(401);
  });

  it("changes your own password and signs your other browsers out", async () => {
    const admin = await setUpAdmin();
    const other = (await call("POST", "/api/auth/login", { username: "admin", password: "admin-pass" })).cookie!;
    expect((await call("POST", "/api/auth/change-password", { currentPassword: "x", newPassword: "newer" }, admin)).status).toBe(401);
    const res = await call("POST", "/api/auth/change-password", { currentPassword: "admin-pass", newPassword: "newer" }, admin);
    expect(res.status).toBe(200);
    expect((await call("GET", "/api/servers", undefined, other)).status).toBe(401);
    expect((await call("GET", "/api/servers", undefined, res.cookie)).status).toBe(200);
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "newer" })).status).toBe(200);
  });
});

describe("disabled users", () => {
  it("cannot log in, and their sessions are dropped", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    expect((await call("GET", "/api/servers", undefined, bob.cookie)).status).toBe(200);

    const res = await call("POST", `/api/users/${bob.id}/disable`, undefined, admin);
    expect(res.status).toBe(200);
    expect(res.body.user.disabled).toBe(true);
    expect(db.select().from(adminSessions).where(eq(adminSessions.userId, bob.id)).all()).toEqual([]);
    expect((await call("GET", "/api/servers", undefined, bob.cookie)).status).toBe(401);
    const login = await call("POST", "/api/auth/login", { username: "bob", password: bob.password });
    expect(login.status).toBe(403);
    expect(login.cookie).toBeUndefined();

    await call("POST", `/api/users/${bob.id}/enable`, undefined, admin);
    expect((await call("POST", "/api/auth/login", { username: "bob", password: bob.password })).status).toBe(200);
  });

  it("is refused at the session lookup even if the row was disabled behind the app's back", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    db.update(users).set({ disabledAt: Date.now() }).where(eq(users.id, bob.id)).run();
    expect((await call("GET", "/api/servers", undefined, bob.cookie)).status).toBe(401);
    expect(db.select().from(adminSessions).where(eq(adminSessions.userId, bob.id)).all()).toEqual([]);
  });

  it("drops their agents' live MCP sessions and reconciles their servers away", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    const a1 = addAgent(bob.id, "claude");
    const a2 = addAgent(bob.id, "codex");
    const mine = addAgent(defaultUserId(db), "mine");

    await call("POST", `/api/users/${bob.id}/disable`, undefined, admin);
    expect(hub.dropAgentSessions.mock.calls.map((c) => c[0]).sort()).toEqual([a1.id, a2.id].sort());
    expect(hub.dropAgentSessions).not.toHaveBeenCalledWith(mine.id);
    expect(manager.reconcile).toHaveBeenCalled();
  });
});

describe("setup codes", () => {
  it("creates a user, redeems once, and signs them in", async () => {
    const admin = await setUpAdmin();
    const created = await call("POST", "/api/users", { username: "bob", email: "Bob@Example.com" }, admin);
    expect(created.status).toBe(201);
    const { code, expiresAt } = created.body.setupCode;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(expiresAt - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    expect(created.body.user).toMatchObject({ username: "bob", role: "user", setupCodePending: true, hasPassword: false });

    // The plain code is never stored.
    const row = getUserByUsername(db, "bob")!;
    expect(row.setupCodeHash).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(code);
    // Before redeeming there is no password to log in with.
    expect((await call("POST", "/api/auth/login", { username: "bob", password: "whatever" })).status).toBe(401);

    // Case, spaces and dashes don't matter. A too-short password doesn't spend the code.
    const typed = code.toLowerCase().replace("-", " ");
    expect((await call("POST", "/api/auth/setup-code", { username: "bob", code: typed, password: "abc" })).status).toBe(400);
    const ok = await call("POST", "/api/auth/setup-code", { username: "bob", code: typed, password: "bobs-pass" });
    expect(ok.status).toBe(200);
    const me = await call("GET", "/api/auth/me", undefined, ok.cookie);
    expect(me.body.user).toMatchObject({ username: "bob", role: "user", email: "Bob@Example.com", isDefault: false });
    expect(getUserByUsername(db, "bob")).toMatchObject({ setupCodeHash: null, setupCodeExpiresAt: null });

    // Single use, and the chosen password works.
    expect((await call("POST", "/api/auth/setup-code", { username: "bob", code, password: "again-pass" })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { username: "bob", password: "bobs-pass" })).status).toBe(200);
  });

  it("rejects an expired code", async () => {
    const admin = await setUpAdmin();
    const created = await call("POST", "/api/users", { username: "bob" }, admin);
    db.update(users).set({ setupCodeExpiresAt: Date.now() - 1 }).where(eq(users.username, "bob")).run();
    const res = await call("POST", "/api/auth/setup-code", { username: "bob", code: created.body.setupCode.code, password: "bobs-pass" });
    expect(res.status).toBe(401);
    expect(getUserByUsername(db, "bob")!.passwordHash).toBeNull();
  });

  it("only works for the user it was issued to", async () => {
    const admin = await setUpAdmin();
    const bob = await call("POST", "/api/users", { username: "bob" }, admin);
    await call("POST", "/api/users", { username: "eve" }, admin);
    const res = await call("POST", "/api/auth/setup-code", { username: "eve", code: bob.body.setupCode.code, password: "evil-pass" });
    expect(res.status).toBe(401);
  });

  it("burns every outstanding code after ten wrong guesses", async () => {
    const admin = await setUpAdmin();
    const bob = await call("POST", "/api/users", { username: "bob" }, admin);
    const eve = await call("POST", "/api/users", { username: "eve" }, admin);
    for (let i = 0; i < 9; i++) {
      await call("POST", "/api/auth/setup-code", { username: "bob", code: "AAAA-AAAA", password: "guess-pass" });
    }
    // Still alive after nine misses…
    const alive = await call("POST", "/api/auth/setup-code", { username: "eve", code: eve.body.setupCode.code, password: "eves-pass" });
    expect(alive.status).toBe(200);

    // …but the tenth miss takes the rest with it.
    await call("POST", "/api/auth/setup-code", { username: "bob", code: "AAAA-AAAA", password: "guess-pass" });
    const burnt = await call("POST", "/api/auth/setup-code", { username: "bob", code: bob.body.setupCode.code, password: "bobs-pass" });
    expect(burnt.status).toBe(401);
    expect(getUserByUsername(db, "bob")!.setupCodeHash).toBeNull();
  });

  it("is refused for a disabled user", async () => {
    const admin = await setUpAdmin();
    const bob = await call("POST", "/api/users", { username: "bob" }, admin);
    await call("POST", `/api/users/${bob.body.user.id}/disable`, undefined, admin);
    const res = await call("POST", "/api/auth/setup-code", { username: "bob", code: bob.body.setupCode.code, password: "bobs-pass" });
    expect(res.status).toBe(401);
  });

  it("reset clears the old password and sessions, and a fresh code sets a new one", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");

    const reset = await call("POST", `/api/users/${bob.id}/reset-password`, undefined, admin);
    expect(reset.status).toBe(200);
    expect(getUserByUsername(db, "bob")!.passwordHash).toBeNull();
    expect((await call("GET", "/api/servers", undefined, bob.cookie)).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { username: "bob", password: bob.password })).status).toBe(401);

    const redeemed = await call("POST", "/api/auth/setup-code", {
      username: "bob",
      code: reset.body.setupCode.code,
      password: "second-pass",
    });
    expect(redeemed.status).toBe(200);
    expect((await call("POST", "/api/auth/login", { username: "bob", password: "second-pass" })).status).toBe(200);
  });

  it("a second reset voids the first code", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    const first = await call("POST", `/api/users/${bob.id}/reset-password`, undefined, admin);
    await call("POST", `/api/users/${bob.id}/reset-password`, undefined, admin);
    const res = await call("POST", "/api/auth/setup-code", { username: "bob", code: first.body.setupCode.code, password: "late-pass" });
    expect(res.status).toBe(401);
  });
});

describe("users REST", () => {
  it("is Admin-only", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    const eve = await addUser(admin, "eve");
    const attempts: [string, string, unknown?][] = [
      ["GET", "/api/users"],
      ["POST", "/api/users", { username: "mallory" }],
      ["PATCH", `/api/users/${eve.id}`, { canRunLocalCommands: true }],
      ["POST", `/api/users/${eve.id}/disable`],
      ["POST", `/api/users/${eve.id}/enable`],
      ["POST", `/api/users/${eve.id}/reset-password`],
      ["DELETE", `/api/users/${eve.id}`],
    ];
    for (const [method, url, body] of attempts) {
      expect((await call(method, url, body, bob.cookie)).status, `${method} ${url}`).toBe(403);
    }
    expect(getUserByUsername(db, "mallory")).toBeUndefined();
    expect(getUserByUsername(db, "eve")).toMatchObject({ canRunLocalCommands: false, disabledAt: null });
  });

  it("lists names and counts but never another user's servers or agents", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    addServer(bob.id, "bobs-db");
    addServer(bob.id, "bobs-git");
    addAgent(bob.id, "bobs-claude");
    addServer(defaultUserId(db), "mine");

    const res = await call("GET", "/api/users", undefined, admin);
    expect(res.status).toBe(200);
    const row = res.body.find((u: any) => u.username === "bob");
    expect(row).toMatchObject({ serverCount: 2, agentCount: 1, disabled: false, isDefault: false, role: "user" });
    expect(res.body.find((u: any) => u.username === "admin")).toMatchObject({ isDefault: true, role: "admin", serverCount: 1 });
    const text = JSON.stringify(res.body);
    for (const leak of ["bobs-db", "bobs-git", "bobs-claude", "Secret", "secret-cmd", "passwordHash", "setupCodeHash"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("validates usernames and keeps usernames and emails unique", async () => {
    const admin = await setUpAdmin();
    for (const bad of ["Bob", "bob_x", "with space", "a".repeat(65)]) {
      expect((await call("POST", "/api/users", { username: bad }, admin)).status, bad).toBe(400);
    }
    expect((await call("POST", "/api/users", { username: "bob", email: "b@x.io" }, admin)).status).toBe(201);
    expect((await call("POST", "/api/users", { username: "bob" }, admin)).status).toBe(409);
    expect((await call("POST", "/api/users", { username: "eve", email: "B@X.io" }, admin)).status).toBe(409);
    expect(getUserByUsername(db, "eve")).toBeUndefined();
  });

  it("renames, sets email and the local-command flag, and names the agents whose URLs break", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    addAgent(bob.id, "claude");
    addAgent(bob.id, "codex");

    const res = await call("PATCH", `/api/users/${bob.id}`, { username: "robert", email: "r@x.io", canRunLocalCommands: true }, admin);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: "robert", email: "r@x.io", canRunLocalCommands: true });
    expect(res.body.brokenAgentSlugs.sort()).toEqual(["claude", "codex"]);

    // Not a rename: nothing breaks.
    const noRename = await call("PATCH", `/api/users/${bob.id}`, { email: null }, admin);
    expect(noRename.body.brokenAgentSlugs).toEqual([]);
    expect(noRename.body.user.email).toBeNull();

    // A clash leaves the other fields untouched.
    await call("POST", "/api/users", { username: "eve", email: "e@x.io" }, admin);
    const clash = await call("PATCH", `/api/users/${bob.id}`, { canRunLocalCommands: false, email: "E@x.io" }, admin);
    expect(clash.status).toBe(409);
    expect(getUserByUsername(db, "robert")!.canRunLocalCommands).toBe(true);
    expect((await call("PATCH", `/api/users/${bob.id}`, { username: "eve" }, admin)).status).toBe(409);
    expect((await call("PATCH", "/api/users/999", { email: null }, admin)).status).toBe(404);
  });

  it("has no way to grant the Admin role", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    expect((await call("PATCH", `/api/users/${bob.id}`, { role: "admin" }, admin)).status).toBe(400);
    expect(getUserByUsername(db, "bob")!.role).toBe("user");
    for (const url of ["promote", "role", "make-admin"]) {
      expect((await call("POST", `/api/users/${bob.id}/${url}`, { role: "admin" }, admin)).status).toBe(404);
    }
  });

  it("protects the Default user", async () => {
    const admin = await setUpAdmin();
    const id = defaultUserId(db);
    expect((await call("POST", `/api/users/${id}/disable`, undefined, admin)).status).toBe(400);
    expect((await call("DELETE", `/api/users/${id}`, undefined, admin)).status).toBe(400);
    expect((await call("POST", `/api/users/${id}/reset-password`, undefined, admin)).status).toBe(400);
    expect((await call("PATCH", `/api/users/${id}`, { role: "user" }, admin)).status).toBe(400);
    expect(getUserByUsername(db, "admin")).toMatchObject({ role: "admin", disabledAt: null });
    expect(getUserByUsername(db, "admin")!.passwordHash).not.toBeNull();
    // The session survived all of that.
    expect((await call("GET", "/api/users", undefined, admin)).status).toBe(200);
  });

  it("deletes a user with their data, cancels refresh timers, drops sessions and tells other users' agents", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    const bobServer = addServer(bob.id, "bobs-db");
    const bobAgent = addAgent(bob.id, "claude");
    const adminAgent = addAgent(defaultUserId(db), "mine");
    db.insert(agentServers).values({ agentId: bobAgent.id, serverId: bobServer.id, enabled: true }).run();
    db.insert(agentServers).values({ agentId: adminAgent.id, serverId: bobServer.id, enabled: true }).run();

    const res = await call("DELETE", `/api/users/${bob.id}`, undefined, admin);
    expect(res.status).toBe(200);
    expect(getUserByUsername(db, "bob")).toBeUndefined();
    expect(db.select().from(servers).where(eq(servers.id, bobServer.id)).all()).toEqual([]);
    expect(db.select().from(agents).where(eq(agents.id, bobAgent.id)).all()).toEqual([]);
    expect(db.select().from(agentServers).all()).toEqual([]);
    expect(db.select().from(adminSessions).where(eq(adminSessions.userId, bob.id)).all()).toEqual([]);
    expect(refresher.cancel).toHaveBeenCalledWith(bobServer.id);
    expect(hub.dropAgentSessions).toHaveBeenCalledWith(bobAgent.id);
    expect(manager.reconcile).toHaveBeenCalled();
    expect(hub.notifyAgent).toHaveBeenCalledWith(adminAgent.id);
    expect(hub.notifyAgent).not.toHaveBeenCalledWith(bobAgent.id);
    expect((await call("DELETE", `/api/users/${bob.id}`, undefined, admin)).status).toBe(404);
  });
});

describe("authDisabled (removed in 2.0)", () => {
  it("is not a setting any more: the key is ignored and sign-in stays required", async () => {
    // authSettingsSchema is not strict, so unknown keys are stripped, not rejected.
    const admin = await setUpAdmin();
    const res = await call("POST", "/api/auth/settings", { authDisabled: true }, admin);
    expect(res.status).toBe(200);
    expect(db.select().from(settingsTable).where(eq(settingsTable.key, "authDisabled")).all()).toEqual([]);

    const anonymous = await call("GET", "/api/auth/me");
    expect(anonymous.body).toMatchObject({ authenticated: false, user: null });
    expect(anonymous.body).not.toHaveProperty("authDisabled");
    expect((await call("GET", "/api/users")).status).toBe(401);
  });

  it("does not let a leftover row act as the Default user, or block adding users", async () => {
    const admin = await setUpAdmin();
    writeSetting(db, "authDisabled", "1");
    expect((await call("GET", "/api/users")).status).toBe(401);
    expect((await call("POST", "/api/users", { username: "bob" })).status).toBe(401);
    expect((await call("POST", "/api/users", { username: "bob" }, admin)).status).toBe(201);
  });
});

describe("settings", () => {
  it("keeps per-user settings separate", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");

    await call("POST", "/api/auth/settings", { autoEnableNewServers: true, allowServerRequests: false, capturePayloads: false }, admin);
    const adminMe = (await call("GET", "/api/auth/me", undefined, admin)).body;
    const bobMe = (await call("GET", "/api/auth/me", undefined, bob.cookie)).body;
    expect(adminMe).toMatchObject({ autoEnableNewServers: true, allowServerRequests: false, capturePayloads: false });
    expect(bobMe).toMatchObject({ autoEnableNewServers: false, allowServerRequests: true, capturePayloads: true });
    expect(rawUserSetting(bob.id, "autoEnableNewServers")).toBeNull();

    await call("POST", "/api/auth/settings", { autoEnableNewServers: true }, bob.cookie);
    await call("POST", "/api/auth/settings", { autoEnableNewServers: false }, admin);
    expect(rawUserSetting(bob.id, "autoEnableNewServers")).toBe("1");
    expect(rawUserSetting(defaultUserId(db), "autoEnableNewServers")).toBe("0");
  });

  it("keeps instance settings to the Admin", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    for (const body of [{ instanceName: "Bob's" }, { loginMode: "password" }]) {
      expect((await call("POST", "/api/auth/settings", body, bob.cookie)).status, JSON.stringify(body)).toBe(403);
    }
    expect((await call("POST", "/api/auth/settings", { instanceName: "Home", loginMode: "password" }, admin)).status).toBe(200);
    expect((await call("GET", "/api/auth/me", undefined, bob.cookie)).body).toMatchObject({ instanceName: "Home", loginMode: "password" });
    expect((await call("POST", "/api/auth/settings", { loginMode: "cloudflare" }, admin)).status).toBe(400);
  });

  it("scopes payload capture per user, and log retention to the Admin", async () => {
    const admin = await setUpAdmin();
    const bob = await addUser(admin, "bob");
    const logger = { config: { retentionHours: 48, maxPayloadKb: 32 }, capturePayloads: () => true, reloadConfig: vi.fn(), prune: vi.fn() };
    const withLogs = createApp(
      { db, hub, refresher, manager, logger, adminSessions: sessions } as unknown as AppContext,
      path.join(tmp, "no-web"),
      { serveMcp: false },
    );
    const put = (cookie: string, body: unknown) =>
      withLogs.request("/api/logs/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(body),
      });
    expect((await put(bob.cookie, { retentionHours: 1 })).status).toBe(403);
    expect((await put(bob.cookie, { maxPayloadKb: 1 })).status).toBe(403);
    expect((await put(bob.cookie, { capturePayloads: false })).status).toBe(200);
    expect(rawUserSetting(bob.id, "logs.capturePayloads")).toBe("0");
    expect(rawUserSetting(defaultUserId(db), "logs.capturePayloads")).toBeNull();
    expect((await put(admin, { retentionHours: 1 })).status).toBe(200);
  });
});
