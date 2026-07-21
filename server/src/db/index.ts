import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let db: Db | null = null;
let sqlite: Database.Database | null = null;

const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_servers (
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, server_id)
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
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
`;

export function initDb(dataDir: string): Db {
  sqlite = new Database(path.join(dataDir, "switchboard.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);
  migrate(sqlite);
  db = drizzle(sqlite, { schema });
  return db;
}

/** Additive migrations for databases created before a column existed. */
function migrate(sq: Database.Database): void {
  const cols = sq.prepare("PRAGMA table_info(servers)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "description")) {
    sq.exec("ALTER TABLE servers ADD COLUMN description TEXT");
  }
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
