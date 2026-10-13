# Docs and release shape

Type: grilling
Status: resolved

## Question

How does multi-user ship? Decide: the version number (the forced, one-way migration suggests 2.0.0 for `@cmer/mcp-switchboard`), what the CHANGELOG `[Unreleased]` entry leads with and which upgrade warnings it carries (DB backup file, `admin` username, legacy URLs keep working, new URL form in snippets); which README sections get rewritten ("Homelab-simple auth", Quick start first-run, Connecting an agent URL form, Configuration for login mode and the new CLI commands, a new "Multiple users and sharing" section, and Cloudflare Access setup including the Bypass app for `/mcp/*` and agent OAuth paths); whether Docker / docker-compose docs need changes for running the CLI commands inside a container; and whether the work lands as one release or is staged (e.g. migration + users first, sharing second).

## Answer

Resolved 2026-10-12.

**Release**
- Ships as **2.0.0** of `@cmer/mcp-switchboard` (same package name): one-way migration plus a changed login screen make it major, even though no agent URL breaks.
- **Everything in one release**: users, isolation, Admin/Users page, migration, per-user URLs, CLI, sharing, and Cloudflare Access login together. The spec is organized by area, not by stage.

**CLI**
- First subcommands on the existing `mcp-switchboard` bin (today `dist/index.js` only starts the server and reads no arguments): `reset-password <username>` and `login-mode password`.
- Safe to run while the server is running (SQLite tolerates the second writer; auth settings are read per request). `reset-password` also invalidates that user's existing sessions.
- Documented in both forms: `npx @cmer/mcp-switchboard reset-password admin` and `docker compose exec switchboard node dist/index.js reset-password admin`.

**CHANGELOG (2.0.0 entry, written under `[Unreleased]` as the work lands)**
- Leads with an **"Upgrading from 1.x"** paragraph: DB backed up to `switchboard.db.pre-multiuser`; sign in as `admin` with the same password; every agent URL and token keeps working, but snippets now show `/mcp/admin/<agent>`; rollback = stop, restore the backup, reinstall 1.5.x, losing anything changed since the upgrade.
- Then the usual `Added` / `Changed` bullets with bold lead-ins and the why.

**README: short landing page plus guides**
- README keeps: what it is, feature bullets (the "Homelab-simple auth" bullet becomes "Household-ready: separate users, each fully isolated, with optional sharing"; trusted-LAN caveat stays), quick start (npx and Docker), connecting an agent (`/mcp/<username>/<agent>`, old URLs still work), a new **Users and sharing** section, screenshots, and a **Guides** list. Each section a few lines; npm shows only the README, so it is the landing page.
- Moves to guides in `docs/`:
  - `docs/configuration.md`: env var table (today's 99-line Configuration section).
  - `docs/reverse-proxy.md`: reverse proxies, OAuth over plain HTTP, splitting the agent endpoint onto `MCP_PORT`.
  - `docs/cloudflare-access.md`: team domain + AUD tag, Bypass app for `/mcp/*`, `/oauth/*`, `/.well-known/*`, Managed OAuth off, LAN-exposure warning.
  - `docs/recovering-access.md`: the CLI commands, npx and Docker forms.
  - `docs/lean-mode.md`.
- Re-shoot changed screenshots (servers, agents, settings, connect).
- Same change updates `CLAUDE.md`: "single-user" description, layout notes, and key invariants (per-user slugs, reach module, user-scoped data access, Default user).
