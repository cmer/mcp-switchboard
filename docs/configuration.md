# Configuration

Everything is configured with environment variables, set before the switchboard starts. With
nothing set, it listens on `http://localhost:8787` and keeps its state in `~/.config/mcp-switchboard`.

Instance-wide options that change at runtime (instance name, login mode, log retention) are in the
Admin's **Settings → Instance** section, not here. Each user's own options (auto-enable new servers,
server requests, payload capture) are in **Settings → Yours**.

## Which URL is which

The switchboard talks OAuth in two directions, and each direction has its own URL:

- **Upstream OAuth**: the switchboard signing in *to* Linear, Xero, Stripe and so on, through your
  browser. The provider redirects your browser back to `PUBLIC_URL`.
- **Agent OAuth**: Claude Desktop or claude.ai signing in *to* the switchboard. Claude's cloud
  reaches the agent endpoint, and the metadata it reads must name that endpoint's public origin
  (`MCP_PUBLIC_URL`, or the request itself when unset).

## The UI, the API and upstream servers

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Port for the UI and REST API. Also serves `/mcp/...` unless `MCP_PORT` is set. |
| `HOST` | all interfaces | Interface the UI/API listener binds to. |
| `PUBLIC_URL` | `http://localhost:8787` | The URL **you open the UI at in your browser**. Upstream OAuth redirect URIs are built from it (`<PUBLIC_URL>/oauth/callback`). Agents don't use it, with one exception: when it is `https://`, a request for that same host is treated as TLS even if a proxy hop says otherwise. |
| `DATA_DIR` | see below | Where the SQLite database and encryption key live. The Docker image sets it to `/app/data`. |

## The agent endpoint (`/mcp/<username>/<agent>`)

| Env var | Default | Purpose |
| --- | --- | --- |
| `MCP_PORT` | unset (shares `PORT`) | Serve the agent endpoint on its own port. See [Reverse proxy](reverse-proxy.md#splitting-the-agent-endpoint-onto-its-own-port). |
| `MCP_HOST` | `HOST` | Interface the MCP listener binds to. |
| `MCP_PUBLIC_URL` | derived | The origin **agents use to reach `/mcp/...`**, without the path. It feeds the connection snippets in the UI (unset: the UI's own origin, or `PUBLIC_URL` with the port swapped when `MCP_PORT` is set) and the agent OAuth metadata (unset: taken from each request). Set it whenever agents come in through a proxy or tunnel. |

Other settings in the Docker image: `WEB_DIST` (where the built UI is served from; you shouldn't need
to touch it) and `NODE_ENV=production`.

## Typical setups

| Setup | Set |
| --- | --- |
| Everything on localhost | nothing |
| LAN only, plain HTTP | `PUBLIC_URL=http://192.168.1.10:8787` (and read [OAuth over plain HTTP](reverse-proxy.md#oauth-over-plain-http)) |
| One HTTPS hostname for UI and agents | `PUBLIC_URL=https://sb.example.com`. Add `MCP_PUBLIC_URL` with the same value if the [metadata check](reverse-proxy.md#checking-what-claude-will-see) fails. |
| UI on the LAN or tailnet, agents through a public tunnel | `PUBLIC_URL=<what you open in the browser>`, `MCP_PUBLIC_URL=https://<public-host>` |

## Data directory

The data directory holds `switchboard.db` and `secret.key` (created `0700`). The location is the first
of these that applies:

1. `DATA_DIR`, if set.
2. `$XDG_CONFIG_HOME/mcp-switchboard`, or `~/.config/mcp-switchboard` when `XDG_CONFIG_HOME` is unset,
   if `switchboard.db` already exists there.
3. `./data` in the current directory, if `switchboard.db` exists there. This is where releases up to
   1.0.1 kept it; the switchboard logs a warning and keeps using it so those installs don't start
   from an empty database. Move it to the location in step 2.
4. Otherwise `$XDG_CONFIG_HOME/mcp-switchboard` (or `~/.config/mcp-switchboard`) is created.

**Backups:** copy the whole directory. The database is useless without `secret.key`, because secrets
(environment variables, bearer tokens, OAuth tokens) are encrypted at rest with AES-256-GCM using that key.

When you upgrade from 1.x, the first start of 2.0 also writes `switchboard.db.pre-multiuser` into this
directory. See [the changelog](../CHANGELOG.md) for what it's for.

## Command line

The binary also runs a few subcommands that inspect and repair an install from the host. They open the
same data directory as the server (`DATA_DIR`), never start it, and are safe to run while it is running.
Shell access to the machine already means full access to the data, so they need no login.

Run each as `npx @cmer/mcp-switchboard <subcommand>` (a global install: `mcp-switchboard <subcommand>`), or in
Docker as `docker compose exec switchboard node dist/index.js <subcommand>` (add `-T` when piping stdin).

| Subcommand | What it does |
| --- | --- |
| `status [--json]` | Shows the version, data directory, login mode, Access team domain and AUD tags, user count, and whether the Default user has a password and an email. |
| `user list [--json]` | One line per user: username, role, email, password yes/no, disabled yes/no, default yes/no. Never prints hashes or setup codes. |
| `user email <username> <email>` | Sets a user's email, with the same checks as the Users page (valid address, unique ignoring case). |
| `user email <username> --clear` | Removes a user's email. |
| `reset-password <username> [--password-stdin]` | Sets a password and signs that user out. Prompts without echo, or reads stdin with `--password-stdin`. |
| `login-mode password` | Switches back to password login. |
| `login-mode cloudflare --team-domain <team>.cloudflareaccess.com --aud <tag> [--aud <tag> ...]` | Stores the [Cloudflare Access](cloudflare-access.md) config, switches to Access login and signs everyone out. Needs a password and an email on the Default user. |
| `--help` | Prints the usage text. |

See [Recovering access](recovering-access.md) for when to use them.
