# Changelog

All notable changes to MCP Switchboard are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`git` in the Docker image.** stdio MCP servers installed from a `git+https://…` spec (e.g. via
  `pipx run` / `uvx`) failed with `Cannot find command 'git'` because the runtime image only had
  python and pipx. `git` and `ca-certificates` are now installed alongside them.

## [1.4.0] — 2026-08-13

### Added

- **Lean mode per agent.** An agent with 5–10 enabled servers can receive 100+ tool definitions —
  tens of thousands of context tokens paid on every session for schemas it mostly never uses. A new
  per-agent **Tool exposure** toggle (Agents page, default Full) switches an agent to **Lean**: its
  `tools/list` shrinks to a constant-size set of meta-tools — `switchboard__search_tools` (ranked
  lexical search over its enabled catalog), `switchboard__describe_tools` (full descriptions with
  input/output shapes rendered as compact TypeScript instead of JSON Schema), and
  `switchboard__call_tool` (invoke any enabled tool by namespaced name) — so tools are discovered on
  demand via search → describe → call. The switch matrix still governs what is searchable and
  callable, typo'd names come back with suggestions, the Logs page attributes wrapped calls to the
  real upstream tool, and toggling the mode updates live sessions immediately.

- **Agents can register MCP servers themselves.** Discovering a useful server used to mean relaying
  its config to a human to paste into the UI. An agent granted the new **manager** role (a per-agent
  toggle on the Agents page, off by default) gets `switchboard__add_server` — paste the same
  `claude mcp add …` line or `mcpServers` JSON found in a README and the server is created, enabled,
  and its tools appear in the same live session — plus `switchboard__assign_server`,
  `switchboard__list_agents` and `switchboard__server_status` to manage the matrix and self-debug.
  Local stdio servers are the deliberate exception: they execute a command on your machine, so no
  agent can create one directly, whatever its role.

- **A request/approval queue keeps humans in the loop.** Every agent (manager or not) gets
  `switchboard__request_server`: it files the ask — with a pasted config or just a reason — and
  returns immediately. Pending requests show as a badge in the UI with a review panel that renders
  stdio commands in a "this will execute on your machine" warning block; approving one creates the
  server through the same path as the UI and pushes the new tools into the requesting agent's
  still-open session. Denials carry an optional note the agent reads back with
  `switchboard__request_status`. Stored request configs are encrypted at rest like every other
  secret, and a Settings toggle hides the request tools entirely if you'd rather agents couldn't
  ask. Servers created by agents show an "added by" chip for provenance, and because meta-tool
  calls are ordinary MCP requests, every management action lands in the request logs.

### Changed

- **Calls to a server an agent lacks now fail exactly like calls to a server that doesn't exist.**
  The two cases used to return different errors ("not enabled for this agent" vs "unknown server"),
  which let any agent probe which server slugs were configured globally. Both now return the same
  `Unknown server` error, so the switch matrix no longer leaks the existence of servers it hides.

### Fixed

- **Request logs no longer attribute `switchboard__*` meta-tool calls to a phantom "switchboard"
  server.** Management and request meta-tools were logged with `switchboard` as their upstream
  server — a server that doesn't exist — polluting the Logs page's server filter. They now log with
  no upstream server, like the other switchboard-native rows.

## [1.3.0] — 2026-07-31

### Added

- **Oh My Pi connection snippet.** The connect dialog only covered Claude Code, Codex and raw JSON,
  so Oh My Pi users had to hand-translate the URL and token into its `/mcp add` syntax. A fourth tab
  now gives a ready-to-paste slash command.

## [1.2.0] — 2026-07-27

### Added

- **`MCP_PORT` puts the agent endpoint on its own port.** The UI, the REST API and the agent
  endpoint all shared one port, so exposing `/mcp/<agent>` beyond the LAN meant exposing the admin
  UI with it. Set `MCP_PORT` and the same process opens a second listener that serves *only*
  `/mcp/<agent-slug>` — you can then firewall, tunnel or reverse-proxy that port on its own while
  the UI stays on the trusted interface. Both listeners share the same database, upstream
  connections and sessions. `HOST` / `MCP_HOST` bind each listener to a specific interface, and
  `MCP_PUBLIC_URL` overrides the base URL shown in the connection snippets when the endpoint is
  reached through a proxy or tunnel.
- **Request logs.** A new Logs page records every JSON-RPC request an agent sent through the
  switchboard and the response sent back, so "the agent says the tool failed" stops being a
  guessing game. Each request is one line — time, agent, upstream server, tool name, arguments
  preview, duration — that expands to the exact frames on the wire. Filter by agent, by server,
  by method, or by errors / slow (>1s) / in-flight, and search across tool names, summaries and
  error messages. Errors, slow calls and requests still in flight are distinguishable by shape,
  not only colour. Headline counts for the last 24h (volume, error rate, median, p95) sit above
  the list.
- **The log tails live.** New requests appear as they arrive over a server-sent-events stream,
  including long-running calls, which show up as in-flight the moment they start and update in
  place when they finish. Some reverse proxies buffer or drop event streams; when the stream
  can't be established the page falls back to polling and says so.
- **Log retention and payload capture are configurable** in Settings → Logs. Requests are kept
  for 48 hours by default and pruned automatically; shortening the window prunes immediately.
  Full request/response payloads are recorded by default (capped at 32 KB per frame, with the
  true size still reported) — turning capture off keeps the metadata but stores no frames, which
  matters because tool arguments pass through unredacted.

## [1.1.0] — 2026-07-21

### Added

- **Light / dark / system theme switcher.** The dark palette was previously locked to the OS
  `prefers-color-scheme` setting with no way to override it. The choice now persists per
  browser and, in system mode, still follows the OS live. The segmented picker lives in
  Settings → General.
- **Published to npm as `@cmer/mcp-switchboard`, runnable with `npx @cmer/mcp-switchboard`.**
  The package bundles the built UI alongside the compiled server, so trying the switchboard no
  longer requires cloning the repo or installing Docker. Docker remains the better fit for a
  long-running install.

### Changed

- **The data directory now defaults to `~/.config/mcp-switchboard`** (respecting
  `XDG_CONFIG_HOME`) instead of `./data` relative to the working directory. The old default
  meant the switchboard you got depended on which directory you launched it from — harmless
  under Docker, which pins `DATA_DIR`, but a real hazard for `npx`, where it would scatter
  databases and encryption keys across the filesystem. Existing installs keep working: if a
  cwd-relative `data/switchboard.db` is found and the new location is empty, it is used and a
  warning points at the new path. `DATA_DIR` still overrides everything.
- The data directory is now created `0700`. It holds the encryption key and every stored OAuth
  token, and was previously world-readable (the key file itself was already `0600`).

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

[Unreleased]: https://github.com/cmer/mcp-switchboard/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/cmer/mcp-switchboard/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/cmer/mcp-switchboard/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/cmer/mcp-switchboard/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/cmer/mcp-switchboard/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/cmer/mcp-switchboard/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/cmer/mcp-switchboard/releases/tag/v1.0.0
