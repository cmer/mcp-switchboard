# Map: Multi-user MCP Switchboard

Label: wayfinder:map

## Destination

An implementation-ready spec (`.scratch/multi-user/spec.md`) for multi-user MCP Switchboard: per-user isolation of servers, agents, and logs for a trusted household; an Admin role; shares of a live server connection between users; and a forced upgrade that moves existing installs onto a Default user without breaking any agent endpoint.

## Notes

- Domain: this repo (`server/` Hono + MCP SDK v1.x + SQLite/Drizzle, `web/` React). Vocabulary lives in `/GLOSSARY.md` (User, Admin, Default user, Server, Agent, Manager agent, Server request, Setup code, Owner, Share, Alias); use those terms and update it as terms resolve.
- Skills every session should consult: `grilling` and `domain-modeling`; `codebase-design` for [Hub in-memory state per user](issues/10-hub-state-per-user.md).
- Trust model: a trusted household (a few people), not a SaaS and not hostile tenants. Isolation means data visibility and least privilege, not a security boundary against a malicious user.
- Planning only: produce decisions, not code.
- Tracker: local markdown (`issues/NN-*.md`, `Status:` / `Blocked by:` lines). Research findings go in `research/`.

## Decisions so far

- [Agent endpoints and slug namespaces](issues/01-endpoints-and-slug-namespaces.md): `/mcp/<username>/<agent>`, legacy `/mcp/<agent>` → Default user; slugs unique per user; shared servers get a recipient-chosen alias defaulting to `<owner>-<server>`.
- [Login and sessions](issues/02-login-and-sessions.md): instance-wide login mode, password or Cloudflare Access; Admin resets passwords in UI, CLI for a locked-out Admin.
- [Who may run local commands](issues/03-local-command-permission.md): Admin-granted per-user flag; without it, stdio servers go to the Admin's approval queue.
- [Instance vs per-user settings](issues/04-instance-vs-user-settings.md): host/disk settings are instance-wide; auto-enable, server requests, payload capture are per user; turning sign-in off was later removed entirely.
- [Share rules](issues/05-share-rules.md): owner → user, recipient sees tools not config, can't edit/re-auth/re-share, revoke is immediate, logs belong to the caller with usage counts for the owner.
- [Agent-filed requests and manager agents](issues/06-agent-requests-and-manager-agents.md): requests go to the agent's owner (stdio without the flag goes to the Admin, env names only); agent-registered servers belong to the agent's owner; manager agents see only their owner's agents/servers plus received shares, never a share's stderr.
- [Hub in-memory state per user](issues/10-hub-state-per-user.md): share switches live in the existing matrix (fan-out for free); one per-agent reach module replaces global slug lookup; a user-scoped data-access module is the isolation seam, tested once with a guard against direct table access; usage counters on the share row.
- [Routing and agent OAuth under per-user endpoints](issues/11-routing-and-agent-oauth.md): one vs two path segments disambiguate legacy and per-user routes; existing tokens and grants keep working; Default user is fixed by identity, undeletable, and is the first user on fresh installs; usernames renameable with a warning, no redirects.
- [Multi-user UI prototype](issues/12-ui-prototype.md): Servers page is one list (own servers, then received shares with "from <owner>"), offers as banners, Share dialog per server with per-user usage; recipients get their own on/off switch per share; Admin-only Users page; Settings split Yours / Instance.
- [User lifecycle](issues/07-user-lifecycle.md): Admin-only; disabling stops the user's agents and servers (shares go dark); deleting removes everything they own.
- [Cloudflare Access user provisioning and exposure](issues/14-cloudflare-access-provisioning.md): unknown emails refused, Admin-set unique email per user; Access mode is Access-only with per-request JWT checks and no switchboard session; switch-over requires the Admin's own valid token; `login-mode password` CLI recovers; LAN exposure documented, not enforced.
- [Cloudflare Access JWT verification](issues/09-cloudflare-access-verification.md): verify the Access JWT with `jose` (iss, aud, exp required, email required); never trust the email header; `/mcp`, `/oauth`, `/.well-known` need an Access Bypass app.
- [Admin role and user onboarding](issues/16-admin-role-and-onboarding.md): exactly one Admin (the Default user); new users and password resets go through a one-time 24h setup code, so the Admin never knows a password; users change their own password, only the Admin renames usernames.
- [Docs and release shape](issues/15-docs-and-release-shape.md): one 2.0.0 release with everything; first CLI subcommands, safe while running; CHANGELOG leads with "Upgrading from 1.x" incl. rollback; README becomes a short landing page with details moved to `docs/*.md` guides.
- [Assemble the multi-user spec](issues/13-assemble-spec.md): [spec.md](spec.md) written from every resolved ticket, no open markers; **destination reached**.
- [Upgrade migration](issues/08-upgrade-migration.md): backup DB, everything becomes the Default user `admin`, sessions/tokens/legacy URLs keep working; sign-in is now always required (auth-off removed after implementation).

## Not yet specified

_Nothing left. All tickets resolved on 2026-10-13. The way is clear: hand [spec.md](spec.md) to implementation._

## Out of scope

- Hard isolation from a hostile user (sandboxed stdio, per-user encryption keys): trust model is a household; granting local commands is an accepted trust boundary.
- Sharing by copying a server config so the recipient signs in with their own account: a clone feature, not a share.
- External identity providers beyond Cloudflare Access (OIDC, SAML), self-signup, and email-based password reset: not a SaaS.
