# Cloudflare Access JWT verification

Type: research
Status: resolved

## Question

What does the switchboard need to verify a Cloudflare Access request safely, so the login mode can't be bypassed by anyone reaching the server directly (LAN, or a second unprotected hostname)? Facts needed: the headers Access sets (`Cf-Access-Jwt-Assertion`, `Cf-Access-Authenticated-User-Email`, cookie `CF_Authorization`), the JWKS URL (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), which claims to check (`aud` tag, `iss`, `exp`, `email`), key rotation and caching, what config the Admin must supply (team domain, AUD tag), whether service tokens or non-email identities can appear, and which Node library is the conventional choice (e.g. `jose`). Also: does Access put the JWT on requests to `/mcp/*` too, and does that interact with agents' bearer tokens or agent OAuth?

## Comments

Research findings: [research/cloudflare-access.md](../research/cloudflare-access.md)

## Answer

Resolved 2026-10-12 by research; detail in [research/cloudflare-access.md](../research/cloudflare-access.md).

- Verify `Cf-Access-Jwt-Assertion` (fallback cookie `CF_Authorization`) with `jose` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, checking `iss` (team domain), `aud` (AUD tag(s)), RS256, and `requiredClaims: ['exp']` (jose skips `exp` if absent). Admin config: team domain + AUD tag(s).
- Never trust `Cf-Access-Authenticated-User-Email`: it's unsigned and spoofable from the LAN.
- Service-token JWTs have empty `sub`, a `common_name`, and no `email`: reject any token without `email`.
- Access redirects non-browser clients under an Allow policy, so `/mcp/*`, `/oauth/*`, and `/.well-known/*` need an Access **Bypass** app (or a separate hostname); there the agent's bearer token is the only credential. Access "Managed OAuth" and `read_service_tokens_from_header: Authorization` must stay off.
- A captured JWT is replayable from the LAN until expiry (24h default): in this mode the admin listener should only be reachable through the tunnel.
- Unverified live: that a path-specific Bypass app on `/mcp/*` overrides the host-wide Allow app.
