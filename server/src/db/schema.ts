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
  /** Provenance for servers registered by an agent; denormalised so it survives agent deletion. */
  createdByAgentSlug: text("created_by_agent_slug"),
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
  /** `manager` unlocks the switchboard__* management tools; text, so future tiers are values not migrations. */
  role: text("role").$type<"standard" | "manager">().notNull().default("standard"),
  /** `lean` swaps the proxied tool list for search/describe/call meta-tools; text, so future modes are values not migrations. */
  toolMode: text("tool_mode").$type<"full" | "lean">().notNull().default("full"),
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

/**
 * Agent-filed asks that need a human: a parsed config to approve (`add_server`) or a plain
 * request in words (`freeform`). stdio configs from the management tools land here too —
 * spawning a command on the host is never granted to a tool call.
 */
export const serverRequests = sqliteTable("server_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Nullable + denormalised slug, like request_logs: the request survives the agent. */
  requestedByAgentId: integer("requested_by_agent_id"),
  requestedByAgentSlug: text("requested_by_agent_slug").notNull(),
  kind: text("kind").$type<"add_server" | "freeform">().notNull(),
  /** Encrypted ParsedServer JSON — a pasted config can carry env values and bearer tokens. */
  payloadJsonEnc: text("payload_json_enc"),
  reason: text("reason"),
  status: text("status").$type<"pending" | "approved" | "denied">().notNull().default("pending"),
  resolutionNote: text("resolution_note"),
  createdAt: integer("created_at").notNull(),
  resolvedAt: integer("resolved_at"),
});

/**
 * Agent-facing OAuth (the switchboard as an authorization server, for clients such as Claude
 * Desktop connectors that can't send a static bearer header). Clients self-register via RFC 7591;
 * secrets and tokens are high-entropy random strings, so only their SHA-256 is stored.
 */
export const agentOAuthClients = sqliteTable("agent_oauth_clients", {
  clientId: text("client_id").primaryKey(),
  clientSecretHash: text("client_secret_hash"),
  clientName: text("client_name"),
  redirectUrisJson: text("redirect_uris_json").notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull(),
  createdAt: integer("created_at").notNull(),
  /**
   * First successful code exchange. A client that ever completed a flow is never pruned: after a
   * revoke, clients retry authorization with their stored client_id and can't re-register from there.
   */
  authorizedAt: integer("authorized_at"),
});

/** Single-use authorization codes, alive for a few minutes between consent and token exchange. */
export const agentOAuthCodes = sqliteTable("agent_oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => agentOAuthClients.clientId, { onDelete: "cascade" }),
  agentId: integer("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scope: text("scope"),
  resource: text("resource"),
  expiresAt: integer("expires_at").notNull(),
  /** Set on exchange; a second exchange attempt revokes the grant it produced. */
  usedAt: integer("used_at"),
  grantId: integer("grant_id"),
});

/** One approved client↔agent connection. Its tokens live in agent_oauth_tokens and rotate. */
export const agentOAuthGrants = sqliteTable("agent_oauth_grants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientId: text("client_id")
    .notNull()
    .references(() => agentOAuthClients.clientId, { onDelete: "cascade" }),
  agentId: integer("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  scope: text("scope"),
  resource: text("resource"),
  /** Encrypted copy of the last token response, replayed to a refresh that raced the rotation. */
  lastResponseEnc: text("last_response_enc"),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
});

/**
 * Access and refresh tokens, by SHA-256. A rotated-out refresh token stays briefly (rotated_at set,
 * expires_at cut to the grace window) so a concurrent refresh gets the same answer instead of an error.
 */
export const agentOAuthTokens = sqliteTable("agent_oauth_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  grantId: integer("grant_id")
    .notNull()
    .references(() => agentOAuthGrants.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"access" | "refresh">().notNull(),
  expiresAt: integer("expires_at").notNull(),
  rotatedAt: integer("rotated_at"),
});

export type ServerRow = typeof servers.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type OAuthCredentialRow = typeof oauthCredentials.$inferSelect;
export type RequestLogRow = typeof requestLogs.$inferSelect;
export type ServerRequestRow = typeof serverRequests.$inferSelect;
export type AgentOAuthClientRow = typeof agentOAuthClients.$inferSelect;
export type AgentOAuthGrantRow = typeof agentOAuthGrants.$inferSelect;
