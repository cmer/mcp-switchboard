# Changelog

All notable changes to MCP Switchboard are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-07-21

### Added

- **AppSignal server template** (`https://appsignal.com/api/mcp`, HTTP + OAuth). AppSignal's
  authorization-server metadata advertises a `registration_endpoint`, so dynamic client
  registration works and no personal-token fallback is needed.
- The Vite dev server honors `API_PORT` and `WEB_PORT`, so a second, isolated stack can run
  against a scratch `DATA_DIR` without disturbing the usual `npm run dev` instance. Defaults
  are unchanged (8787 / 5173).

### Changed

- **GitHub template now uses a personal access token instead of OAuth.** github.com's
  authorization server does not support dynamic client registration, so third-party clients
  cannot register themselves. The `/oauth/start` error now explains this when a provider
  lacks DCR.

### Fixed

- **Upstream OAuth errors were unreadable.** `@hono/node-server`'s `serve()` replaces the
  global `Response` with its own subclass by default, which broke `instanceof Response` in the
  MCP SDK's OAuth error parser — every upstream error surfaced as `[object Response]` and the
  SDK's credential-retry paths were suppressed. Fixed by passing `overrideGlobalObjects: false`.
- **Servers advertising capabilities they don't implement no longer wedge.** A `-32601`
  Method-not-found from `tools/list`, `prompts/list`, or `resources/list` refresh is now
  tolerated instead of driving an endless connect/backoff loop (seen with the shadcn server).
- **The copy button did nothing over plain HTTP.** `navigator.clipboard` is only exposed in
  secure contexts, so on any non-localhost `http://` host the copy silently failed while still
  showing a "Copied" toast. It now falls back to a hidden textarea plus
  `document.execCommand("copy")`, and the toast reflects the actual result.

## [1.0.0] — 2026-07-21

Initial release.

### Added

- **Server registry** for MCP servers: local `stdio` processes and remote `http` / `sse`
  endpoints, with OAuth, bearer-token, custom-header, or no-auth upstreams.
- **Per-agent endpoints.** Each coding agent connects to its own `/mcp/<agent-slug>` with a
  per-agent bearer token and sees only the servers enabled for it in the switch matrix.
  Tools are namespaced `<server-slug>__<tool>`.
- **One-click template gallery** covering 23 popular MCP servers, plus manual local-command,
  remote-URL, and paste-a-config entry paths.
- **OAuth support** with dynamic client registration, PKCE, and a token refresher that renews
  proactively at 80% of token lifetime so authorization never goes stale.
- **Live `list_changed` notifications** fanned out to affected agent sessions whenever the
  matrix is toggled or a server changes.
- **Encryption at rest** (AES-256-GCM) for env vars, bearer tokens, and OAuth tokens.
- **Admin UI** with password login, 365-day sessions, an optional auth-disable toggle for
  trusted networks, instance naming, and connection snippets per agent.
- **Built-in `switchboard__list_servers` meta-tool.**
- Docker image and GitHub Actions CI (build + test, plus a Docker build and smoke test).

[1.0.1]: https://github.com/cmer/mcp-switchboard/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/cmer/mcp-switchboard/releases/tag/v1.0.0
