# MCP Switchboard

Single-user homelab MCP switchboard (npm: `@cmer/mcp-switchboard`): configure MCP servers (local stdio + remote HTTP/SSE/OAuth) once in a web UI; each coding agent (Claude Code, Codex, …) connects to its own endpoint `/mcp/<agent-slug>` with a per-agent bearer token and sees only the servers enabled for it in a per-agent switch matrix. Tools are namespaced `<server-slug>__<tool>`.

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

- Server slugs match `^[a-z0-9-]{1,64}$` — **no underscores**, so splitting namespaced tool names on the first `__` is unambiguous.
- One shared upstream `Client` per server, multiplexed across all agents/sessions.
- Agent-facing sessions are in-memory only; unknown session id → HTTP 404 (client re-initializes).
- Secrets (env vars, bearer tokens, OAuth tokens) are AES-256-GCM encrypted at rest via `server/src/lib/crypto.ts`; REST responses never include decrypted secrets except agent tokens (needed by the UI for connection snippets).
- OAuth: `DbOAuthProvider.redirectToAuthorization` only captures the URL (never auto-opens); `TokenRefresher` proactively renews at 80% of token lifetime — auth must never go stale.
- `list_changed` notifications fan out to affected live agent sessions on any matrix toggle / server change.
- Lean mode (`agents.tool_mode = 'lean'`) exposes a constant-size meta-tool surface (search/describe/call); upstream tool schemas must never be added to a lean `tools/list`.

## Verification

MCP endpoint smoke test (after `npm run dev`): POST `initialize` to `http://localhost:8787/mcp/<agent>` with `Authorization: Bearer <token>` and `Accept: application/json, text/event-stream`, capture `mcp-session-id` response header, then `tools/list`. Interactive: `npx @modelcontextprotocol/inspector`.
