# Cloudflare Access user provisioning and exposure

Type: grilling
Status: resolved
Blocked by: 09

## Question

In Cloudflare Access login mode: when a verified JWT carries an email that matches no user, is the request refused or is a user auto-created (and with what permissions)? How is each user's email recorded (set by the Admin on create, editable by the user?), and does a user keep a password as a fallback for LAN access or is password login off entirely in this mode? Given a captured Access JWT can be replayed from the LAN for up to 24h, does the switchboard enforce tunnel-only reachability of the admin UI in this mode (bind to localhost, refuse non-tunnel requests), or only document it? And how does the Admin get back in if the Access config is wrong (falls back to the CLI from [Login and sessions](02-login-and-sessions.md)?).

## Answer

Resolved 2026-10-12. Builds on [Cloudflare Access JWT verification](09-cloudflare-access-verification.md).

**Provisioning**
- A verified Access token whose `email` matches no user is **refused**: "Signed in as <email>, but no switchboard user has this email. Ask the Admin." No auto-creation; the Access policy may admit more people than the switchboard should.
- Each user has an optional email, set and changed by the Admin only; matched case-insensitively; unique across users. It can be filled in while still in password mode, ahead of switching. Users cannot change their own email (that would let them claim someone else's identity).

**Login in Access mode**
- Access only: password login is off entirely while the instance is in Access mode. On the LAN, use the public hostname through the tunnel.
- No switchboard session: the Access JWT is verified on **every** admin request (`jose` caches the JWKS). Removing someone in Cloudflare takes effect when their Access token expires. Log out goes to Cloudflare's `/cdn-cgi/access/logout`.
- Agent paths (`/mcp/*`, `/oauth/*`, `/.well-known/*`) never look at Access headers; agent auth stays bearer token or agent OAuth.

**Lockout prevention and recovery**
- Switching to Access mode (Settings › Instance: team domain + AUD tag(s)) is only accepted if the request doing the switch carries a valid Access token for the **Admin's own** email, so a configuration that wouldn't let the Admin back in can't be saved.
- CLI: `mcp-switchboard login-mode password` switches back; with `mcp-switchboard reset-password <username>` (from [Login and sessions](02-login-and-sessions.md)) a locked-out Admin recovers from a host shell.

**LAN exposure**
- Not enforced. Documented, plus a warning in Settings: "In Access mode, don't expose the admin port on your LAN." Enforcing "requests come from localhost" breaks cloudflared-in-another-container setups, and a LAN attacker replaying a captured token is the hostile-tenant case ruled out of scope.
