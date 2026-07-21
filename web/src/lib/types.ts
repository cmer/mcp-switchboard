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
}

export interface AgentInfo {
  id: number;
  slug: string;
  name: string;
  token: string;
  createdAt: number;
  sessions: number;
  servers: { serverId: number; enabled: boolean }[];
}

export interface AuthMe {
  needsSetup: boolean;
  authenticated: boolean;
  authDisabled: boolean;
  instanceName: string | null;
  autoEnableNewServers: boolean;
}

export interface ServerToolsInfo {
  tools: { name: string; namespacedName: string; description: string }[];
  prompts: { name: string; description: string }[];
  resources: { uri: string; name: string }[];
}
