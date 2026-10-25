---
name: switchboard-cloudflare-access
description: Put an existing MCP Switchboard install behind Cloudflare Access with the `cf` CLI, optionally creating the Cloudflare Tunnel and DNS records, and update the switchboard to match. Use when the user wants Cloudflare Access sign-in for the switchboard, or to expose it through a Cloudflare Tunnel.
---

# Configure Cloudflare Access for MCP Switchboard

Takes an installed switchboard and puts it behind Cloudflare Access, end to end:

1. reads how the install is set up today
2. asks only what it can't work out
3. creates the Access applications and policies, and optionally the tunnel and DNS
4. updates the switchboard's environment and restarts it
5. sets user emails, then switches the switchboard to Access sign-in, rolling back if the user can't
   get in

The run is **discover, plan, confirm, apply**. Before the user approves the plan, only login and
read-only lookups run. The manual version of all this is
https://github.com/cmer/mcp-switchboard/blob/main/docs/cloudflare-access.md.

## Ground rules

- **Two places.** `cf` runs where Claude Code runs, because its login wants a browser. Everything
  about the switchboard runs on the **target**: this machine or an SSH host. Write `on-target <cmd>`
  for "run it there": locally, or as `ssh <host> '<cmd>'`.
- **The switchboard CLI** is written `sb <args>` below. Discovery tells you which form to use:
  - Docker Compose: `docker compose exec -T <service> node dist/index.js <args>`, run in the project
    directory
  - systemd or a bare process: the same executable its `ExecStart` or command line uses, plus
    `<args>`, with the same `DATA_DIR`. Never a fresh `npx` download, which could be a different
    version.

  `sb status --json` and `sb user list --json` read state. `sb user email`, `sb login-mode` and
  `sb reset-password … --password-stdin` change it. `sb --help` lists them all.
- **`cf`** is Cloudflare's CLI, run as `npx -y cf@latest …` and written `cf` below. It is in beta.
  - If a command has moved, find it with `cf cli search "<what you want to do>"`. Keep those queries
    anonymous: describe the action and resource type only, never a hostname, email, account or id.
  - Every write passes raw JSON in `--body '<json>'`. Run with `--dry-run` when you're unsure of a
    request's shape.
  - Responses are JSON. Read ids from them, under `result` if present.
  - Once the account is chosen, `export CLOUDFLARE_ACCOUNT_ID=<id>` for every `cf` call.
- **Questions** use the AskUserQuestion tool. Free-text answers come back through its built-in "Other"
  option. Offer what discovery found as the options, and mark the current value "(current)".
- **Secrets:** the tunnel token and any generated password go straight into `0600` files on the
  target. Never print them.
- **Companion skills.** The switchboard's skills live side by side at
  `https://raw.githubusercontent.com/cmer/mcp-switchboard/<ref>/.claude/skills/<name>/SKILL.md`:
  - `switchboard-install`: set up a fresh machine
  - `switchboard-cloudflare-access`: put an install behind Cloudflare Access

  When a step needs one, invoke it with the Skill tool if it's available. Otherwise fetch its
  `SKILL.md` and follow it. Use the same `<ref>` as this skill. If this skill was read from such a URL,
  take the ref from that URL; otherwise use `main`. That way a run started from a release tag fetches
  its companions from the same release. Pass along everything already learned, so the companion
  skips steps it doesn't need.
- **Backups:** before editing any file on the target, copy it to `<file>.bak-<timestamp>`.

## The two paths

| | Separate agent hostname (Recommended) | One hostname |
|---|---|---|
| Hostnames | `UI_HOST` (UI only), `AGENT_HOST` (agents only) | `UI_HOST` serves the UI and agents |
| Access | Allow app on `UI_HOST`. `AGENT_HOST` gets **no** Access app | Allow app on `UI_HOST`, plus a Bypass app on `UI_HOST`'s agent paths |
| Origins | `UI_HOST` → UI port (8787), `AGENT_HOST` → `MCP_PORT` (8788) | `UI_HOST` → UI port |
| Switchboard env | `PUBLIC_URL=https://UI_HOST`, `MCP_PORT=8788`, `MCP_PUBLIC_URL=https://AGENT_HOST` | `PUBLIC_URL=https://UI_HOST`, `MCP_PUBLIC_URL=https://UI_HOST` |

The separate path needs no Bypass rules, because the `MCP_PORT` listener serves only `/mcp/*`, the
agent OAuth routes and `/.well-known/*`.

**Bypass destinations (one-hostname path only).** Use exactly these six. Never `/oauth/*` or
`/oauth/callback`: that callback identifies the user by their Access token, which a bypassed path
doesn't carry.

```
UI_HOST/mcp/*  UI_HOST/.well-known/*  UI_HOST/oauth/register
UI_HOST/oauth/token  UI_HOST/oauth/revoke  UI_HOST/oauth/authorize
```

## Step 1: Find the install

Skip this step if `switchboard-install` handed you the target and layout. Still run item 4 to read the state.

1. Ask where the switchboard runs: "This machine", or an SSH host typed into "Other". Check that
   `ssh <host> true` works without a prompt.
2. Locate it on the target, first match wins:
   - **Docker Compose:** `docker ps --format '{{.Names}} {{.Image}}'`, looking for a switchboard
     container. Read its labels `com.docker.compose.project.working_dir` and
     `com.docker.compose.service`.
   - **systemd:** `systemctl list-units --type=service | grep -i switchboard`, then read the unit file
     and its `EnvironmentFile`.
   - **A bare process:** `pgrep -af mcp-switchboard`.
   - Nothing found: ask whether to install it first. If yes, hand over to the companion
     `switchboard-install`, which comes back here when it's done.
3. Read the configuration. Edit nothing.
   - **Compose:** `docker compose config` in the project directory gives the merged effective config.
     Also read `.env`, and note which of `compose.yml`, `docker-compose.yml` and
     `compose.override.yml` exist.
   - **systemd:** the unit and its `EnvironmentFile`.
   - From these, record:
     - the env values `PUBLIC_URL`, `MCP_PUBLIC_URL`, `MCP_PORT`, `HOST`, `PORT`
     - whether the service uses `network_mode: host`, plus its published ports and network name
     - any reverse proxy (Caddy, nginx, Traefik) and the hostnames it serves
     - any existing `cloudflared` (a Compose service, `systemctl status cloudflared`, or
       `/etc/cloudflared/config.yml`), and whether it uses a token (remote config) or a local
       config file
4. Read the switchboard's state: `sb status --json` and `sb user list --json`. Get the login mode,
   the Access config if any, whether the Default user has a password and email, and the users.

Done when: you know the install type, the project directory or unit, the current env values, how
traffic reaches it today, and the switchboard's state.

## Step 2: Cloudflare login and discovery

1. Check `npx -y cf@latest --version`. Then `cf auth whoami`. If not logged in, say a browser sign-in
   is next and run `cf auth login`. Headless: use `--no-browser` and relay the link and code.
2. Pick the account (`cf accounts list`; ask if there's more than one) and export
   `CLOUDFLARE_ACCOUNT_ID`.
3. `cf zero-trust organization get`: record `auth_domain` as the **team domain**. If it's missing, Zero
   Trust isn't set up. Tell the user to enable it in the dashboard (Zero Trust, pick a team name, Free
   plan), then stop.
4. Read-only lookups:
   - `cf zones list --status active`
   - `cf tunnels list`: keep tunnels that aren't deleted, with each one's `config_src`
   - `cf zero-trust access applications list`
   - for any hostname found in Step 1, `cf dns records list -z <zone-id> --name <host>`, to see
     whether it exists and is `proxied`

## Step 3: Ask

Ask only what discovery didn't settle, and pre-fill from it. A `PUBLIC_URL` of
`https://switchboard.example.com` makes that hostname the "(current)" option, for example.

**First AskUserQuestion call:**

1. **Path:** "Separate agent hostname (Recommended)" or "One hostname". If `MCP_PORT` is already set,
   note that.
2. **UI hostname:** the current one (if it's on an active zone), `switchboard.<zone>`, and "Other". This
   also fixes the zone.
3. **Who signs in:** offer each switchboard user's email that's already set, "Only `<cf whoami email>`",
   or "Other" for a comma-separated list. For an email domain, use `@domain`.
4. **How traffic reaches it:**
   - "New Cloudflare Tunnel (Recommended)"
   - "Existing tunnel `<name>`" (remotely managed only)
   - "It's already proxied by Cloudflare (orange-cloud DNS to a public origin)". Offer this only if
     Step 2 found a proxied record for the hostname.

**Second AskUserQuestion call, if needed:**

5. **Agent hostname** (separate path): the current `MCP_PUBLIC_URL` host, `mcp.<zone>`, and "Other".
6. **Email to user mapping:** for every sign-in email that matches no switchboard user's email, ask which
   user it belongs to. The options are users without an email, plus "Nobody yet (Access lets them in,
   the switchboard refuses them)". The Admin's own email must map to the Default user.
7. **Admin password,** only if `sb status` shows the Default user has none: "Generate one (Recommended)"
   or "I'll run `reset-password` myself first" (then stop). The password is the way back in if Access
   ever locks everyone out.

**Origins are worked out from Step 1, not asked:**

- `cloudflared` as a Compose service on the switchboard's network: `http://<service>:8787` and `:8788`.
- `network_mode: host`, or `cloudflared` running natively: `http://localhost:8787` and `:8788`.
- Only if the layout is unusual, ask with "Other".

## Step 4: Plan and confirm

Lay out everything, in apply order, grouped as below.

- **Cloudflare:** each `cf` command with its exact body (see Step 5). For an existing tunnel, show the
  merged ingress list.
- **Target files:** a diff of each file you'll edit:
  - `.env` keys, or the unit's `EnvironmentFile`
  - the Compose override: add `env_file: .env` if `MCP_PORT`/`MCP_PUBLIC_URL` wouldn't otherwise reach
    the container; add a `cloudflared` service; for the separate path without host networking,
    publish `8788` only if something outside Compose needs it
  - the restart command
- **Switchboard:** each `sb user email …`, a generated Admin password if any, then
  `sb login-mode cloudflare …`.
- **Consequences to call out:**
  - If `PUBLIC_URL` changes, upstream servers that use OAuth may need re-authorizing from the Servers
    page, because their registered redirect URL changes.
  - If the agent URL changes (`MCP_PUBLIC_URL`), every agent must be reconnected with its new snippet,
    and Claude connectors re-paired.
  - Existing switchboard sessions end when Access sign-in turns on.
- **Conflicts:**
  - an Access app already covering a hostname: reuse it, or stop
  - a DNS record that already exists: replace it only if the user agrees
  - a hostname routed by another tunnel
  - a reverse proxy already serving the hostname

Ask **"Apply this plan?"** with "Apply", "Change an answer" (back to Step 3) and "Cancel". Make no
changes until the answer is "Apply".

## Step 5: Apply

Record every id as you go.

**Cloudflare**

1. **Allow policy.** `cf zero-trust access policies create --body`:
   `{"name":"MCP Switchboard – people","decision":"allow","include":[{"email":{"email":"a@x.com"}}]}`
   Use one `email` object per person, or `{"email_domain":{"domain":"x.com"}}` for a domain.
2. **Bypass policy** (one-hostname path only):
   `{"name":"MCP Switchboard – agents","decision":"bypass","include":[{"everyone":{}}]}`
3. **UI app.** `cf zero-trust access applications create --body`:
   `{"type":"self_hosted","name":"MCP Switchboard","domain":"UI_HOST","destinations":[{"type":"public","uri":"UI_HOST"}],"policies":[{"id":"<allow-id>","precedence":1}],"oauth_configuration":{"enabled":false}}`
   Record its `aud`. The `oauth_configuration` field keeps Access's Managed OAuth off; Managed OAuth
   would take over the switchboard's own agent OAuth. If the API rejects the field, drop it and say
   so: Managed OAuth is opt-in for self-hosted apps.
4. **Bypass app** (one-hostname path only):
   `{"type":"self_hosted","name":"MCP Switchboard – agent endpoints","domain":"UI_HOST/mcp/*","destinations":[<the six, each {"type":"public","uri":…}>],"policies":[{"id":"<bypass-id>","precedence":1}],"oauth_configuration":{"enabled":false},"app_launcher_visible":false}`
5. **Tunnel.**
   - New: `cf tunnels create --body '{"name":"mcp-switchboard","config_src":"cloudflare"}'`.
   - Existing: start from `cf tunnels config get <id>`.
6. **Ingress.** `cf tunnels config update <id> --body '{"config":{"ingress":[…]}}'`. This **replaces**
   the whole config, so build the list as:
   - the existing rules, minus any old rules for these hostnames
   - the new hostname-to-origin rules
   - exactly one catch-all, last: `{"service":"http_status:404"}`
7. **DNS,** per hostname, through a tunnel:
   `cf dns records create -z <zone-id> --body '{"type":"CNAME","name":"<host>","content":"<tunnel-id>.cfargotunnel.com","proxied":true}'`
8. **Tunnel token:** `cf tunnels token get <id>`. Pipe the value straight into the target without
   echoing it. For Compose, that's `CLOUDFLARED_TOKEN=` in `.env` (0600). For systemd, a 0600 file
   for `cloudflared service install`.

**Target**

9. Back up, then edit the env file(s) and the Compose override as planned. For Compose, the
   `cloudflared` service:
   ```yaml
     cloudflared:
       image: cloudflare/cloudflared:latest
       command: tunnel --no-autoupdate run
       environment:
         - TUNNEL_TOKEN=${CLOUDFLARED_TOKEN}
       restart: unless-stopped
   ```
   Add `network_mode: host` to it when the switchboard uses host networking. Natively, with
   `cloudflared` installed: `cloudflared service install <token>`.
10. Restart: `docker compose up -d` in the project directory, or `systemctl restart <unit>`. Wait
    until `sb status` answers.

**Verify the edge** (retry for about two minutes while DNS and the tunnel settle):

11. `curl -sI https://UI_HOST/` gives a 302 to `<team domain>`.
12. `curl -s https://AGENT_HOST/.well-known/oauth-protected-resource/mcp/x/y` gives JSON with
    `"resource"`, not a redirect. On the one-hostname path `AGENT_HOST` is `UI_HOST`, and this proves
    the Bypass app wins. If it redirects, stop before touching the login mode and suggest the separate
    path.
13. `curl -s -o /dev/null -w '%{http_code}' -X POST https://AGENT_HOST/mcp/x/y` gives `401`.

**Switch the switchboard**

14. Run `sb user email <user> <email>` for each mapping. If a password was generated, pipe it into
    `sb reset-password <admin> --password-stdin`, store it in a 0600 file next to the install, and
    tell the user where.
15. `sb login-mode cloudflare --team-domain <auth_domain> --aud <aud>`.
16. Ask the user to open `https://UI_HOST` in a private window and sign in through Access. Then ask
    with AskUserQuestion: "Are you in the switchboard, signed in as `<admin username>`?" The options are
    "Yes" and "No". On **No**, immediately run `sb login-mode password`. Say that password sign-in is
    back, show what the page said, and suggest likely causes: email mismatch, wrong account, or the
    team domain.

**On any error:** stop and show it. List what was already done:
- **Cloudflare:** each created resource with its delete command (`cf zero-trust access applications
  delete`, `cf zero-trust access policies delete`, `cf dns records delete <id> -z <zone>`,
  `cf tunnels delete`).
- **Target:** the backed-up files to restore.
- **Login mode:** if it was already switched, run `sb login-mode password` first.

Then ask: roll back, retry, or leave it.

## Step 6: Report

Summarise what exists now:
- the hostnames, team domain, AUD tag and tunnel
- the files changed, with their backups
- which users can sign in with which email
- each verification result

Then list the follow-ups from the plan: reconnect agents if their URL changed, and re-authorize OAuth
servers if `PUBLIC_URL` changed.

End with the way back: `sb login-mode password` on the target restores password sign-in.
