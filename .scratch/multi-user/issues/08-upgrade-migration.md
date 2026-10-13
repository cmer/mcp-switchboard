# Upgrade migration

Type: grilling
Status: resolved
Blocked by: 02, 04

## Question

Every existing install is migrated to multi-user on upgrade, even with a single user. What exactly happens to existing data, sessions, endpoints, and auth-disabled installs?

## Answer

Resolved 2026-10-12 while charting the map.

- Before migrating, copy `switchboard.db` to `switchboard.db.pre-multiuser` (the upgrade is one-way).
- Create the **Default user**: username `admin` (renameable later), is the Admin, can run local commands, keeps the existing password hash. All servers, agents, logs, and requests become its own; current values of the settings that become per-user are copied onto it.
- Existing admin sessions stay valid (bound to the Default user). Legacy `/mcp/<agent-slug>` URLs, agent tokens, and agent OAuth grants keep working.
- Auth-disabled installs stay auth-disabled, acting as the Default user; adding a second user requires enabling auth first.
- **Revised 2026-10-13 (after implementation): turning sign-in off was removed entirely; sign-in is always required. A 1.x install that had it off gets a startup message to sign in as `admin` with the old password or run `mcp-switchboard reset-password admin`.**
