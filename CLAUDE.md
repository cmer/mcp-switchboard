# MCP Switchboard

Self-hosted MCP switchboard for a household (npm: `@cmer/mcp-switchboard`). Each user configures their own MCP servers (local stdio + remote HTTP/SSE/OAuth) once in a web UI; each coding agent (Claude Code, Codex, …) connects to its own endpoint `/mcp/<username>/<agent-slug>` with a per-agent bearer token and sees only the servers enabled for it in a per-agent switch matrix. Users are isolated from each other; an owner can share a live server connection with another user, who sees it under an alias. The Admin (the Default user) manages users and instance settings. Legacy `/mcp/<agent-slug>` resolves to the Default user's agent. Tools are namespaced `<server-slug>__<tool>`.

## Layout

- `server/` — Node 20+ TypeScript, Hono, `@modelcontextprotocol/sdk` **v1.x** (do NOT upgrade to v2 before 2026-10-12), better-sqlite3 + Drizzle, ESM (`.js` import suffixes required).
  - SDK v2.0.0 (the `@modelcontextprotocol/core` + `/client` + `/server` split) went GA 2026-07-27 and
    is deliberately deferred — v1.x gets bug and security fixes for at least 6 months past that, and v2
    speaks the same 2025-era protocol by default, so there is nothing to gain from being early. Revisit
    after 2026-10-12, or sooner if an agent client needs the 2026-07-28 revision (`server/discover`),
    which v1.x cannot serve. Migration notes: low-level `Server` and
    `WebStandardStreamableHTTPServerTransport` both survive in v2, so the hub's shape ports over; the
    manual work is `dbOAuthProvider.ts` / `tokenRefresher.ts` (auth is not covered by the codemod) and
    v2's hard `zod@^4` dependency against our `zod@^3` REST validation.
  - Multi-user modules (`server/src/`): `core/userScope.ts` (user-scoped data access, the only per-user owned-table access), `core/adminView.ts` (the Admin's names-and-counts window), `core/systemView.ts` (cross-user runtime machinery: runnable servers, fan-out, log retention), `core/agentReach.ts` (per-agent reach), `core/users.ts` (users, Default user, sessions), `core/setupCodes.ts` (one-time password setup codes), `cli.ts` (`mcp-switchboard` subcommands: `reset-password`, `login-mode`), `lib/cloudflareAccess.ts` (Access JWT verification).
- `web/` — React 19 + Vite + Tailwind v4 + shadcn-style components, TanStack Query, react-router. Dev server proxies `/api`, `/oauth`, `/mcp` to `:8787`.
- Runtime state (`switchboard.db`, `secret.key`) lives in `~/.config/mcp-switchboard` by default — see `server/src/config.ts` for the `DATA_DIR` > `XDG_CONFIG_HOME` > legacy-`./data` precedence. Never commit it.
- `server/` is the published npm package `@cmer/mcp-switchboard` (root is a private workspace root). `scripts/prepack.mjs` bundles `web/dist` into `server/dist/web`; `npm run build` must run first.
- Detailed design decisions: `/Users/carl/.claude/plans/looks-good-now-create-validated-eclipse.md` (SDK API facts, tricky-parts answers).

## Commands

- `npm run dev` — server (tsx watch, :8787) + Vite (:5173) in parallel
- `npm run build` — web build then server tsc
- `npm start` — production server serving `web/dist`
- `npm test` — vitest in `server/`

## Changelog

Always keep unreleased changes tracked in `CHANGELOG.md` under an `## [Unreleased]` heading —
add the entry as part of the change, not at release time. Follow the existing
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style: `### Added` / `### Changed` /
`### Fixed` subsections, one bullet per user-visible change, bolded lead-in and the *why*
(not just the *what*). Skip only for changes with no user-visible effect (refactors, comments,
internal test churn). On release, rename `[Unreleased]` to the new version with the date.

## Key invariants

- Usernames, server slugs and agent slugs match `^[a-z0-9-]{1,64}$` — **no underscores**, so splitting namespaced tool names on the first `__` is unambiguous.
- Server and agent slugs are unique **per user**. Within one user, own server slugs and accepted-share aliases share one namespace; a clash is rejected. `switchboard` is reserved there.
- Owned tables (`servers`, `agents`, `agent_servers`, `shares`, `server_requests`, `request_logs`, `user_settings`) are queried only through `userScope.ts`, `adminView.ts` or `systemView.ts`; `server/test/ownedTablesGuard.test.ts` enforces it. The user-scoped module is built per request: from the logged-in user for REST, from the agent's owner for MCP.
- `agentReach.ts` is the only path from a tool/prompt/resource name to a server for an agent: the owner's servers plus accepted, enabled shares under their alias, filtered by the matrix and by whether the server is enabled and running. Listing, call/read resolution, lean search, `list_servers`, manager-agent targets and log attribution all go through it.
- The Default user (identified by the `defaultUserId` setting, so a rename doesn't move it) is the sole Admin (`role = admin`), can't be disabled or deleted, and owns the legacy one-segment `/mcp/<agent-slug>` route. Two segments are always `/mcp/<username>/<agent-slug>`.
- Share recipients never see a server's URL, command, env, headers, credentials or stderr, and can't edit, restart or re-share it. Accepting, switching, renaming, revoking or removing a share, and disabling a server or its owner, notify affected live sessions. Revoke collects the affected agents before deleting the share and its matrix rows.
- Stdio servers are never created from a tool call. A user adds one directly only with "can run local commands" (the Admin always can); otherwise it becomes a server request that a person approves. Requests never cross users.
- Disabled users are refused on agent endpoints and their sessions are dropped; reconcile runs a server only if `server.enabled` and its owner is active.
- Setup codes are one-time, expire after 24h and are stored as hashes; the Admin hands them over and never learns a password.
- `request_logs` rows belong to the calling agent's owner, and the live SSE stream goes only to that user's subscribers. Retention pruning stays instance-wide.
- Cloudflare Access mode verifies the JWT with `jose` (RS256, `email` required) on every admin request and never reads `Cf-Access-Authenticated-User-Email`. Agent paths never look at Access headers.
- One shared upstream `Client` per server (keyed by server id), multiplexed across all agents and sessions, including share recipients.
- Agent-facing sessions are in-memory only, keyed by agent id; unknown session id → HTTP 404 (client re-initializes).
- Secrets (env vars, bearer tokens, OAuth tokens) are AES-256-GCM encrypted at rest via `server/src/lib/crypto.ts`; REST responses never include decrypted secrets except agent tokens (needed by the UI for connection snippets).
- OAuth: `DbOAuthProvider.redirectToAuthorization` only captures the URL (never auto-opens); `TokenRefresher` proactively renews at 80% of token lifetime — auth must never go stale.
- Agent-facing OAuth (`server/src/oauth/agentOAuth.ts`, `server/src/http/agentOAuthRoutes.ts`): the switchboard is its own authorization server for `/mcp/<username>/<agent-slug>` (and the legacy `/mcp/<agent-slug>`), mounted beside `/mcp` (on `MCP_PORT` when split — never on the admin listener alone). Consent is a one-time in-memory pairing code from the admin UI, generated through the user-scoped module so each user mints codes only for their own agents, never the admin password or the agent's static token. Agent OAuth tokens/secrets are stored as SHA-256 only. Every error from `/oauth/token` must be JSON `{error}`; unknown clients get 401 `invalid_client` (that's what makes clients re-register).
- `list_changed` notifications fan out to affected live agent sessions on any matrix toggle / server change, including share recipients.
- Lean mode (`agents.tool_mode = 'lean'`) exposes a constant-size meta-tool surface (search/describe/call); upstream tool schemas must never be added to a lean `tools/list`. Its search space is the agent's reach.

## Verification

MCP endpoint smoke test (after `npm run dev`): POST `initialize` to `http://localhost:8787/mcp/<username>/<agent>` with `Authorization: Bearer <token>` and `Accept: application/json, text/event-stream`, capture `mcp-session-id` response header, then `tools/list`. Interactive: `npx @modelcontextprotocol/inspector`.

End any turn that reports on long-running or delegated work with a short status: **Goal**, **Done**, **Next**, **Needs you** (or "nothing").
