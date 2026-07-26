import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const servers = sqliteTable("servers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** Freeform note shown to agents (e.g. "Work Gmail — carl@company.com"). */
  description: text("description"),
  type: text("type").$type<"stdio" | "http" | "sse">().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  // stdio
  command: text("command"),
  argsJson: text("args_json"),
  envJsonEnc: text("env_json_enc"),
  cwd: text("cwd"),
  // remote
  url: text("url"),
  authType: text("auth_type").$type<"none" | "bearer" | "headers" | "oauth">().notNull().default("none"),
  bearerTokenEnc: text("bearer_token_enc"),
  headersJsonEnc: text("headers_json_enc"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const adminSessions = sqliteTable("admin_sessions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

export const agents = sqliteTable("agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  tokenEnc: text("token_enc").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const agentServers = sqliteTable(
  "agent_servers",
  {
    agentId: integer("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    serverId: integer("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.serverId] })],
);

export const oauthCredentials = sqliteTable("oauth_credentials", {
  serverId: integer("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  clientInfoEnc: text("client_info_enc"),
  tokensEnc: text("tokens_enc"),
  /** Unix ms when the current access token expires (null = unknown / no expiry). */
  tokenExpiresAt: integer("token_expires_at"),
  /** Unix ms when tokens were last saved (basis for the 80% refresh point). */
  tokenSavedAt: integer("token_saved_at"),
  codeVerifierEnc: text("code_verifier_enc"),
  pendingState: text("pending_state"),
  discoveryJson: text("discovery_json"),
  status: text("status").$type<"ok" | "needs_auth" | "pending">().notNull().default("needs_auth"),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * One row per JSON-RPC request an agent sent through the switchboard. Written when the
 * request arrives (status `pending`) and updated when the response goes back out, so a
 * long-running tool call is visible while it is still in flight.
 */
export const requestLogs = sqliteTable("request_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Unix ms the request was received. */
  ts: integer("ts").notNull(),
  /** Denormalised so logs survive the agent being renamed or deleted. */
  agentId: integer("agent_id"),
  agentSlug: text("agent_slug").notNull(),
  agentName: text("agent_name").notNull(),
  /** Upstream server the request resolved to; null for methods that span every enabled server. */
  serverSlug: text("server_slug"),
  sessionId: text("session_id"),
  /** JSON-RPC id as text (ids may be strings); null for notifications. */
  rpcId: text("rpc_id"),
  method: text("method").notNull(),
  /** Tool/prompt name or resource URI, when the method has one. */
  target: text("target"),
  /** One-line preview shown in the collapsed row. */
  summary: text("summary"),
  status: text("status").$type<"pending" | "ok" | "error">().notNull().default("pending"),
  durationMs: integer("duration_ms"),
  errorCode: integer("error_code"),
  errorMessage: text("error_message"),
  requestJson: text("request_json"),
  responseJson: text("response_json"),
  requestBytes: integer("request_bytes").notNull().default(0),
  responseBytes: integer("response_bytes"),
  /** A payload was captured but clipped to the configured size cap. */
  truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
});

export type ServerRow = typeof servers.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type OAuthCredentialRow = typeof oauthCredentials.$inferSelect;
export type RequestLogRow = typeof requestLogs.$inferSelect;
