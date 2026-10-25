# Login and sessions

Type: grilling
Status: resolved

## Question

How does a human prove which user they are to the web UI: username + password, a trusted reverse-proxy header (Cloudflare Access), or both? What does `authDisabled` mean with several users, and how are passwords reset?

## Answer

Resolved 2026-10-12 while charting the map.

- Two login modes, chosen **instance-wide** by the Admin: **password** (username + password per user) or **Cloudflare Access** (user matched by email from the verified Access JWT). How to verify that JWT safely is [Cloudflare Access JWT verification](09-cloudflare-access-verification.md).
- Password reset: the Admin resets any user's password from the UI; a CLI command (`mcp-switchboard reset-password <username>`) covers a locked-out Admin. Today a lost password has no recovery path at all.
- `authDisabled` stays instance-wide and is only allowed while exactly one user exists (with no login there's no way to know who you are). See [Instance vs per-user settings](04-instance-vs-user-settings.md).
- Not a SaaS: no email flows, no self-signup.
- Detail for Access mode (provisioning, no password fallback, per-request verification, lockout recovery via `mcp-switchboard login-mode password`): [Cloudflare Access user provisioning and exposure](14-cloudflare-access-provisioning.md).
- **Revised 2026-10-13 (after implementation): turning sign-in off was removed entirely; sign-in is always required. A 1.x install that had it off gets a startup message to sign in as `admin` with the old password or run `mcp-switchboard reset-password admin`.**
