# Spec: Multi-user MCP Switchboard (2.0.0)

Assembled 2026-10-12 from the [map](map.md). Every section cites the ticket that holds the decision; this file decides nothing new. Vocabulary is `/GLOSSARY.md` (User, Admin, Default user, Setup code, Server, Agent, Manager agent, Server request, Owner, Share, Alias).

> Assembly surfaced one gap, since resolved in [Admin role and user onboarding](issues/16-admin-role-and-onboarding.md).

## 1. Goal and trust model

Turn the single-user switchboard into one that a household of a few people shares. Each user has their own servers, agents, logs and settings, invisible to the others. The Admin manages users and instance settings. An owner can share a live server connection with another user. Every existing install upgrades in place to a Default user, and no agent endpoint breaks.

Trust model: a trusted household, not a SaaS and not hostile tenants. Isolation means data visibility and least privilege, not a security boundary against a malicious user. Granting "can run local commands" is an accepted trust boundary, since a local command can read `secret.key`. ([map notes](map.md), [Who may run local commands](issues/03-local-command-permission.md))

## 2. Roles and permissions

| Capability | User | Admin |
|---|---|---|
| Own servers, agents, logs, settings, server requests | ✓ | ✓ |
| Share own servers; accept, alias, switch off or remove received shares | ✓ | ✓ |
| Add stdio servers directly | only with "can run local commands" | always |
| Create, rename, disable or delete users; reset passwords (setup codes); set emails; grant local commands | | ✓ |
| Instance settings (name, login mode, log retention, max payload) | | ✓ |
| Approve escalated stdio requests from other users | | ✓ |
| See other users' servers, agents or logs | never | names and counts only |

- **Default user:** fixed by identity, never disabled or deleted. It is the first user on a fresh install, and the owner of all existing data on an upgraded one. ([Routing and agent OAuth](issues/11-routing-and-agent-oauth.md), [Upgrade migration](issues/08-upgrade-migration.md))
- **Exactly one Admin: the Default user.** The role can't be granted to others. "Can run local commands" is the one delegable power. Store the role as a value so more Admins could be allowed later without a migration. ([Admin role and user onboarding](issues/16-admin-role-and-onboarding.md))

## 3. Data model (the shape implied by the decisions; the implementer may adjust names)

New tables:
- `users`: `id`, `username` (unique, `^[a-z0-9-]{1,64}$`), `password_hash` (nullable), `email` (nullable; unique when lower-cased), `role` (text: `admin` | `user`, following the `agents.role` pattern), `can_run_local_commands`, `setup_code_hash` and `setup_code_expires_at` (nullable; persisted because a 24h code has to survive a restart, unlike in-memory agent pairing codes), `disabled_at` (nullable), `created_at`. The Default user is marked by a `settings` key or a flag; it must survive a rename.
- `shares`:
  - Columns: `id`, `server_id` → servers (cascade), `recipient_user_id` → users (cascade), `alias`, `status` (`offered` | `accepted`), `enabled` (recipient-controlled, default true), `call_count`, `last_used_at`, `created_at`.
  - Unique: (`server_id`, `recipient_user_id`).
- `user_settings`: `user_id`, `key`, `value`. This mirrors `settings`. ([Hub in-memory state per user](issues/10-hub-state-per-user.md))

Changed tables:
- `servers` gets `user_id` (owner). Its unique key becomes (`user_id`, `slug`).
- `agents` gets `user_id`. Its unique key becomes (`user_id`, `slug`).
- `admin_sessions` gets `user_id`.
- `server_requests` gets `user_id` (the requesting agent's owner) and `escalated` (routed to the Admin).
- `request_logs` gets `user_id` (the calling agent's owner) and `server_id` (the server reached). `server_slug` is kept as the name the agent used: the alias or its own slug.
- `agent_servers` is unchanged. A recipient's switch for a share is a normal row (recipient's agent, owner's server).
- The `agent_oauth_*` tables are unchanged.

Namespace rule: within one user, own server slugs and the aliases of accepted shares form a single namespace. A new own slug or alias that clashes with either is rejected. `switchboard` is reserved there. ([Agent endpoints and slug namespaces](issues/01-endpoints-and-slug-namespaces.md), [Routing and agent OAuth](issues/11-routing-and-agent-oauth.md))

## 4. Authentication

Login mode is instance-wide and chosen by the Admin. ([Login and sessions](issues/02-login-and-sessions.md))

**Password mode**
- Username and password per user. Sessions keep today's year-long cookie, now bound to `user_id`.
- **Disabled users** can't sign in in either mode, and their existing sessions are dropped.
- **Setup codes:** creating a user produces a **one-time setup code** (single use, expires after 24h, generated and normalised like agent pairing codes; stored as a hash on the user row). The Admin hands it over, and the new user picks "I have a setup code" on the login page and chooses their own password. The Admin never knows anyone's password.
- **Reset password** (Users page) issues a new setup code the same way, invalidating the old password and that user's sessions.
- **Own password:** users change it in Settings. ([Admin role and user onboarding](issues/16-admin-role-and-onboarding.md))

**Cloudflare Access mode** ([Cloudflare Access JWT verification](issues/09-cloudflare-access-verification.md), [Cloudflare Access user provisioning and exposure](issues/14-cloudflare-access-provisioning.md), [research](research/cloudflare-access.md))
- Verify `Cf-Access-Jwt-Assertion` (falling back to the `CF_Authorization` cookie) with `jose`. Use `createRemoteJWKSet(<team>/cdn-cgi/access/certs)`, created once per team domain. Check `issuer` = team domain, `audience` = AUD tag(s), `algorithms: ['RS256']` and `requiredClaims: ['exp']`. Require a non-empty `email`, which rejects service tokens.
- Never read `Cf-Access-Authenticated-User-Email`.
- The JWT is checked on **every** admin request and no switchboard session is created. Log out goes to `/cdn-cgi/access/logout`.
- Matching: the user's email, compared case-insensitively. An unknown email is refused with "Signed in as <email>, but no switchboard user has this email. Ask the Admin." Users are never created automatically.
- Password login is off entirely in this mode.
- Admin configuration: team domain (normalised) and AUD tag(s). Saving it is only accepted if **the request doing the save** carries a valid Access token for the Admin's own email.
- The agent paths (`/mcp/*`, `/oauth/*`, `/.well-known/*`) never look at Access headers.
- Settings shows this warning: "In Access mode, don't expose the admin port on your LAN." It isn't enforced.

**Turning sign-in off: removed.** Sign-in is always required (revised after implementation; it meant "everyone is the Admin", which only works with one user, and sessions already last a year).

**CLI** ([Docs and release shape](issues/15-docs-and-release-shape.md))
- These are the first subcommands on the `mcp-switchboard` bin. Today `dist/index.js` only starts the server, so subcommands need argument dispatch.
  - `reset-password <username>`: sets a new password directly and invalidates that user's sessions. Unlike the UI it doesn't use a setup code, because shell access to the host is already full access.
  - `login-mode password`: switches the instance back to password mode.
- Both are safe to run while the server is running.

## 5. The isolation seam

([Hub in-memory state per user](issues/10-hub-state-per-user.md))
- **A user-scoped data-access module** is created per request:
  - For REST: from the logged-in user.
  - For MCP: from the agent's owner.
  - It is the only code that queries the owned tables (`servers`, `agents`, `agent_servers`, `shares`, `server_requests`, `request_logs`, `user_settings`).
  - Routes and `agentServerFactory` go through it. Today about 70 queries hit those tables directly.
- **A narrow admin module** serves the Users page and the escalated approval queue. It returns names and counts, and request details with environment variable names only, never contents or secrets.
- **Tests:**
  - **Cross-user suite at the scoped module's interface:** user A can't list, read, update or delete user B's rows, and B's server reaches A only through an accepted share.
  - **Guard test:** fails if any route or core module imports owned-table objects outside the scoped module.

## 6. Agent endpoint and agent OAuth

([Agent endpoints and slug namespaces](issues/01-endpoints-and-slug-namespaces.md), [Routing and agent OAuth](issues/11-routing-and-agent-oauth.md))
- **Routes:** `/mcp/<username>/<agent-slug>`. The legacy `/mcp/<agent-slug>` resolves to the Default user's agent by identity, so it survives a rename. One segment is always legacy and two segments are always username/agent.
- **Auth is unchanged:** a static bearer token, or an OAuth access token verified by agent id. Tokens issued through the legacy URL also work on the new one. Existing grants refresh against their stored `resource`, so they stay valid.
- **401s:** unknown user, unknown agent and wrong token all return the same 401 with `resource_metadata`.
- **Disabled users:** a disabled user's agents are refused.
- **Agent OAuth paths:**
  - `slugFromResource` and `/.well-known/oauth-protected-resource/mcp/...` accept both forms and echo back the form that was requested.
  - Pairing codes are generated through the scoped module, so each user can only generate codes for their own agents.
  - The `MCP_PORT` 404 message names `/mcp/<username>/<agent-slug>`.
- **Snippets:** connection snippets always show the new form. The legacy form keeps working without being advertised.
- **Renaming a username:** allowed after a warning listing the agent URLs that will break. There are no redirects, and other users' aliases are left alone. **Only the Admin can rename.** ([Admin role and user onboarding](issues/16-admin-role-and-onboarding.md))

## 7. Servers, local commands, server requests and manager agents

([Who may run local commands](issues/03-local-command-permission.md), [Agent-filed requests and manager agents](issues/06-agent-requests-and-manager-agents.md))
- **Stdio servers:** a user can add one directly (manually or by paste-import) only with "can run local commands". Without it, the server becomes an escalated server request. A stdio server is never created from a tool call; a person always approves it.
- **Request routing:**
  - Remote and freeform requests go to the requesting agent's owner's queue.
  - Stdio requests go to that queue if the owner can run local commands, and otherwise **straight to the Admin**.
  - The requesting user sees "waiting for Admin" and can cancel.
  - Requests never cross between users.
- **Escalated requests:** the Admin sees the user, agent, reason, command, args, cwd and environment variable **names**. Approving creates the server **owned by the requester** with the values from the payload, switched on for the requesting agent.
- **Ownership:** a server registered by an agent belongs to the agent's owner. `createdByAgentSlug` stays as a record of which agent created it.
- **`requests.ts` lookup:** the fallback that finds a requester by slug must also match on `user_id`.
- **Manager agents:**
  - `list_agents` returns only the owner's agents.
  - `assign_server` covers the owner's servers and accepted shares, addressed by alias.
  - `server_status` on a share returns status and counts, never stderr.
  - `add_server` with `enable_for` reaches the owner's agents only.
  - Manager agents can't accept shares or modify shared servers.
- **`list_servers` and the instructions roster:** these show received shares under their alias with `sharedBy: "<owner>"`.
- **`autoEnableNewServers`** (per user) only switches a new server on for its owner's agents.

## 8. Sharing

([Share rules](issues/05-share-rules.md), [Multi-user UI prototype](issues/12-ui-prototype.md))
- **Share lifecycle:**
  - The owner shares a server with a **user**, which creates an `offered` share.
  - The recipient accepts with an alias, prefilled `<owner>-<slug>` and editable, which makes it `accepted`. Declining deletes the offer.
  - The recipient can rename the alias later, switch the share off or on for all their agents, or remove it.
  - The owner can revoke at any time.
- **What the recipient sees:** name, description, status, tools, prompts and resources under the alias. Never URL, command, env, headers, credentials or stderr.
- **What the recipient can't do:** edit, restart, re-authenticate or re-share. Status uses the recipient's terms: "Waiting for <owner>" when the owner must re-authorize, and "Unavailable" when the owner turned it off or the owner is disabled.
- **Per-agent switches:** the recipient switches the share on per agent in the existing matrix, off by default. The recipient's own on/off switch overrides it without touching those rows, and turning it back on restores them.
- **Revoking:**
  - Takes effect immediately.
  - The affected agents are collected **before** deleting the share and its matrix rows, then each one is notified.
  - Calls already in progress finish.
  - Deleting the server removes all its shares.
- **Usage:** each call through a share increments `shares.call_count` and sets `last_used_at`. The owner sees these per recipient. Log rows belong to the caller, so the owner never sees the recipient's payloads.

## 9. Runtime

([Hub in-memory state per user](issues/10-hub-state-per-user.md))
- **The per-agent reach module** is the only path from a name to a server. It returns `{ name (own slug or alias), serverId, sharedBy? }` for what an agent can reach, plus resolve-by-name, and honours the matrix, `shares.status`/`enabled`, and whether each server is enabled and running.
  - It replaces `UpstreamManager.getBySlug` (delete it) and the joins `enabledConnections`, `matrixServers` and `enabledServerSlugs`.
  - Everything goes through it: listing tools, prompts and resources; resolving calls and reads; the lean-mode search space; `list_servers`; the `assign_server` and `server_status` targets; and log attribution.
- **No structural change needed:** `UpstreamManager` (keyed by server id), `TokenRefresher`, lean search (no index) and hub sessions (keyed by agent id).
- **Fan-out:** `hub.notifyChanged(serverId)` reaches recipients through the matrix rows. Accepting a share, switching it on or off, renaming its alias, revoking it and removing it each notify the affected agents.
- **Disabled users:** reconcile runs a server only if `server.enabled && owner active`. Disabling a user stops their connections, which notifies recipients through the matrix, and calls `dropAgentSessions` for each of the user's agents.
- **Logs:** `RequestLogger` records `user_id` and `server_id`. The live SSE stream sends each event only to subscribers of the calling agent's user. Retention pruning stays instance-wide.

## 10. Settings

([Instance vs per-user settings](issues/04-instance-vs-user-settings.md))
- **Instance (Admin):** `instanceName`, login mode with its Access configuration, log retention hours, max payload KB.
- **Per user (`user_settings`):** `autoEnableNewServers`, `allowServerRequests` and `capturePayloads`.

## 11. Web UI

([Multi-user UI prototype](issues/12-ui-prototype.md); prototype and screenshots in [prototype/](prototype/))
- **Servers page** (variant A, "one list"):
  - Share offers appear as banners at the top, with the alias field and Accept / Decline.
  - The list shows own servers first, then received shares. A received share row shows its alias, a "from <owner>" badge, status in the recipient's terms, the recipient's on/off switch and Remove.
  - Own servers show a "shared with …" badge, with per-user call counts on hover, and a **Share** button. The Share dialog has one row per other user, showing usage and Share / Revoke.
  - The request panel shows escalated stdio requests to the Admin with a "from <user>" label and environment variable names only.
- **Agents page:** received shares appear in each agent card under their alias with "from <owner>", after own servers. A share the recipient switched off shows as off. Snippets use `/mcp/<username>/<agent>`.
- **Users page (Admin only, new sidebar item):** **Create user** and a list showing role, the "can run local commands" toggle, email, Rename, Disable, Delete and Reset password. Creating a user and Reset password each show a one-time setup code. It shows names and counts only. Renaming warns about the URLs that will break. In Access mode, creating a user takes only a username and email.
- **Settings:** a **Yours** section and an **Instance** section (Admin only), including login mode with the Access configuration and the LAN-exposure warning.
- **Login:** username and password, plus "I have a setup code" (code, then a new password). In Access mode there's no form, only "signed in as <email>" or the refusal message.
- **Sidebar footer:** the signed-in username and Log out.

## 12. Upgrade migration

([Upgrade migration](issues/08-upgrade-migration.md))
1. Copy `switchboard.db` to `switchboard.db.pre-multiuser` before any schema change. The upgrade is one-way.
2. Create the Default user: username `admin`, Admin, can run local commands, with the existing `adminPasswordHash`.
3. Assign every server, agent, server request and log row to it. Bind existing `admin_sessions` rows to it.
4. Copy the current global values of `autoEnableNewServers`, `allowServerRequests` and `capturePayloads` into its `user_settings`.
5. Leave legacy URLs, agent tokens and agent OAuth grants untouched; they keep working through the legacy route.
6. If sign-in was turned off in 1.x, the `authDisabled` setting is removed and a startup message says to sign in as `admin` with the old password or run `mcp-switchboard reset-password admin`.

A fresh install's first setup creates the Default user the same way.

## 13. Release and docs

([Docs and release shape](issues/15-docs-and-release-shape.md))
- **Version:** a single release, `@cmer/mcp-switchboard` **2.0.0**, containing everything in this spec.
- **CHANGELOG:** `[Unreleased]` is filled in as the work lands. It leads with "Upgrading from 1.x":
  - the backup file
  - sign in as `admin` with the same password
  - URLs and tokens keep working, and snippets now show `/mcp/admin/<agent>`
  - rollback: stop, restore the backup, reinstall 1.5.x, and lose any changes made since the upgrade
  
  Then the `Added` and `Changed` bullets with bold lead-ins and the reason behind each change.
- **README:** becomes a short landing page.
  - **Keeps:** the feature bullets (with "Household-ready: separate users, each fully isolated, with optional sharing", and the trusted-LAN caveat stays), quick start (npx and Docker), connecting an agent, a new **Users and sharing** section, screenshots, and a **Guides** list.
  - **Moves to `docs/`:**
    - `configuration.md`: the env var table
    - `reverse-proxy.md`: proxies, plain-HTTP OAuth, the `MCP_PORT` split
    - `cloudflare-access.md`: team domain and AUD, the Bypass app for `/mcp/*`, `/oauth/*` and `/.well-known/*`, Managed OAuth off, the LAN warning
    - `recovering-access.md`: the CLI in npx and `docker compose exec switchboard node dist/index.js …` forms
    - `lean-mode.md`
  - **Screenshots:** re-shoot servers, agents, settings and connect.
- **`CLAUDE.md`:** update the single-user description and add the new rules: per-user slugs plus the alias namespace, the reach module as the only name→server path, the user-scoped data access as the only owned-table access, the Default user, and shares.

## 14. Verification

- The cross-user isolation suite and the guard test (§5).
- **Migration test:** a 1.5.2-shaped database upgrades to the Default user. The backup file exists, the old password logs in as `admin`, legacy `/mcp/<slug>` works with the old bearer token and the old OAuth access token, and per-user settings carry over.
- **Routing tests:** one vs. two segments, the identical 401 for unknown user, unknown agent and bad token, disabled user refused, and the Default user's legacy route after a rename.
- **Sharing tests:** offer, accept with alias, alias clash rejected, per-agent switch, the recipient's switch overriding without losing matrix rows, revoke notifying live sessions, the owner disabled → "Unavailable", stderr never exposed, and counters incremented.
- **Cloudflare Access tests:** with a local JWKS, a valid token, a wrong `aud`, a missing `exp`, a service token without `email`, a spoofed email header ignored, an unknown email refused, and a save refused without the Admin's own token.
- **Manual:** confirm live that a path-specific Access Bypass app on `/mcp/*` overrides the host-wide Allow app. The research found this follows from the docs but has no worked example.

## 15. Out of scope

From the [map](map.md):
- hard isolation from a hostile user (sandboxed stdio, per-user encryption keys)
- sharing by copying a config
- external identity providers beyond Cloudflare Access
- self-signup
- email-based password reset
