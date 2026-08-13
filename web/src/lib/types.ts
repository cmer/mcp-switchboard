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
  /** Slug of the agent that registered this server via a meta-tool; null = added by the admin. */
  createdByAgentSlug: string | null;
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
}

/** The server an agent proposes; mirrors the parsed config, minus secret values. */
export interface ServerRequestConfig {
  name: string;
  slug: string;
  type: "stdio" | "http" | "sse";
  command: string | null;
  args: string[];
  url: string | null;
  authType: string;
  envKeys: string[];
}

export interface ServerRequest {
  id: number;
  requestedByAgentSlug: string;
  kind: "add_server" | "freeform";
  /** null for freeform asks (a reason with no parseable config). */
  server: ServerRequestConfig | null;
  reason: string | null;
  status: "pending" | "approved" | "denied";
  resolutionNote: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface AuthMe {
  needsSetup: boolean;
  authenticated: boolean;
  authDisabled: boolean;
  instanceName: string | null;
  autoEnableNewServers: boolean;
  /** When on, every agent gets the request tool and can ask for new servers. */
  allowServerRequests: boolean;
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
