# Cloudflare Access JWT verification

Research for [issue 09](../issues/09-cloudflare-access-verification.md). Researched 2026-10-12, primary sources only (developers.cloudflare.com, the `jose` docs and source).

## TL;DR for the design

1. **Trust only a verified `Cf-Access-Jwt-Assertion` JWT.** Never the `Cf-Access-Authenticated-User-Email` header, and never header presence alone. Cloudflare: "Validation of the header alone is not sufficient — the JWT and signature must be confirmed to avoid identity spoofing." [app-token]
2. **Verify with `jose`**: `createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))` + `jwtVerify(token, JWKS, { issuer: teamDomain, audience: aud, algorithms: ['RS256'], requiredClaims: ['exp'] })`. This is Cloudflare's own Node example [validate], plus two hardening options it leaves out (see "Claims" below; `jose` does **not** require `exp` by default).
3. **Admin config:** team domain (`https://<team>.cloudflareaccess.com`) and the application's AUD tag (or tags). Both are non-secret.
4. **Identity = the `email` claim, after the token is checked.** Service-token JWTs have `sub: ""`, carry `common_name` (the client ID), and show no `email`. Reject any verified token without a non-empty `email`.
5. **Keep `/mcp/*` (and the agent OAuth routes) out of the Access login.** Under an Allow policy, Access sends a non-browser agent to the login page with a 302. Use a more-specific Access application with a **Bypass** policy on those paths, or serve them on a hostname with no Access app. Access then injects no JWT, and the agent's own `Authorization: Bearer` token is the only credential. The switchboard must not look for an Access JWT there.
6. **Don't enable Access "Managed OAuth"** on the switchboard hostname, and don't set `read_service_tokens_from_header: Authorization`. Both take over the 401/`WWW-Authenticate`/`Authorization` surface that the switchboard's own agent OAuth and bearer tokens use.

## Headers and cookie

| Item | What it is | Source |
|---|---|---|
| `Cf-Access-Jwt-Assertion` (request header to origin) | The application JWT. Cloudflare recommends it: "the cookie is not guaranteed to be passed." cloudflared docs: "For all L7 requests to these hostnames, Access will send the JWT to cloudflared as a `Cf-Access-Jwt-Assertion` request header." | [validate], [origin-params] |
| `CF_Authorization` (cookie) | "contains the user's identity in the form of a JSON Web Token (JWT)". There are two kinds: a global session token on the team domain and an application token on each protected hostname. The app-domain cookie's HttpOnly/SameSite are the admin's choice (default None). There is an optional *binding cookie*: "The CF_Authorization cookie cannot be used without the associated binding cookie." | [cookie] |
| `Cf-Access-Authenticated-User-Email` | Appears in Cloudflare's Worker tutorial, where it arrives at the origin as a plain header. No primary source documents it as a security contract or says Cloudflare strips client-supplied copies. It is unsigned, so on a Bypass path, an unprotected hostname, or the LAN, anyone can set it. **Display hint at most, never identity.** | [workers-tut] |
| `Cf-Access-Token` | Header an Access-protected service uses to forward a user's JWT to *another* Access app ("Linked App Token" policy). The switchboard can ignore it. The `aud` check already rejects JWTs minted for other apps. | [secure-mcp] |

Prefer the header over the cookie (Cloudflare's guidance). Reading the cookie as a fallback is allowed: the Go example notes `CF_Authorization` "could also be checked", and the Python example reads only the cookie. Both carry the same kind of JWT and need the same verification. [validate]

## Keys (JWKS) and rotation

- Certs URL: `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs`. The response has `keys` (JWKs), `public_cert` (current, PEM) and `public_certs` (all, PEM). [validate]
- Rotation: the signing key rotates **every 6 weeks** by default, and "previous keys stay valid for 7 days after rotation". Manual rotation through the API is possible, for example after a compromise. [validate]
- Guidance: fetch keys from the external endpoint instead of hard-coding a public key. Don't take the current key from `public_cert`, because the order changes and a stale cache can serve an expired key. Select the key by matching the JWT's `kid`. [validate]
- `jose.createRemoteJWKSet` does exactly that: it selects by `kid`/`alg`, and an unknown `kid` triggers a refetch once `cooldownDuration` has passed since the last fetch. Defaults: `cacheMaxAge` 600000 ms (10 min), `cooldownDuration` 30000 ms, `timeoutDuration` 5000 ms. It also accepts `headers`, `customFetch` and `jwksCache`. [jose-remote], [jose-remote-opts]
  - Create the set **once** per team domain at module/config scope, as Cloudflare's Express example does. Rebuild it when the admin changes the team domain.
  - With the 10-minute cache and 30-second refetch-on-unknown-`kid`, the default settings handle both scheduled rotation and an emergency manual rotation.
  - Network dependency: the switchboard host needs outbound HTTPS to `<team>.cloudflareaccess.com`. Cloudflare lists the same requirement for cloudflared's own JWT check. [tunnel-config]

## Claims

Identity token payload fields [app-token]: `aud` (the app's AUD tag), `email` ("verified by the identity provider"), `exp`, `iat`, `nbf`, `iss` ("The Cloudflare Access domain URL for the application"), `type` (`app` for the application token, `org` for the global session token), `identity_nonce`, `sub` ("unique to an email address per account"), `country`, and best-effort `custom` (IdP claims, trimmed past about 1 KB, so not usable for authorization). Header: `alg`, `kid`, `typ`.

What to check, and how `jose` handles each:

| Check | How | Note |
|---|---|---|
| Signature, RS256 | `algorithms: ['RS256']` | Cloudflare: "must verify with RS256". `jose` never accepts `alg: none`, but it would otherwise accept any algorithm that fits the key. [validate], [jose-verify-opts] |
| `iss` = team domain | `issuer: 'https://<team>.cloudflareaccess.com'` | Setting `issuer` makes the claim required. [jose-verify-opts] |
| `aud` contains the AUD tag | `audience: aud` (a string or an array if several apps/hostnames point here) | "specifies which application the JWT is valid for". This check stops tokens from *other* Access apps in the same team, including org/global tokens and linked-app tokens, from being accepted. [validate] cloudflared's own check also takes a list (`audTag: [...]`). [origin-params] |
| `exp` | `requiredClaims: ['exp']` | **Surprise:** `jose` checks `exp`/`nbf` only *if present* (`validateNumericDate(...)` then `if (exp !== undefined)`). It only requires a claim when you pass `requiredClaims`, `issuer`, `audience`, `subject`, or `maxTokenAge`. Cloudflare always sends `exp`, but require it anyway. [jose-src] |
| `nbf` | automatic when present | Service-token JWTs show no `nbf`. [app-token] |
| `email` present and non-empty | app code | This is the identity key for user matching. Missing means a service token or a non-user token, so reject for login. |
| `type === 'app'` (optional) | app code | Belt-and-braces. `aud` already separates the app token from the org token. |
| Clock skew | `clockTolerance` (e.g. `'30s'`) | Optional. [jose-verify-opts] |

Session length: the app-domain cookie and JWT live for the policy session duration, else the application session duration, else **24 hours** by default. [cookie] For better revocation, re-verify on every request (or every few minutes), and don't mint a long-lived switchboard session from a single Access JWT. Otherwise removing a user in Access won't take effect until the switchboard's own session ends.

## Non-email identities: service tokens

- Service tokens authenticate with `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers, and the policy action must be **Service Auth** ("otherwise, Access will prompt for an identity provider login"). A self-hosted app can instead read them from a single header named by `read_service_tokens_from_header` (for example `Authorization`, with a JSON value). [svc-tokens]
- The resulting JWT has `type`, `aud`, `exp`, `iss`, `iat`, `common_name` (= the client ID), and **`sub: ""`**. The documented example has no `email`. [app-token]
- How to tell them apart: `sub === ''` or `common_name` present, or simply no `email`. The switchboard login should reject these tokens. A service token is not a household member.
- Under strict service-token mode, failed service-token requests get 401/403 instead of a 302, and Access doesn't set a `CF_Authorization` cookie. [svc-tokens]

## `/mcp/*` and non-browser agents

What Access does to non-browser requests on a path covered by an Allow (identity) policy:

- Without the cookie or service-token headers, Access blocks the request: "If a request does not include the cookie, Access will block the request." [cookie] The default response is a 302 redirect to the login page. 401 responses are only documented for (a) AJAX requests with `X-Requested-With: XMLHttpRequest` and an *expired* session, (b) the account-wide "Return 401 for non-browser traffic" setting, which "only applies to failed Cloudflare One Client authentication", (c) strict service-token mode, and (d) Managed OAuth. [session], [svc-tokens], [managed-oauth]
- Result: a coding agent that sends only `Authorization: Bearer <switchboard token>` to an Access-protected `/mcp/<slug>` gets a redirect to an HTML login and never reaches the switchboard. The agent endpoint **has to be outside the Allow policy.**

How to carve it out, from the Access docs:

- **Path-specific application.** "When multiple rules are set for a common root path, the more specific rule takes precedence". A subpath without its own rule inherits from the parent path. So add a second Access application on `switchboard.example.com/mcp/*` with a Bypass policy. Caveats: `example.com/alpha/*` does **not** cover `example.com/alpha`; query strings aren't supported in paths; there is at most one wildcard between slashes. [app-paths] The docs don't spell out an Allow-app vs Bypass-app example on the same host. That follows from the specificity rule, but **verify it live**.
- Also bypass the agent OAuth surface (`/oauth/*`, `/.well-known/oauth-*`, the registration/token endpoints in `agentOAuthRoutes.ts`). An MCP client's discovery and token calls are non-browser and would hit the same 302. The browser *consent* page can stay behind Access.
- **Bypass semantics:** "Bypass does not enforce any Access security controls and requests are not logged." Bypass policies can't use identity selectors. Cloudflare "does not recommend" Bypass for permanent access to internal apps and suggests Service Auth instead. [policies] For the switchboard, Bypass is the right choice: the endpoint has its own bearer/OAuth auth, which is the documented use case ("applications that require specific endpoints to be public").
- Bypass and Service Auth policies are evaluated **before** Allow/Block, top to bottom. [policies]
- No primary source says whether Access injects `Cf-Access-Jwt-Assertion` on bypassed requests. Bypass enforces nothing, so assume **no JWT on `/mcp/*`**. Even if one arrived, the agent endpoint should ignore it. Agent auth stays the per-agent bearer token or the agent OAuth token.
- Alternative: put `/mcp` on a separate hostname with no Access application. That fits `MCP_PORT` split mode, with the hostname pointing at the MCP listener.

Interaction with the agent `Authorization` header:

- Under Bypass, Access doesn't touch the request, and the agent's `Authorization: Bearer` reaches the origin.
- **Managed OAuth** (opt-in per app) makes Access an OAuth 2.0 AS for "CLIs, AI agents, SDKs, and scripts". It returns 401 with a `WWW-Authenticate` that points to **Access's** discovery metadata at `https://<app-domain>/.well-known/oauth-authorization-server`, and issues opaque tokens. Cloudflare warns not to enable it "if you run your own OAuth server behind an Access application and rely on your own `WWW-Authenticate` headers, because enabling it replaces the 401 behavior". [managed-oauth] That is exactly the switchboard's agent OAuth, so **leave it off** on any hostname or path that serves `/mcp` or `/.well-known/oauth-*`. (It could replace the switchboard's agent OAuth someday, but it would identify *users* rather than *agents*, which is out of scope.)
- `read_service_tokens_from_header: Authorization` would make Access consume the `Authorization` header for service-token credentials. Don't set it.

## Bypass threats and what stops each

| Path to the server | What arrives | Defence |
|---|---|---|
| LAN / direct IP to the listener | No JWT, or a forged one | Signature check against the JWKS. A missing or invalid token means "not logged in". Never fall back to the email header. |
| Second hostname with no Access app (or a Bypass path) | No JWT, any headers the client likes | Same as above. The email header is attacker-controlled here. |
| A different Access app in the same team | A valid JWT with the wrong `aud` | `audience` check. |
| A service token on the right app | A valid JWT, `sub: ""`, no `email` | Require `email`. |
| Replay of a captured, still-valid JWT from the LAN | A valid JWT | Not stoppable by JWT checks alone (it's a bearer token, valid until `exp`, 24 h default). Mitigations: bind the admin/UI listener to localhost or the tunnel interface when Access mode is on, keep the session short, and treat the cookie as a credential (TLS end to end). Note Cloudflare's line "Unless your application is connected to Access through Cloudflare Tunnel, your application must validate the token" [app-token]. Even behind a Tunnel the switchboard should still validate, because its listener is reachable on the LAN. cloudflared can also validate (`originRequest.access: { required: true, teamName, audTag: [...] }`) [origin-params], but that doesn't protect the LAN path. |

## Admin configuration to collect

- **Team domain**: `https://<team>.cloudflareaccess.com`. Used as `iss` and to build the certs URL. Normalise it (scheme, no trailing slash) so `issuer` matches exactly.
- **AUD tag(s)**: found under Zero Trust > Access controls > Applications > (app) > Configure > Additional settings. [validate] Allow a list if several Access apps or hostnames front the switchboard.
- Optional: clock tolerance. Optional: whether to accept the `CF_Authorization` cookie as a fallback.
- Advise in the UI: add a Bypass app for `/mcp/*` and the agent OAuth paths, keep Managed OAuth off, and don't expose the admin listener on the LAN in this mode.

## Reference snippet (Cloudflare's Node example, plus the hardening above)

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));

const token = req.header('cf-access-jwt-assertion'); // fallback: CF_Authorization cookie
const { payload } = await jwtVerify(token, JWKS, {
  issuer: teamDomain,
  audience: audTags,          // string | string[]
  algorithms: ['RS256'],
  requiredClaims: ['exp'],
});
if (typeof payload.email !== 'string' || payload.email === '') reject(); // service token / non-user
```

## Open points to verify live

- That a Bypass app on `host/mcp/*` overrides an Allow app on `host` (expected from the path-specificity rule, but no worked example exists).
- Whether Access strips a client-supplied `Cf-Access-Authenticated-User-Email` or `Cf-Access-Jwt-Assertion` on protected paths (not documented, and it doesn't matter if we verify the JWT and ignore the email header).
- Whether the origin receives a JWT on bypassed paths (expected no; the design shouldn't depend on it).

## Sources

- [validate] Validate JWTs: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ (also at `/cloudflare-one/identity/authorization-cookie/validating-json/`)
- [app-token] Application token: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
- [cookie] Authorization cookie: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
- [policies] Access policies: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
- [app-paths] Application paths: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
- [svc-tokens] Service tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- [session] Session management: https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
- [managed-oauth] Managed OAuth: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
- [secure-mcp] Secure MCP servers: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/ and Linked apps: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/linked-apps/
- [origin-params] Tunnel origin parameters (`access`): https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/
- [tunnel-config] Tunnel configuration (firewall egress): https://developers.cloudflare.com/tunnel/configuration/
- [workers-tut] Custom headers for Access-protected origins with Workers: https://developers.cloudflare.com/cloudflare-one/tutorials/access-workers/
- [jose-remote] https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md
- [jose-remote-opts] https://github.com/panva/jose/blob/main/docs/jwks/remote/interfaces/RemoteJWKSetOptions.md
- [jose-verify-opts] https://github.com/panva/jose/blob/main/docs/jwt/verify/interfaces/JWTVerifyOptions.md
- [jose-src] https://github.com/panva/jose/blob/main/src/lib/jwt_claims_set.ts (`validateClaimsSet`)
