# MCP Switchboard

Single-user homelab MCP switchboard (npm: `@cmer/mcp-switchboard`): configure MCP servers (local stdio + remote HTTP/SSE/OAuth) once in a web UI; each coding agent (Claude Code, Codex, …) connects to its own endpoint `/mcp/<agent-slug>` with a per-agent bearer token and sees only the servers enabled for it in a per-agent switch matrix. Tools are namespaced `<server-slug>__<tool>`.

## Layout

- `server/` — Node 20+ TypeScript, Hono, `@modelcontextprotocol/sdk` **v1.x** (do NOT upgrade to v2 beta), better-sqlite3 + Drizzle, ESM (`.js` import suffixes required).
- `web/` — React 19 + Vite + Tailwind v4 + shadcn-style components, TanStack Query, react-router. Dev server proxies `/api`, `/oauth`, `/mcp` to `:8787`.
- `data/` — gitignored runtime state: `switchboard.db` (SQLite), `secret.key` (AES-256-GCM key). Never commit.
- Detailed design decisions: `/Users/carl/.claude/plans/looks-good-now-create-validated-eclipse.md` (SDK API facts, tricky-parts answers).

## Commands

- `npm run dev` — server (tsx watch, :8787) + Vite (:5173) in parallel
- `npm run build` — web build then server tsc
- `npm start` — production server serving `web/dist`
- `npm test` — vitest in `server/`

## Key invariants

- Server slugs match `^[a-z0-9-]{1,64}$` — **no underscores**, so splitting namespaced tool names on the first `__` is unambiguous.
- One shared upstream `Client` per server, multiplexed across all agents/sessions.
- Agent-facing sessions are in-memory only; unknown session id → HTTP 404 (client re-initializes).
- Secrets (env vars, bearer tokens, OAuth tokens) are AES-256-GCM encrypted at rest via `server/src/lib/crypto.ts`; REST responses never include decrypted secrets except agent tokens (needed by the UI for connection snippets).
- OAuth: `DbOAuthProvider.redirectToAuthorization` only captures the URL (never auto-opens); `TokenRefresher` proactively renews at 80% of token lifetime — auth must never go stale.
- `list_changed` notifications fan out to affected live agent sessions on any matrix toggle / server change.

## Verification

MCP endpoint smoke test (after `npm run dev`): POST `initialize` to `http://localhost:8787/mcp/<agent>` with `Authorization: Bearer <token>` and `Accept: application/json, text/event-stream`, capture `mcp-session-id` response header, then `tools/list`. Interactive: `npx @modelcontextprotocol/inspector`.
