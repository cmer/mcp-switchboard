import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, initDb, PRE_MULTIUSER_BACKUP, type Db } from "../src/db/index.js";
import { agentOAuthGrants, agents, servers, userSettings } from "../src/db/schema.js";
import { createUser, defaultUserId, getUser } from "../src/core/users.js";
import { encrypt, hashPassword, loadOrCreateKey } from "../src/lib/crypto.js";
import { AdminSessionStore } from "../src/http/adminAuth.js";
import { createApp } from "../src/http/app.js";
import type { AppContext } from "../src/http/context.js";

/** The schema a 1.5.2 install has on disk (`git show v1.5.2:server/src/db/index.ts`). */
const DDL_1_5_2 = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  command TEXT,
  args_json TEXT,
  env_json_enc TEXT,
  cwd TEXT,
  url TEXT,
  auth_type TEXT NOT NULL DEFAULT 'none',
  bearer_token_enc TEXT,
  headers_json_enc TEXT,
  created_by_agent_slug TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'standard',
  tool_mode TEXT NOT NULL DEFAULT 'full',
  created_at INTEGER NOT NULL
);
CREATE TABLE agent_servers (
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, server_id)
);
CREATE TABLE admin_sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE oauth_credentials (
  server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  client_info_enc TEXT,
  tokens_enc TEXT,
  token_expires_at INTEGER,
  token_saved_at INTEGER,
  code_verifier_enc TEXT,
  pending_state TEXT,
  discovery_json TEXT,
  status TEXT NOT NULL DEFAULT 'needs_auth',
  updated_at INTEGER NOT NULL
);
CREATE TABLE request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent_id INTEGER,
  agent_slug TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  server_slug TEXT,
  session_id TEXT,
  rpc_id TEXT,
  method TEXT NOT NULL,
  target TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  duration_ms INTEGER,
  error_code INTEGER,
  error_message TEXT,
  request_json TEXT,
  response_json TEXT,
  request_bytes INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX request_logs_ts ON request_logs(ts DESC);
CREATE TABLE server_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_by_agent_id INTEGER,
  requested_by_agent_slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json_enc TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolution_note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE agent_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT,
  redirect_uris_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  authorized_at INTEGER
);
CREATE TABLE agent_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES agent_oauth_clients(client_id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  grant_id INTEGER
);
CREATE TABLE agent_oauth_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES agent_oauth_clients(client_id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scope TEXT,
  resource TEXT,
  last_response_enc TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE agent_oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES agent_oauth_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE INDEX agent_oauth_tokens_grant ON agent_oauth_tokens(grant_id);
`;

/** Tables whose rows must come through the upgrade untouched (and un-cascaded). */
const KEPT_TABLES = [
  "servers",
  "agents",
  "agent_servers",
  "oauth_credentials",
  "agent_oauth_clients",
  "agent_oauth_codes",
  "agent_oauth_grants",
  "agent_oauth_tokens",
  "server_requests",
  "request_logs",
  "admin_sessions",
];

let tmp: string;
const passwordHash = hashPassword("hunter22");

/** A lived-in 1.5.2 database, written the way 1.x wrote it: WAL, foreign keys on. */
function seed1x(dir: string, extraSettings: Record<string, string> = {}): void {
  const sq = new Database(path.join(dir, "switchboard.db"));
  sq.pragma("journal_mode = WAL");
  sq.pragma("foreign_keys = ON");
  sq.exec(DDL_1_5_2);
  const now = Date.now();
  const setting = sq.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  setting.run("adminPasswordHash", passwordHash);
  setting.run("autoEnableNewServers", "1");
  setting.run("allowServerRequests", "0");
  setting.run("logs.capturePayloads", "0");
  setting.run("instanceName", "Home");
  for (const [key, value] of Object.entries(extraSettings)) setting.run(key, value);

  const server = sq.prepare(
    "INSERT INTO servers (slug, name, type, url, command, auth_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  server.run("github", "GitHub", "http", "https://api.github.com/mcp", null, "oauth", now, now);
  server.run("fs", "Files", "stdio", null, "npx", "none", now, now);
  server.run("gone", "Gone", "http", "https://gone.test/mcp", null, "none", now, now);
  // Deleting the top row leaves sqlite_sequence above max(id): id 3 must never be handed out again.
  sq.prepare("DELETE FROM servers WHERE slug = 'gone'").run();

  const agent = sq.prepare("INSERT INTO agents (slug, name, token_enc, role, created_at) VALUES (?, ?, ?, ?, ?)");
  agent.run("claude", "Claude", encrypt("claude-token"), "manager", now);
  agent.run("codex", "Codex", encrypt("codex-token"), "standard", now);

  const matrix = sq.prepare("INSERT INTO agent_servers (agent_id, server_id, enabled) VALUES (?, ?, ?)");
  matrix.run(1, 1, 1);
  matrix.run(1, 2, 0);
  matrix.run(2, 1, 1);

  sq.prepare("INSERT INTO oauth_credentials (server_id, tokens_enc, status, updated_at) VALUES (1, ?, 'ok', ?)").run(
    encrypt("{}"),
    now,
  );
  sq.prepare(
    "INSERT INTO agent_oauth_clients (client_id, redirect_uris_json, token_endpoint_auth_method, created_at, authorized_at) VALUES ('client-1', '[]', 'none', ?, ?)",
  ).run(now, now);
  sq.prepare(
    "INSERT INTO agent_oauth_codes (code_hash, client_id, agent_id, redirect_uri, code_challenge, expires_at) VALUES ('code-1', 'client-1', 2, 'https://x/cb', 'ch', ?)",
  ).run(now + 60_000);
  sq.prepare(
    "INSERT INTO agent_oauth_grants (client_id, agent_id, resource, created_at) VALUES ('client-1', 2, 'http://localhost:8787/mcp/codex', ?)",
  ).run(now);
  sq.prepare(
    "INSERT INTO agent_oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ('at-1', 1, 'access', ?), ('rt-1', 1, 'refresh', ?)",
  ).run(now + 3_600_000, now + 86_400_000);

  sq.prepare(
    "INSERT INTO server_requests (requested_by_agent_id, requested_by_agent_slug, kind, reason, created_at) VALUES (2, 'codex', 'freeform', 'need linear', ?)",
  ).run(now);
  const log = sq.prepare(
    "INSERT INTO request_logs (ts, agent_id, agent_slug, agent_name, server_slug, method, status) VALUES (?, 1, 'claude', 'Claude', ?, ?, 'ok')",
  );
  log.run(now, "github", "tools/call");
  log.run(now, null, "tools/list");
  log.run(now, "gone", "tools/call");
  sq.prepare("INSERT INTO admin_sessions (id, created_at) VALUES ('sess-1', ?)").run(now);
  sq.close();
}

function snapshot(dir: string): Record<string, unknown[]> {
  const sq = new Database(path.join(dir, "switchboard.db"), { readonly: true });
  const out: Record<string, unknown[]> = {};
  for (const t of KEPT_TABLES) out[t] = sq.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  sq.close();
  return out;
}

function sqlite(db: Db): Database.Database {
  return db.$client;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-multiuser-"));
  loadOrCreateKey(tmp);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("1.x → multi-user migration", () => {
  it("backs up first, then hands every row to the Default user without cascading anything away", () => {
    seed1x(tmp);
    const before = snapshot(tmp);
    const db = initDb(tmp);
    const sq = sqlite(db);

    // The backup is a complete, openable 1.x database.
    const backup = new Database(path.join(tmp, PRE_MULTIUSER_BACKUP), { readonly: true });
    expect(backup.prepare("SELECT count(*) AS n FROM servers").get()).toEqual({ n: 2 });
    expect(backup.prepare("SELECT 1 FROM sqlite_master WHERE name = 'users'").get()).toBeUndefined();
    backup.close();

    // Same rows, same ids, in every table — the user_id columns are the only additions.
    const after = snapshot(tmp);
    for (const t of KEPT_TABLES) {
      expect(after[t].length, t).toBe(before[t].length);
      after[t].forEach((row, i) => expect(row, t).toMatchObject(before[t][i] as object));
    }

    const uid = defaultUserId(db);
    const admin = getUser(db, uid)!;
    expect(admin).toMatchObject({ username: "admin", role: "admin", canRunLocalCommands: true, disabledAt: null });
    expect(admin.passwordHash).toBe(passwordHash);
    for (const t of ["servers", "agents", "server_requests", "request_logs", "admin_sessions"]) {
      expect(sq.prepare(`SELECT DISTINCT user_id FROM ${t}`).all(), t).toEqual([{ user_id: uid }]);
    }
    expect(sq.prepare("SELECT server_slug, server_id FROM request_logs ORDER BY id").all()).toEqual([
      { server_slug: "github", server_id: 1 },
      { server_slug: null, server_id: null },
      { server_slug: "gone", server_id: null },
    ]);
    expect(sq.prepare("SELECT escalated FROM server_requests").get()).toEqual({ escalated: 0 });

    // Per-user settings carried over; the global keys stay until their readers move.
    const copied = db.select().from(userSettings).where(eq(userSettings.userId, uid)).all();
    expect(Object.fromEntries(copied.map((s) => [s.key, s.value]))).toEqual({
      autoEnableNewServers: "1",
      allowServerRequests: "0",
      "logs.capturePayloads": "0",
    });
    expect(sq.prepare("SELECT value FROM settings WHERE key = 'adminPasswordHash'").get()).toEqual({
      value: passwordHash,
    });

    // AUTOINCREMENT high-water mark kept: the deleted server's id 3 isn't reused.
    const next = db
      .insert(servers)
      .values({ userId: uid, slug: "new", name: "New", type: "http", url: "https://n", createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    expect(next.id).toBe(4);

    // Foreign keys are back on and still point at the rebuilt tables.
    expect(sq.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sq.pragma("foreign_key_check")).toEqual([]);
    db.delete(agents).where(eq(agents.id, 2)).run();
    expect(db.select().from(agentOAuthGrants).all()).toEqual([]);
    expect(sq.prepare("SELECT count(*) AS n FROM agent_oauth_tokens").get()).toEqual({ n: 0 });
  });

  it("lets two users own the same server and agent slugs, but not one user twice", () => {
    seed1x(tmp);
    const db = initDb(tmp);
    const bob = createUser(db, { username: "bob" });
    const server = (userId: number) =>
      db
        .insert(servers)
        .values({ userId, slug: "github", name: "GitHub", type: "http", url: "https://g", createdAt: 1, updatedAt: 1 })
        .run();
    const agent = (userId: number) =>
      db.insert(agents).values({ userId, slug: "claude", name: "Claude", tokenEnc: "x", createdAt: 1 }).run();

    expect(() => server(bob.id)).not.toThrow();
    expect(() => agent(bob.id)).not.toThrow();
    expect(() => server(bob.id)).toThrow(/UNIQUE/);
    expect(() => agent(bob.id)).toThrow(/UNIQUE/);
    expect(() => server(defaultUserId(db))).toThrow(/UNIQUE/);
  });

  it("is a no-op the second time", () => {
    seed1x(tmp);
    initDb(tmp);
    closeDb();
    const backupStat = fs.statSync(path.join(tmp, PRE_MULTIUSER_BACKUP));
    const schema = () => {
      const sq = new Database(path.join(tmp, "switchboard.db"), { readonly: true });
      const rows = sq.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
      const users = sq.prepare("SELECT * FROM users").all();
      const settings = sq.prepare("SELECT * FROM user_settings").all();
      sq.close();
      return { rows, users, settings };
    };
    const first = { ...schema(), data: snapshot(tmp) };

    initDb(tmp);
    closeDb();
    expect({ ...schema(), data: snapshot(tmp) }).toEqual(first);
    expect(fs.statSync(path.join(tmp, PRE_MULTIUSER_BACKUP)).mtimeMs).toBe(backupStat.mtimeMs);
  });

  it("never overwrites an existing backup", () => {
    seed1x(tmp);
    fs.writeFileSync(path.join(tmp, PRE_MULTIUSER_BACKUP), "earlier attempt");
    initDb(tmp);
    expect(fs.readFileSync(path.join(tmp, PRE_MULTIUSER_BACKUP), "utf8")).toBe("earlier attempt");
  });

  it("gives a fresh install a passwordless Default user and no backup", () => {
    const db = initDb(tmp);
    expect(fs.existsSync(path.join(tmp, PRE_MULTIUSER_BACKUP))).toBe(false);
    expect(getUser(db, defaultUserId(db))).toMatchObject({
      username: "admin",
      role: "admin",
      canRunLocalCommands: true,
      passwordHash: null,
    });
    expect(sqlite(db).prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  describe("sign-in turned off in 1.x", () => {
    const settingRow = (db: Db) => sqlite(db).prepare("SELECT value FROM settings WHERE key = 'authDisabled'").get();

    it("drops the setting, says how to get back in, and requires sign-in", async () => {
      seed1x(tmp, { authDisabled: "1" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const db = initDb(tmp);

      expect(settingRow(db)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(
        'Sign-in was turned off in 1.x; it is now always on. Sign in as "admin" with your old password, ' +
          "or set a new one: mcp-switchboard reset-password admin",
      );
      warn.mockRestore();
      expect(getUser(db, defaultUserId(db))!.passwordHash).toBe(passwordHash);

      const app = createApp(
        { db, adminSessions: new AdminSessionStore(db) } as unknown as AppContext,
        path.join(tmp, "no-web"),
        { serveMcp: false },
      );
      const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect((await app.request("/api/servers")).status).toBe(401);
      expect((await (await app.request("/api/auth/me")).json())).toMatchObject({ authenticated: false, needsSetup: false });
      expect((await app.request("/api/auth/login", json({ username: "admin", password: "wrong" }))).status).toBe(401);
      expect((await app.request("/api/auth/login", json({ username: "admin", password: "hunter22" }))).status).toBe(200);
    });

    it("stays quiet when sign-in was left on (authDisabled = 0)", () => {
      seed1x(tmp, { authDisabled: "0" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const db = initDb(tmp);
      expect(settingRow(db)).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("deletes a leftover key on an already-migrated database without a message", () => {
      sqlite(initDb(tmp)).prepare("INSERT INTO settings (key, value) VALUES ('authDisabled', '1')").run();
      closeDb();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const db = initDb(tmp);
      expect(settingRow(db)).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
