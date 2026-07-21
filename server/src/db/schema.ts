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

export type ServerRow = typeof servers.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type OAuthCredentialRow = typeof oauthCredentials.$inferSelect;
