import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let db: Db | null = null;
let sqlite: Database.Database | null = null;

/**
 * Tables that gained an owner in 2.0 and had to be rebuilt (not ALTERed) on upgrade: servers and
 * agents trade their global UNIQUE(slug) for UNIQUE(user_id, slug), and the others get a
 * NOT NULL user_id, which ALTER TABLE ADD COLUMN can't add. Parameterised by name so the
 * upgrade builds the new shape beside the old table from the same text a fresh install uses.
 */
const OWNED_TABLES = {
  servers: (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
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
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, slug)
);`,
  agents: (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'standard',
  tool_mode TEXT NOT NULL DEFAULT 'full',
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, slug)
);`,
  admin_sessions: (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);`,
  server_requests: (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_by_agent_id INTEGER,
  requested_by_agent_slug TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  escalated INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  payload_json_enc TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolution_note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);`,
} satisfies Record<string, (name: string) => string>;

type OwnedTable = keyof typeof OWNED_TABLES;

const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  can_run_local_commands INTEGER NOT NULL DEFAULT 0,
  setup_code_hash TEXT,
  setup_code_expires_at INTEGER,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users(lower(email));
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
${Object.entries(OWNED_TABLES)
  .map(([name, create]) => create(name))
  .join("\n")}
CREATE TABLE IF NOT EXISTS agent_servers (
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, server_id)
);
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  recipient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias TEXT,
  status TEXT NOT NULL DEFAULT 'offered',
  enabled INTEGER NOT NULL DEFAULT 1,
  call_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (server_id, recipient_user_id)
);
CREATE INDEX IF NOT EXISTS shares_recipient ON shares(recipient_user_id);
CREATE TABLE IF NOT EXISTS oauth_credentials (
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
CREATE TABLE IF NOT EXISTS request_logs (
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
  truncated INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  server_id INTEGER
);
CREATE INDEX IF NOT EXISTS request_logs_ts ON request_logs(ts DESC);
CREATE TABLE IF NOT EXISTS agent_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT,
  redirect_uris_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  authorized_at INTEGER
);
CREATE TABLE IF NOT EXISTS agent_oauth_codes (
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
CREATE TABLE IF NOT EXISTS agent_oauth_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES agent_oauth_clients(client_id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scope TEXT,
  resource TEXT,
  last_response_enc TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS agent_oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES agent_oauth_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_oauth_tokens_grant ON agent_oauth_tokens(grant_id);
`;

/** Indexes on columns a 1.x database only has once `migrateToMultiUser` has run. */
const POST_MIGRATION_DDL = `
CREATE INDEX IF NOT EXISTS request_logs_user_ts ON request_logs(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS server_requests_user ON server_requests(user_id);
CREATE INDEX IF NOT EXISTS admin_sessions_user ON admin_sessions(user_id);
`;

/** The settings key holding the Default user's id: by identity, so it survives a rename. */
export const DEFAULT_USER_SETTING = "defaultUserId";

/** Global settings that became per-user in 2.0; copied onto the Default user on upgrade. */
const PER_USER_SETTING_KEYS = [
  "autoEnableNewServers",
  "allowServerRequests",
  // USER_SETTING_KEYS.capturePayloads in lib/settings.ts
  "logs.capturePayloads",
];

export const PRE_MULTIUSER_BACKUP = "switchboard.db.pre-multiuser";

export function initDb(dataDir: string): Db {
  const file = path.join(dataDir, "switchboard.db");
  sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const upgrading = isPreMultiUser(sqlite);
  // The upgrade is one-way: snapshot before touching the schema. An existing backup is from an
  // earlier attempt that rolled back, so it is the true 1.x state and must not be overwritten.
  const backup = path.join(dataDir, PRE_MULTIUSER_BACKUP);
  if (upgrading && !fs.existsSync(backup)) {
    sqlite.prepare("VACUUM INTO ?").run(backup);
  }
  sqlite.exec(DDL);
  migrate(sqlite);
  if (upgrading) migrateToMultiUser(sqlite);
  sqlite.exec(POST_MIGRATION_DDL);
  ensureDefaultUser(sqlite);
  dropAuthDisabled(sqlite, upgrading);
  db = drizzle(sqlite, { schema });
  return db;
}

function hasTable(sq: Database.Database, table: string): boolean {
  return !!sq.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columnNames(sq: Database.Database, table: string): string[] {
  return (sq.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/** A 1.x database: an owned table that exists without its `user_id`. A brand-new file has neither. */
function isPreMultiUser(sq: Database.Database): boolean {
  return (["servers", "agents"] as const).some(
    (t) => hasTable(sq, t) && !columnNames(sq, t).includes("user_id"),
  );
}

/** Additive migrations for databases created before a column existed. */
function migrate(sq: Database.Database): void {
  const serverCols = sq.prepare("PRAGMA table_info(servers)").all() as { name: string }[];
  if (!serverCols.some((c) => c.name === "description")) {
    sq.exec("ALTER TABLE servers ADD COLUMN description TEXT");
  }
  if (!serverCols.some((c) => c.name === "created_by_agent_slug")) {
    sq.exec("ALTER TABLE servers ADD COLUMN created_by_agent_slug TEXT");
  }
  const agentCols = sq.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  if (!agentCols.some((c) => c.name === "role")) {
    sq.exec("ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'standard'");
  }
  if (!agentCols.some((c) => c.name === "tool_mode")) {
    sq.exec("ALTER TABLE agents ADD COLUMN tool_mode TEXT NOT NULL DEFAULT 'full'");
  }
}

/**
 * 1.x → 2.0: everything becomes the Default user's. The owned tables are rebuilt with ids kept,
 * which means dropping them — and `agent_servers`, `oauth_credentials` and the agent OAuth tables
 * reference servers/agents ON DELETE CASCADE. So foreign keys go off for the rebuild (the pragma is
 * a no-op inside a transaction, hence outside it), and `foreign_key_check` vouches for the result
 * before commit.
 */
function migrateToMultiUser(sq: Database.Database): void {
  sq.pragma("foreign_keys = OFF");
  try {
    sq.transaction(() => {
      const userId = ensureDefaultUser(sq);
      for (const table of Object.keys(OWNED_TABLES) as OwnedTable[]) {
        if (!columnNames(sq, table).includes("user_id")) rebuildWithOwner(sq, table, userId);
      }
      const logCols = columnNames(sq, "request_logs");
      if (!logCols.includes("user_id")) {
        sq.exec("ALTER TABLE request_logs ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
      }
      if (!logCols.includes("server_id")) sq.exec("ALTER TABLE request_logs ADD COLUMN server_id INTEGER");
      sq.prepare("UPDATE request_logs SET user_id = ? WHERE user_id IS NULL").run(userId);
      sq.prepare(
        `UPDATE request_logs SET server_id =
           (SELECT s.id FROM servers s WHERE s.user_id = request_logs.user_id AND s.slug = request_logs.server_slug)
         WHERE server_id IS NULL AND server_slug IS NOT NULL`,
      ).run();
      const copy = sq.prepare(
        "INSERT OR IGNORE INTO user_settings (user_id, key, value) SELECT ?, key, value FROM settings WHERE key = ?",
      );
      for (const key of PER_USER_SETTING_KEYS) copy.run(userId, key);

      const violations = sq.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `Multi-user migration left ${violations.length} foreign key violation(s); rolled back. ` +
            `The pre-upgrade database is in ${PRE_MULTIUSER_BACKUP}.`,
        );
      }
    })();
  } finally {
    sq.pragma("foreign_keys = ON");
  }
}

/**
 * 1.x let the Admin turn sign-in off; 2.0 always requires it. Remove the leftover `authDisabled`
 * setting, and tell an upgrading install that had it on how to get back in (1.x only allowed
 * turning auth off from a signed-in session, so the Default user carries the old password hash).
 */
function dropAuthDisabled(sq: Database.Database, upgrading: boolean): void {
  const row = sq.prepare("SELECT value FROM settings WHERE key = 'authDisabled'").get() as
    | { value: string }
    | undefined;
  if (!row) return;
  sq.prepare("DELETE FROM settings WHERE key = 'authDisabled'").run();
  if (upgrading && row.value === "1") {
    console.warn(
      'Sign-in was turned off in 1.x; it is now always on. Sign in as "admin" with your old password, ' +
        "or set a new one: mcp-switchboard reset-password admin",
    );
  }
}

/** The SQLite "12-step" rebuild, keeping ids and the AUTOINCREMENT high-water mark. */
function rebuildWithOwner(sq: Database.Database, table: OwnedTable, userId: number): void {
  const tmp = `${table}_multiuser`;
  sq.exec(OWNED_TABLES[table](tmp));
  const oldCols = columnNames(sq, table);
  const cols = columnNames(sq, tmp)
    .filter((c) => c !== "user_id" && oldCols.includes(c))
    .join(", ");
  sq.prepare(`INSERT INTO ${tmp} (user_id, ${cols}) SELECT ?, ${cols} FROM ${table}`).run(userId);
  const seq = sq.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as { seq: number } | undefined;
  sq.exec(`DROP TABLE ${table}`);
  sq.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  if (seq) {
    // A deleted top row leaves seq above max(id); without this a new row would reuse its id.
    sq.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
    sq.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, seq.seq);
  }
}

/**
 * The Default user exists on every install: created as `admin` the first time (on an upgrade,
 * carrying the 1.x admin password) and recorded in `defaultUserId`. Returns its id.
 */
function ensureDefaultUser(sq: Database.Database): number {
  const marked = sq.prepare("SELECT value FROM settings WHERE key = ?").get(DEFAULT_USER_SETTING) as
    | { value: string }
    | undefined;
  if (marked && sq.prepare("SELECT 1 FROM users WHERE id = ?").get(Number(marked.value))) {
    return Number(marked.value);
  }
  const passwordHash = sq.prepare("SELECT value FROM settings WHERE key = 'adminPasswordHash'").get() as
    | { value: string }
    | undefined;
  // Users but no marker can't happen through the app; adopt the oldest Admin rather than add another.
  const existing = sq.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as
    | { id: number }
    | undefined;
  const id =
    existing?.id ??
    Number(
      sq
        .prepare(
          `INSERT INTO users (username, password_hash, role, can_run_local_commands, created_at)
           VALUES ('admin', ?, 'admin', 1, ?)`,
        )
        .run(passwordHash?.value ?? null, Date.now()).lastInsertRowid,
    );
  sq.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(DEFAULT_USER_SETTING, String(id));
  return id;
}

export function getDb(): Db {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}

export function closeDb(): void {
  sqlite?.close();
  sqlite = null;
  db = null;
}

export * as tables from "./schema.js";
