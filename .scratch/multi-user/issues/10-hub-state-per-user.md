# Hub in-memory state per user

Type: grilling
Status: resolved
Blocked by: 05, 07

## Question

How does the switchboard's in-memory runtime partition by user and by share? Covers: `SwitchboardHub` agent sessions and `list_changed` fan-out (a share toggle or revoke must reach the recipient's sessions), `UpstreamManager` (one shared client per server, now possibly serving several users' agents; stopped when its owner is disabled), `TokenRefresher` (owner's tokens, recipients waiting), the lean-mode tool search index (per agent, including aliased shared servers), and `requestLogger` (rows attributed to the calling agent's user plus per-share usage counters for the owner). Where does the "which user is this" seam go so every query is scoped without threading a user id through every call by hand?

## Answer

Resolved 2026-10-12. Fact base: a code survey of `server/src` (hub, upstream manager, refresher, tool search, request logger, agent server factory, ~70 owned-table queries across routes and core).

**Unchanged by multi-user**
- `UpstreamManager`: one connection per server, keyed by server id, shared by every agent that reaches it (own or via share).
- `TokenRefresher`: keyed by server id; `onNeedsAuth` → `hub.notifyChanged(serverId)` already reaches recipients once share switches live in the matrix (below).
- Lean-mode search: no index; built per call from the calling agent's reachable connections, so correctness follows from the reach module.
- Hub sessions: keyed by agent id.

**Share switches live in the existing matrix**
- A recipient's per-agent switch for a share is a normal `agent_servers` row (recipient's agent, owner's server). A new `shares` table holds (server, recipient user, alias, usage counters).
- Consequence: `hub.notifyChanged(serverId)` fans out to recipients with no new code (owner OAuth dies, restarts, upstream `list_changed`).
- Revoke deletes the share and the recipient's matrix rows for that server, capturing affected agents **before** the delete (same pattern as server DELETE in `servers.ts`), then `notifyAgent` each.

**One per-agent reach module is the only name → server path**
- Given an agent, it returns what that agent can reach: name (own slug or alias), server id, `sharedBy`; plus resolve-by-name.
- Replaces `manager.getBySlug` (global scan, must be deleted) and the three near-duplicate matrix joins (`enabledConnections`, `matrixServers`, `enabledServerSlugs`).
- All of these go through it: tools/prompts/resources list, call and read resolution, lean search space, `list_servers`, `assign_server`/`server_status` targets, and request-log attribution.

**A user-scoped data-access module is the REST/MCP isolation seam**
- Built per request from the logged-in user (REST) or from the agent's owner (MCP). Routes and the agent server factory never query owned tables (`servers`, `agents`, `agent_servers`, `shares`, `server_requests`, `request_logs`, `user_settings`) directly.
- Isolation is proven once, at that interface: a cross-user test suite (user A cannot list/read/update/delete user B's rows, and B's shared server appears to A only through the share). A guard test fails if a route or core module imports owned table objects outside the module.
- Admin views of other users go through a separate narrow admin module returning names and counts, never contents.

**Request logs and usage**
- Rows gain the calling agent's user id and the reached server id, alongside the name the agent used (alias or slug), so attribution survives aliases and renames.
- Owner's per-recipient usage (call count, last used) is a counter on the `shares` row, bumped per call: log retention (48h default) would otherwise silently reset it.
- The live log SSE stream filters each event to subscribers of the calling agent's user (today it is one global subscriber set).

**Owner disabled**
- Reconcile treats a server as runnable only if the server is enabled **and** its owner is active; disabling a user therefore stops their connections through existing reconcile (which notifies recipients via the matrix) and calls `dropAgentSessions` for each of their agents.

**Settings and smaller consequences**
- Per-user settings live in `user_settings(user_id, key, value)`, mirroring the key/value `settings` table; the settings helpers take a scope.
- `autoEnableNewServers` enables a new server only for its owner's agents.
- MCP endpoint lookup resolves the agent by (username, agent slug); legacy one-segment form resolves within the Default user.
- Addendum from [Multi-user UI prototype](12-ui-prototype.md): the `shares` row also carries a recipient-controlled `enabled` flag; the reach module treats a switched-off share as unreachable for all the recipient's agents (their matrix rows are kept), and toggling it notifies those agents.
