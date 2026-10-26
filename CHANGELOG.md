# Changelog

All notable changes to MCP Switchboard are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`${VAR}` in a local server's arguments is filled in from its environment variables** when the
  server starts, so a tool that takes a license key or email on the command line
  (`EMAIL=${EMAIL}`) can keep it in the encrypted env vars instead of in plain-text arguments.
  It's the same syntax Claude Code's `.mcp.json` uses, so pasted configs work as-is.
  `${VAR:-fallback}` covers an unset variable and `$${VAR}` stays literal. Only the server's own
  env vars are used, never the switchboard's. A missing one stops the server with an error naming
  it, rather than quietly passing an empty string.

### Changed

- **Editing a server shows its stored env vars and headers as masked lines** (`EMAIL=••••••••`)
  instead of an empty box, which made saved values look lost. A line left masked keeps its stored
  value, typing over the mask replaces it, and deleting the line removes it, so adding one
  variable no longer wipes the others. Editing a server request works the same way: a stored
  value is now kept by leaving it masked, not by blanking it.

## [2.0.0] — 2026-10-25

This is **2.0.0**: the switchboard becomes multi-user. Nothing about an existing install has to be redone, but the upgrade is one-way, so read "Upgrading from 1.x" first.

### Upgrading from 1.x

On first start, 2.0 copies `switchboard.db` to `switchboard.db.pre-multiuser` (in the same data
directory) before it changes anything, then gives everything you already have to a new user named
`admin`. Sign in as `admin` with the same password as before. Every agent URL and token keeps working,
including OAuth connections made through Claude Desktop or claude.ai; the connection snippets now show
the new form, `/mcp/admin/<agent>`, but `/mcp/<agent>` is still answered. To roll back, stop the
switchboard, restore `switchboard.db.pre-multiuser` as `switchboard.db`, and reinstall 1.6.x. Anything
you changed after upgrading is lost.

If you had sign-in turned off, it is now always on: sign in as `admin` with your old password, or
reset it with `mcp-switchboard reset-password admin` (Docker:
`docker compose exec switchboard node dist/index.js reset-password admin`). The first start after
upgrading prints a line saying so.

### Added

- **Users, and an Admin to manage them.** One household can now share one switchboard. The `admin`
  user (the Default user: it owns everything from before the upgrade and can't be disabled or deleted)
  is the Admin and gets a **Users** page to create, rename, disable and delete users and set their
  emails. There is exactly one Admin; the only power that can be delegated is running local commands.
- **Setup codes instead of shared passwords.** Creating a user, or resetting their password, produces a
  one-time code (valid 24 hours). The person enters it under **I have a setup code** on the login page
  and chooses their own password, so the Admin never knows anyone's password and there is nothing to
  email around.
- **Everything a user owns is private.** Servers, agents, the switch matrix, request logs, server
  requests and settings belong to one user and are invisible to the others, including in the live log
  stream. The Admin sees names and counts on the Users page, never contents. Isolation is enforced in a
  single data-access layer with a test that fails if any route goes around it, because a missed check
  in 70 scattered queries is how multi-user bugs happen.
- **Per-user agent URLs.** Agents connect at `/mcp/<username>/<agent>`, so two users can both have an
  agent called `claude`. A wrong username, a wrong agent, a wrong token and a disabled user all get the
  same 401, so the endpoint doesn't reveal which usernames exist. The agent OAuth metadata accepts both
  URL forms and echoes back the one that was asked for.
- **Share a server with another user.** Share a server from the Servers page and the recipient accepts
  it under an alias (suggested as `<owner>-<slug>`, editable). Their agents use your live connection
  and your credentials, so there is one OAuth login and one running process, not a copy; they see its
  name, description, status and tools under the alias, never its URL, command, headers or stderr. The
  recipient switches it on per agent, can switch it off for all their agents, rename or remove it, and
  the owner can revoke at any time, which takes effect immediately and notifies live sessions. The
  owner sees per-person usage counts and last use. Aliases share a namespace with the recipient's own
  server names, so a clash is rejected rather than silently shadowing a tool.
- **"Can run local commands" permission, with escalation.** A stdio server runs a program on the host,
  and a local command can read `secret.key`, so adding one directly now needs this permission, which
  only the Admin can grant. Without it, pasting or adding a stdio server files a request that the Admin
  approves; the Admin sees the user, agent, reason, command, arguments and environment variable
  *names*, and approving creates the server owned by the requester. Agents can't create stdio servers
  from a tool call at all. Granting the permission is an accepted trust boundary: a user who has it can
  read every secret on the host.
- **Sign in with Cloudflare Access.** The Admin can switch the instance from passwords to Cloudflare
  Access (team domain and AUD tag(s) in Settings). The switchboard verifies the Access JWT on every
  admin request and matches its email to a user; it never trusts the unsigned email header, refuses
  service tokens, and creates no users on its own. Switching on is only accepted from a request that
  carries a valid Access token for the Admin's own email, so a typo can't lock everyone out. Agent
  paths never look at Access headers. See the new [Cloudflare Access guide](docs/cloudflare-access.md),
  including the Bypass application agents need.
- **Command-line recovery and setup.** `mcp-switchboard reset-password <username>` and
  `mcp-switchboard login-mode password` repair a lost password or a broken Access setup from the host,
  while the server is running or not. Before this, the binary only started the server and had no way
  back in. `status` and `user list` (both with `--json`) show what state the install is in, `user email`
  sets or clears a user's email, and `login-mode cloudflare --team-domain … --aud …` switches to
  Cloudflare Access from the shell, so scripts and skills can set it up with values taken straight from
  Cloudflare. It keeps the Settings guards (a password and an email on the Default user) but skips the
  live-token check, which needs a browser. See [Recovering access](docs/recovering-access.md) and
  [Command line](docs/configuration.md#command-line) for the npx and Docker forms. Pointed at a 1.x
  database, every subcommand refuses and says to start the 2.0 server first: `npx` fetches the latest
  CLI, and upgrading the database under a 1.x server that is still running would break it.
- **Per-user settings.** Auto-enable new servers, allow server requests and payload capture now belong
  to each user and apply to their own servers and agents only. They are in **Settings, Yours**;
  instance-wide settings are in **Settings, Instance** (Admin only).
- **Manager agents and `list_servers` know about shares.** Received shares appear under their alias
  with `sharedBy`. Manager agents can only list and manage their own owner's agents and servers, can
  switch on shares by alias but not accept or modify them, and see status and counts, never stderr, for
  a shared server.
- **Claude Code skills for installing and exposing the switchboard.** `switchboard-install` sets up
  a fresh Debian or Ubuntu VM (locally or over SSH): Docker, a release checkout, host networking so
  local servers reach the LAN like the machine does, and a generated Admin password.
  `switchboard-cloudflare-access` reads an existing install first, then sets up the Access applications,
  policies, and optionally the tunnel and DNS with Cloudflare's `cf` CLI. It also updates the
  switchboard's environment, sets user emails, and switches it to Access sign-in, rolling back if you
  can't get in. Both show the full plan and change nothing until you confirm, because the Bypass rules
  and env changes are easy to get subtly wrong by hand. Run them once from their GitHub URL; nothing
  gets installed.
- **Guides in `docs/`.** Configuration, reverse proxy and HTTPS, Claude Desktop, Cloudflare Access,
  recovering access and lean mode each have their own page.

### Changed

- **The README is a short landing page.** npm shows only the README, and at 230 lines it buried the
  quick start. Configuration, reverse-proxy and Claude connector detail moved to `docs/` and the
  README links to them.
- **Login asks for a username.** The login page takes a username and password (plus the setup-code
  path) instead of a lone admin password. A fresh install's first-run screen sets the password for
  `admin`.
- **Connection snippets show `/mcp/<username>/<agent>`.** The one-segment form still works but is no
  longer advertised.
- **Request logs record who and which server.** Each row carries the calling user and the server
  reached, so owners see only their own traffic, and a shared server's usage is counted without
  exposing the recipient's payloads to the owner.
- **Disabling a user stops their servers and drops their agents' sessions.** Recipients of their shares
  see the share as Unavailable until the user is enabled again.
- **Cloudflare Access needs an Admin password first.** Switching to Access, or back to password
  sign-in, is refused while the Admin has no password: it is the way back in if Access ever locks
  you out, and first-run setup is only offered while the Admin is the sole user.

### Removed

- **Turning sign-in off.** The "Require sign-in" switch in Settings and the `authDisabled` setting are
  gone. With several users there is no way to know who you are, and sessions already last a year, so
  sign-in is always required. An install that had it off keeps working after you sign in again (see
  "Upgrading from 1.x"); `POST /api/auth/settings` ignores an `authDisabled` key.

## [1.6.0] — 2026-10-25

### Added

- **Edit a server request before approving it.** Agents often can't send everything a server
  needs, like a licence key they were told not to pass along, so a request used to be all or
  nothing. Pending requests now have an **Edit** button for the name, slug, command, arguments
  and env vars (URL, transport and auth for remote servers). Secret values the agent sent stay
  hidden. Their keys show up as `KEY=` lines, where a blank value keeps the agent's value. The
  *This will execute on your machine* block updates as you type, so it always shows what will
  actually run. Edits apply only to the approval, and `request_status` still shows the agent
  what it asked for.

## [1.5.2] — 2026-10-11

### Fixed

- **SSE servers that retired the legacy transport.** Cloudflare's MCP servers (and others moving
  off HTTP+SSE) now answer the SSE stream with 410 Gone, which left the server stuck on
  "Unreachable · Non-200 status code (410)" and gave no hint about the fix. When an SSE server
  refuses the stream (404/405/410), the switchboard now retries Streamable HTTP at the same URL
  and switches the server to HTTP once that connects. OAuth servers go to *Needs auth* as usual.
  If HTTP fails too, the error says to change the transport and URL (usually `/sse` → `/mcp`).

## [1.5.1] — 2026-10-08

### Fixed

- **Claude connectors behind chained proxies.** Behind Cloudflare → Caddy (or any proxy hop that
  speaks plain HTTP), the agent OAuth metadata advertised `http://` URLs, because the inner proxy
  reports its own scheme, and Claude refused to sign in. A `PUBLIC_URL` that is `https://` now
  settles the scheme for requests to its own host, so the common one-hostname setup works without
  also setting `MCP_PUBLIC_URL`.

### Changed

- **Clearer env var docs.** The README now splits the variables into the admin UI's and the agent
  endpoint's, spells out which OAuth direction `PUBLIC_URL` and `MCP_PUBLIC_URL` each serve, lists
  typical setups, and adds a *Behind a reverse proxy* section with a `curl` check for the metadata
  Claude reads. The Claude connector steps now match the current dialog (full `/mcp/<slug>` URL,
  dynamic registration, CIMD unsupported).

## [1.5.0] — 2026-10-07

### Added

- **OAuth for agents — connect Claude Desktop and claude.ai.** Custom connectors in Claude Desktop
  and claude.ai can't send a static `Authorization` header, so they couldn't reach
  `/mcp/<agent-slug>` at all. The switchboard is now its own OAuth 2.1 authorization server for its
  agent endpoints (protected-resource and authorization-server metadata, dynamic client
  registration, PKCE, refresh-token rotation): paste the agent's endpoint URL into **Add custom
  connector** and approve the connection with a one-time **pairing code** generated on the Agents
  page. Pairing codes keep the agent's long-lived token off a web page anyone can link to. Approved
  clients are listed per agent under **OAuth connections** and can be revoked; static bearer tokens
  keep working unchanged. The endpoint must be reachable over public HTTPS, since Claude's
  connectors connect from Anthropic's cloud.
- **CORS on `/mcp/<agent-slug>`**, so browser-based clients such as MCP Inspector can read the
  session id and the OAuth challenge.

## [1.4.3] — 2026-09-11

### Fixed

- **OAuth no longer breaks for good when `PUBLIC_URL` changes.** A dynamically registered OAuth
  client is bound to the redirect URI it was registered with, so after `PUBLIC_URL` changed the
  stored registration kept sending the old URI and providers rejected every attempt with
  "Invalid redirect URI … does not match any registered URI for this client" (Linear's wording) —
  with no way out from the UI. A registration whose redirect URI no longer matches is now discarded
  and re-created on the next authorization, and a redirect-URI error explains that the provider
  wants an https or loopback `PUBLIC_URL`.

## [1.4.2] — 2026-08-14

### Fixed

- **Idle agent sessions are less likely to be dropped by a reverse proxy.** The MCP SDK was updated
  to 1.30.0, whose Streamable HTTP server transport now emits SSE keep-alive comment frames (and
  fixes the keep-alive timer's lifecycle) — an agent that sits idle between tool calls no longer
  looks like a dead connection to an intermediary that times out silent streams, which showed up as
  a session vanishing mid-conversation. The same bump tightens `Content-Type` validation to parse
  the media type instead of substring-matching it, and bounds the read buffer for stdio servers that
  emit very large responses.

## [1.4.1] — 2026-08-14

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

[Unreleased]: https://github.com/cmer/mcp-switchboard/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/cmer/mcp-switchboard/compare/v1.6.0...v2.0.0
[1.6.0]: https://github.com/cmer/mcp-switchboard/compare/v1.5.2...v1.6.0
[1.5.2]: https://github.com/cmer/mcp-switchboard/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/cmer/mcp-switchboard/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/cmer/mcp-switchboard/compare/v1.4.3...v1.5.0
[1.4.3]: https://github.com/cmer/mcp-switchboard/compare/v1.4.2...v1.4.3
[1.4.2]: https://github.com/cmer/mcp-switchboard/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/cmer/mcp-switchboard/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/cmer/mcp-switchboard/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/cmer/mcp-switchboard/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/cmer/mcp-switchboard/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/cmer/mcp-switchboard/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/cmer/mcp-switchboard/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/cmer/mcp-switchboard/releases/tag/v1.0.0
