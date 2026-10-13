export type ServerState = "disabled" | "connecting" | "connected" | "backoff" | "needs_auth" | "stopped";

export interface ServerInfo {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  type: "stdio" | "http" | "sse";
  enabled: boolean;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  authType: "none" | "bearer" | "headers" | "oauth";
  hasEnv: boolean;
  envKeys: string[];
  hasBearerToken: boolean;
  hasHeaders: boolean;
  headerKeys: string[];
  createdAt: number;
  updatedAt: number;
  state: ServerState;
  lastError: string | null;
  toolCount: number;
  oauthStatus: "ok" | "needs_auth" | "pending" | null;
  tokenExpiresAt: number | null;
  /** Slug of the agent that registered this server via a meta-tool; null = added by a person. */
  createdByAgentSlug: string | null;
  /** Other users this server is shared with: names and usage only. */
  sharedWith: OwnedShare[];
}

/** One recipient of one of my servers, as the owner sees it. */
export interface OwnedShare {
  id: number;
  username: string;
  status: "offered" | "accepted";
  callCount: number;
  lastUsedAt: number | null;
  createdAt: number;
}

/** A share offered to me, waiting for an alias and a yes. */
export interface ShareOffer {
  id: number;
  ownerUsername: string;
  serverName: string;
  description: string | null;
  /** What accepting prefills: `<owner>-<slug>`. */
  proposedAlias: string;
  createdAt: number;
}

/** In the recipient's terms: never the owner's URL, command or credentials. */
export type ShareStatus = "connected" | "waiting_for_owner" | "unavailable";

/** A share I accepted. `serverId` is the owner's server id, the key of my per-agent switches. */
export interface ReceivedShare {
  id: number;
  serverId: number;
  alias: string;
  ownerUsername: string;
  serverName: string;
  description: string | null;
  toolCount: number;
  /** My own switch: off hides it from every one of my agents without touching their rows. */
  enabled: boolean;
  status: ShareStatus;
  createdAt: number;
}

export interface SharesResponse {
  offers: ShareOffer[];
  accepted: ReceivedShare[];
}

/** `manager` agents may register remote servers and edit the matrix over MCP. */
export type AgentRole = "standard" | "manager";

/** `lean` agents get search/describe/call meta-tools instead of every proxied tool schema. */
export type ToolMode = "full" | "lean";

export interface AgentInfo {
  id: number;
  slug: string;
  name: string;
  token: string;
  role: AgentRole;
  toolMode: ToolMode;
  createdAt: number;
  sessions: number;
  servers: { serverId: number; enabled: boolean }[];
  oauthGrants: OAuthGrant[];
}

/** A client (e.g. a Claude Desktop connector) approved to reach this agent over OAuth. */
export interface OAuthGrant {
  id: number;
  clientName: string | null;
  /** Host the client's redirect URI points at — the closest thing to a verified identity. */
  redirectHost: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/** The server an agent proposes; mirrors the parsed config, minus secret values. */
export interface ServerRequestConfig {
  name: string;
  slug: string;
  type: "stdio" | "http" | "sse";
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  authType: string;
  envKeys: string[];
}

export interface ServerRequest {
  id: number;
  /** null when a person filed it from the web UI. */
  requestedByAgentSlug: string | null;
  /** Set on another user's escalated request in the Admin's queue; null for your own. */
  requestedByUsername: string | null;
  /** Routed to the Admin. On your own request that means "waiting for the Admin". */
  escalated: boolean;
  kind: "add_server" | "freeform";
  /** null for freeform asks (a reason with no parseable config). */
  server: ServerRequestConfig | null;
  reason: string | null;
  status: "pending" | "approved" | "denied";
  resolutionNote: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export type LoginMode = "password" | "cloudflare";

/** Why Cloudflare Access let a browser through to the login screen without signing it in. */
export type AccessError = "no_token" | "invalid_token" | "unknown_email" | "disabled";

/** The signed-in user, as the UI may know them. */
export interface SessionUser {
  id: number;
  username: string;
  role: "admin" | "user";
  email: string | null;
  canRunLocalCommands: boolean;
  isDefault: boolean;
}

export interface AuthMe {
  needsSetup: boolean;
  authenticated: boolean;
  loginMode: LoginMode;
  user: SessionUser | null;
  /** Cloudflare mode, signed out: who Access says you are, and why that isn't enough. */
  accessEmail?: string | null;
  accessError?: AccessError;
  /** Admin only: the Cloudflare Access settings. */
  access?: { teamDomain: string | null; audTags: string[] };
  instanceName: string | null;
  autoEnableNewServers: boolean;
  /** When on, every one of my agents gets the request tool and can ask for new servers. */
  allowServerRequests: boolean;
  capturePayloads: boolean;
  /** Set when the MCP endpoint runs on its own port/host; null = same origin as the UI. */
  mcpBaseUrl: string | null;
}

export type LogStatus = "pending" | "ok" | "error";

/** One inbound request. Payloads are omitted here and fetched per row on expand. */
export interface LogSummary {
  id: number;
  ts: number;
  agentId: number | null;
  agentSlug: string;
  agentName: string;
  /** null = the request spans every server enabled for the agent (tools/list, initialize …). */
  serverSlug: string | null;
  method: string;
  target: string | null;
  summary: string | null;
  status: LogStatus;
  durationMs: number | null;
  errorCode: number | null;
  errorMessage: string | null;
  requestBytes: number;
  responseBytes: number | null;
}

export interface LogDetail extends LogSummary {
  sessionId: string | null;
  rpcId: string | null;
  requestJson: string | null;
  responseJson: string | null;
  truncated: boolean;
}

export interface LogConfig {
  retentionHours: number;
  capturePayloads: boolean;
  maxPayloadKb: number;
}

export interface LogStats {
  total: number;
  errors: number;
  medianMs: number | null;
  p95Ms: number | null;
}

export type LogEvent = { type: "insert" | "update"; row: LogSummary };

export interface LogFilters {
  agent: string;
  server: string;
  method: string;
  status: string;
  q: string;
}

export interface ServerToolsInfo {
  tools: { name: string; namespacedName: string; description: string }[];
  prompts: { name: string; description: string }[];
  resources: { uri: string; name: string }[];
}

/** A user as the Admin's Users page lists them: names and counts, never contents. */
export interface UserInfo {
  id: number;
  username: string;
  role: "admin" | "user";
  email: string | null;
  canRunLocalCommands: boolean;
  disabled: boolean;
  isDefault: boolean;
  hasPassword: boolean;
  setupCodePending: boolean;
  serverCount: number;
  agentCount: number;
  createdAt: number;
}

export interface SetupCode {
  code: string;
  expiresAt: number;
}

export interface DirectoryUser {
  username: string;
}
