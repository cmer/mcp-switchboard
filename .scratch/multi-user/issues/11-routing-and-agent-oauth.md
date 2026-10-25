# Routing and agent OAuth under per-user endpoints

Type: grilling
Status: resolved
Blocked by: 01

## Question

With endpoints at `/mcp/<username>/<agent-slug>` and the legacy `/mcp/<agent-slug>` kept for the Default user: how do the agent-facing OAuth pieces follow? Covers the protected-resource metadata path (`/.well-known/oauth-protected-resource/mcp/<username>/<agent>` plus the legacy form), the `resource` value bound into grants and tokens (does a legacy grant stay valid when the same agent is reached via the new URL?), consent pairing codes being issued from the owning user's UI, the split `MCP_PORT` listener's 404 message, and how a username can't be confused with a legacy agent slug in the two-segment vs one-segment route. Also: which names are reserved so they can't be used as a username, agent slug, or alias (`switchboard`, the prefix of the meta-tools; anything that would collide with legacy one-segment routes)?

## Answer

Resolved 2026-10-12.

**What already holds (from `mcpEndpoint.ts`, `agentOAuthRoutes.ts`, `agentOAuth.ts`)**
- Access tokens are verified by agent id (`verifyAccessToken(token).agentId === agent.id`), not by URL, so a token obtained through `/mcp/<agent>` also works at `/mcp/<username>/<agent>`.
- A grant's `resource` is only compared on refresh, against what the client sends; existing clients keep sending their old URL, so legacy grants stay valid untouched.
- Pairing codes are bound to an agent id and the consent page checks the code against the agent named by `resource`. Only change: minting a code goes through the user-scoped data-access module, so a user can mint codes for their own agents only.

**Routing**
- One segment `/mcp/<x>` is always a legacy agent slug (Default user); two segments `/mcp/<x>/<y>` are always username/agent. No username can be mistaken for a legacy agent slug.
- `slugFromResource` and `/.well-known/oauth-protected-resource/mcp/...` accept both forms; metadata `resource` echoes the form that was requested.
- Unknown user, unknown agent, and wrong token all return the same 401 with the `resource_metadata` pointer, so the endpoint never reveals which usernames exist.
- The split `MCP_PORT` listener's 404 names `/mcp/<username>/<agent-slug>`.

**Default user**
- The legacy route resolves to the Default user by identity, so it survives renaming `admin`.
- The Default user cannot be deleted or disabled (the legacy route and the locked-out-Admin CLI depend on it). This narrows [User lifecycle](07-user-lifecycle.md).
- On a fresh install, the first user created at setup is the Default user: one model, no "migrated install" special case.

**Renaming a username**
- Allowed, after a warning listing the agent endpoint URLs that will break. No redirects. Aliases other users already chose for this user's servers are left as they are. The Default user's legacy one-segment URLs survive a rename.

**Connection snippets**
- The UI always shows the new `/mcp/<username>/<agent>` form, Default user included; the legacy form keeps working unadvertised.

**Reserved names**
- `switchboard` stays reserved for server slugs and aliases (built-in tool prefix, already in `lib/slug.ts`).
- No new reservations for usernames or agent slugs; both follow `^[a-z0-9-]{1,64}$`.
