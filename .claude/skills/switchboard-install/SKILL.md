---
name: switchboard-install
description: Install MCP Switchboard on a fresh Debian or Ubuntu machine with Docker Compose, locally or over SSH. Use when the user wants to deploy or set up the switchboard on a new VM or server.
---

# Install MCP Switchboard on a new machine

Turns a fresh Debian or Ubuntu machine into a running switchboard. The result:

- a git checkout of a release tag at `/opt/mcp-switchboard`
- Docker Compose with host networking, so stdio servers reach the LAN exactly as the machine does
- an Admin password that only the user knows

The run is **plan, then confirm, then apply**: inspect the target and ask questions first, change
nothing until the user approves the plan.

## Ground rules

- **The target** is this machine or an SSH host. Write `on-target <cmd>` for "run on the target":
  run the command locally, or wrap it as `ssh <host> '<cmd>'`. Privileged commands need root or
  passwordless sudo (`sudo -n true`). If neither works, stop and say what's missing.
- Ask every question with the AskUserQuestion tool. Free-text answers (an SSH host, a URL, a tag)
  come back through its built-in "Other" option, so offer likely values as options.
- Treat the Admin password as a secret. Store it on the target in a root-only `0600` file, and show
  it to the user once, at hand-off.
- **Companion skills.** The switchboard's skills live side by side at
  `https://raw.githubusercontent.com/cmer/mcp-switchboard/<ref>/.claude/skills/<name>/SKILL.md`:
  - `switchboard-install`: set up a fresh machine
  - `switchboard-cloudflare-access`: put an install behind Cloudflare Access

  When a step needs one, invoke it with the Skill tool if it's available. Otherwise fetch its
  `SKILL.md` and follow it. Use the same `<ref>` as this skill. If this skill was read from such a URL,
  take the ref from that URL; otherwise use `main`. That way a run started from a release tag fetches
  its companions from the same release. Pass along everything already learned, so the companion
  skips steps it doesn't need.
- This skill installs and nothing else. If `/opt/mcp-switchboard` or a running `mcp-switchboard`
  container already exists, stop and say so. Upgrading and exposing an existing install are separate
  tasks; for Cloudflare, that's the `switchboard-cloudflare-access` skill.

## Step 1: Target and preflight

1. Ask where to install: "This machine", or an SSH host typed into "Other" (`user@host` or an ssh
   config alias). Check that `ssh <host> true` works without a password prompt. If it doesn't, ask
   the user to set up key-based SSH and stop.
2. Check, read-only, and keep every result for the plan:
   - OS: `/etc/os-release` should be Debian 12+ or Ubuntu 22.04+. Anything else: stop.
   - Architecture (`uname -m`), free disk on `/opt` (want 3 GB or more) and RAM (want 1 GB or more).
     Warn if below, but continue.
   - Privileges: running as root, or `sudo -n true` succeeds.
   - Docker: `docker compose version`. If present, it must be Compose v2.24 or newer, because the
     override uses `!reset`.
   - Ports `8787` and `8788` free: `ss -ltn`.
   - The LAN address: `hostname -I`, first address.
   - No existing install (see Ground rules).
3. Find the latest release: `git ls-remote --tags --refs https://github.com/cmer/mcp-switchboard`,
   then take the highest `vX.Y.Z`.

Done when: every check has a result, and the target is usable or you have stopped with the reason.

## Step 2: Ask

One AskUserQuestion call:

1. **Version:** "Latest release `<tag>` (Recommended)" or "`main` (unreleased)". "Other" takes a
   specific tag.
2. **How people and agents will reach it:**
   - "From anywhere, through Cloudflare Access (Recommended)". Cloudflare is set up right after the
     install, in the same run.
   - "On my LAN only: `http://<lan-ip>:8787`"
   - "Behind my own reverse proxy": the public URL is then typed into "Other"

   This sets `PUBLIC_URL`. With Cloudflare, install with the LAN URL; the Cloudflare step replaces
   it with the public hostname.

   If `switchboard-cloudflare-access` handed you here, the answer is already Cloudflare: skip this
   question, and in Step 6 return to that skill rather than starting it fresh.
3. **Admin password:**
   - "Generate one for me (Recommended)"
   - "I'll set it in the browser on first visit". Warn that until they do, anyone who can reach the
     port can claim the Admin account.

## Step 3: Plan and confirm

Show the plan: every command you'll run on the target, the full contents of each file you'll write,
and anything that came up in preflight. If Cloudflare was chosen, say that its setup follows the
install, with its own questions and plan. Then ask **"Apply this plan?"** with "Apply", "Change an
answer" and "Cancel". Make no changes until the answer is "Apply".

## Step 4: Apply

All commands run on the target, as root or through `sudo`.

1. **Prerequisites,** only if missing:
   - `apt-get update && apt-get install -y ca-certificates curl git openssl`
   - Docker Engine with the Compose plugin, from Docker's apt repository, following
     https://docs.docker.com/engine/install/ for the detected distribution. Then
     `systemctl enable --now docker`.
2. **Checkout:**
   `git clone --branch <tag> --depth 1 https://github.com/cmer/mcp-switchboard /opt/mcp-switchboard`
   For `main`, drop `--branch <tag>`.
3. **`/opt/mcp-switchboard/.env`**, mode `0600`, containing `PUBLIC_URL=<chosen url>`. This file is the
   single place for the switchboard's environment. The Cloudflare skill adds `MCP_PORT`,
   `MCP_PUBLIC_URL` and `HOST` here later.
4. **`/opt/mcp-switchboard/compose.override.yml`.** It is untracked, so `git pull` never touches it:
   ```yaml
   services:
     switchboard:
       network_mode: host
       ports: !reset []
       env_file: .env
   ```
   Host networking lets stdio servers reach LAN machines, `.local` names, services on the host and
   Tailscale addresses just as the machine itself does. It also means the switchboard listens
   directly on the host's ports `8787` (and `8788` once `MCP_PORT` is set).
5. **Start:** `cd /opt/mcp-switchboard && docker compose up -d --build`. The first build takes a few
   minutes. Then poll `curl -fsS http://127.0.0.1:8787/api/auth/me` for up to three minutes. On
   failure, show `docker compose logs --tail 50 switchboard` and stop.
6. **Admin password** (if generated):
   - Generate it with `openssl rand -base64 18` and write it to `/opt/mcp-switchboard/admin-password.txt`
     (mode `0600`).
   - Pipe it in: `docker compose exec -T switchboard node dist/index.js reset-password admin --password-stdin`
   - Confirm it works: `POST /api/auth/login` with `{"username":"admin","password":…}` on
     `127.0.0.1:8787` returns 200.
7. **Smoke check:**
   - `docker compose exec -T switchboard node dist/index.js status` shows the Default user `admin`
     with a password (if generated).
   - `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8787/mcp/x/y` returns `401`.

**On any error:** stop and show it. Say what was already done and how to undo it:
`docker compose down` in `/opt/mcp-switchboard`, then remove the directory. Leave Docker installed.

Done when: the container is up, `/api/auth/me` answers, and the smoke check passes.

## Step 5: Hand off

Tell the user:

- **Open** `<PUBLIC_URL>` and sign in as `admin`. If generated, show the password once and say it
  also lives in `/opt/mcp-switchboard/admin-password.txt`. They can change it in Settings and delete
  that file. If they chose the browser, they set the password on the first-run page.
- **Next steps in the UI:** add servers, create agents, and create users for the household (each gets
  a one-time setup code).
- **Updating:**
  `cd /opt/mcp-switchboard && git fetch --tags && git checkout <new-tag> && docker compose up -d --build`
- **Backing up:** everything that matters is in `/opt/mcp-switchboard/data`: `switchboard.db` and
  `secret.key`. Without the key, stored secrets can't be decrypted. Back up both together, ideally
  with the container stopped.
- **Recovering:** `docker compose exec switchboard node dist/index.js --help` lists the recovery
  commands.

## Step 6: Cloudflare (if chosen in Step 2)

Continue straight into the companion skill `switchboard-cloudflare-access` without asking again. Pass
along what this run already knows, so it skips its "Find the install" step:
- the target
- the install at `/opt/mcp-switchboard`, Docker Compose with `network_mode: host`, service
  `switchboard`
- the env file `.env`, the override `compose.override.yml`, the origins `http://localhost:8787` and
  `:8788`
- that the Admin `admin` has a password

It still asks its own Cloudflare questions and shows its plan before changing anything on the
account.
