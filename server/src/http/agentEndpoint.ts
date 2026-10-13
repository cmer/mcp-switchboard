import type { Db } from "../db/index.js";
import type { AgentRow } from "../db/schema.js";
import { defaultUserId, getUser, getUserByUsername } from "../core/users.js";
import { userScope } from "../core/userScope.js";

/**
 * How an agent endpoint URL names an agent. Two segments, `/mcp/<username>/<agent-slug>`, are always
 * username and agent; one segment, `/mcp/<agent-slug>`, is always the legacy form and means the
 * Default user's agent — by identity, so it survives renaming that user. The MCP endpoint and the
 * agent OAuth routes both resolve through here, so a URL means the same agent everywhere.
 */
export interface AgentEndpoint {
  /** Null for the legacy one-segment form. */
  username: string | null;
  agentSlug: string;
}

const SEGMENT = "[a-z0-9-]{1,64}";
const ENDPOINT_PATH = new RegExp(`^/mcp/(?:(${SEGMENT})/)?(${SEGMENT})/?$`);

/** `/mcp/<agent>` or `/mcp/<username>/<agent>` (a trailing slash allowed) → the endpoint; anything else null. */
export function endpointFromPath(pathname: string): AgentEndpoint | null {
  const match = ENDPOINT_PATH.exec(pathname);
  return match ? { username: match[1] ?? null, agentSlug: match[2] } : null;
}

/** The path after `/mcp/`, in the form it was asked for: `alice/claude`, or `claude` for the legacy form. */
export function endpointPath(endpoint: AgentEndpoint): string {
  return endpoint.username === null ? endpoint.agentSlug : `${endpoint.username}/${endpoint.agentSlug}`;
}

/**
 * The agent an endpoint names. Undefined for an unknown user, an unknown agent and a disabled user
 * alike: callers answer all three the same way, so nothing reveals which usernames exist.
 */
export function endpointAgent(db: Db, endpoint: AgentEndpoint): AgentRow | undefined {
  const owner = endpoint.username === null ? getUser(db, defaultUserId(db)) : getUserByUsername(db, endpoint.username);
  if (!owner || owner.disabledAt !== null) return undefined;
  return userScope(db, owner).agents.bySlug(endpoint.agentSlug);
}
