import type { Db } from "../db/index.js";
import type { RequestLogger } from "../core/requestLogger.js";
import type { SwitchboardHub } from "../core/switchboardHub.js";
import type { TokenRefresher } from "../core/tokenRefresher.js";
import type { UpstreamManager } from "../core/upstreamManager.js";
import type { DbOAuthProvider } from "../oauth/dbOAuthProvider.js";
import type { AdminSessionStore } from "./adminAuth.js";

export interface AppContext {
  db: Db;
  manager: UpstreamManager;
  hub: SwitchboardHub;
  logger: RequestLogger;
  refresher: TokenRefresher;
  adminSessions: AdminSessionStore;
  makeOAuthProvider: (serverId: number) => DbOAuthProvider;
  version: string;
}
