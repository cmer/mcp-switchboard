# Signing in with Cloudflare Access

If the switchboard sits behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/),
it can let Access do the signing in: people open the UI, Cloudflare asks who they are, and the
switchboard maps the verified email to a user. There are no switchboard passwords in this mode.

Agents are unaffected. They keep using their bearer tokens or agent OAuth, and the switchboard never
looks at Access headers on the agent paths (`/mcp/*`, `/.well-known/*` and the agent OAuth endpoints).

## Let Claude Code set it up

The `switchboard-cloudflare-access` skill does all of this for you:

1. reads how your switchboard is installed (Docker Compose or systemd, here or over SSH)
2. asks only what it can't work out (one hostname or a separate one for agents, who may sign in,
   whether to create a tunnel)
3. shows the full plan and applies it once you confirm:
   - on Cloudflare: the Access applications and policies, and optionally the tunnel and DNS records,
     through Cloudflare's `cf` CLI
   - on the switchboard: environment changes, user emails, and the switch to Access sign-in, rolled
     back automatically if you can't get in

With this repository open in Claude Code, ask it to "put my switchboard behind Cloudflare Access".
Anywhere else, run it once without installing anything:

```bash
claude "Follow https://raw.githubusercontent.com/cmer/mcp-switchboard/main/.claude/skills/switchboard-cloudflare-access/SKILL.md"
```

The steps below are what it does, if you'd rather do them by hand.

## Before you start

- The switchboard is reachable through a Cloudflare-proxied hostname (a Cloudflare Tunnel is the usual
  way) with an Access application in front of it.
- The switchboard host can make outbound HTTPS requests to `<team>.cloudflareaccess.com`. It fetches
  Cloudflare's signing keys from there and caches them, refetching on rotation.
- Every person who should get in has a user, and **the Admin has set an email on that user** (Users
  page). Emails are compared case-insensitively. Users are never created automatically: someone Access
  lets through who has no matching user sees "Signed in as ..., but no switchboard user has this email.
  Ask the Admin." In this mode, creating a user takes just a username and an email.
- The Admin has set an email on their own user too, because that is how they will be recognised.

## 1. Protect the UI with an Access application

In Zero Trust, create a **self-hosted application** for the switchboard hostname with an Allow policy
for the people in your household. Note two values:

- **Team domain**: `https://<team>.cloudflareaccess.com`.
- **Application Audience (AUD) tag**: Access controls, Applications, your application, Configure,
  Additional settings. If several Access applications or hostnames point at the same switchboard, add
  all their tags.

## 2. Let agents bypass Access

Coding agents and Claude's connectors can't do a browser login. Under an Allow policy, Access answers
them with a 302 to an HTML login page and they never reach the switchboard. Add a second Access
application, more specific than the first, with a **Bypass** policy, covering:

- `<hostname>/mcp/*`
- `<hostname>/.well-known/*`
- `<hostname>/oauth/register`, `/oauth/token`, `/oauth/revoke` and `/oauth/authorize` (the agent OAuth
  endpoints; add them as separate destinations of the same application)

Cloudflare applies the more specific path first, so these paths skip the Allow application. Bypass
means Access enforces nothing and logs nothing there: the agent's own bearer token or OAuth token is
the only credential, which is what you want.

**Don't bypass `/oauth/callback`**, which a blanket `/oauth/*` would do. That is where your browser
returns after you authorize an upstream server (Linear, Stripe, ...), and the switchboard identifies
you there by your Access token, which a bypassed path doesn't carry. The pairing-code approval page for
Claude connectors (`/oauth/authorize`) can go either way; it is protected by the one-time code.

Cloudflare's documentation implies that a Bypass application on a subpath overrides an Allow application
on the whole host, but has no worked example. **Verify it on your setup**: from a machine with no Access
session, `curl -i https://<hostname>/.well-known/oauth-protected-resource/mcp/<username>/<agent>` should
return JSON from the switchboard, not a redirect to your Access login. Also remember the path rules:
`/mcp/*` doesn't match `/mcp` itself, and query strings aren't allowed in paths.

Alternatively, split the agent endpoint onto its own port ([Reverse proxy](reverse-proxy.md#splitting-the-agent-endpoint-onto-its-own-port))
and publish it on a hostname that has no Access application at all.

Two Access features collide with the switchboard's own agent authentication. Leave both off for the
paths above:

- Do not enable **Managed OAuth** on the application. It replaces the 401 and `WWW-Authenticate`
  responses that the switchboard's agent OAuth relies on.
- Do not set `read_service_tokens_from_header: Authorization`. It makes Access consume the
  `Authorization` header that carries the agent's token.

## 3. Switch the switchboard to Access mode

Open the switchboard **through the Access-protected hostname**, sign in as the Admin, and go to
**Settings, Instance, Login mode**. Choose **Cloudflare Access**, enter the team domain and AUD tag(s),
and save.

The save is only accepted if the request itself carries a valid Access token for the Admin's own
email under the new settings. That is deliberate: a typo in the team domain or AUD tag would otherwise
lock everyone out, and this way a wrong value is refused before it is applied. Opening the switchboard
by its LAN address or any hostname without Access can't pass this check. Changing the team domain or AUD
tags later goes through the same check.

When it takes effect, existing password sessions are dropped and password login is off.

## How it behaves

- The token (`Cf-Access-Jwt-Assertion` header, or the `CF_Authorization` cookie) is verified on every
  admin request: signature against Cloudflare's keys, issuer, audience, expiry. Removing someone in
  Access therefore bites when their Access token expires, not when a switchboard session does.
- Tokens without an email, such as service tokens, are refused.
- The `Cf-Access-Authenticated-User-Email` header is never trusted, because anyone who can reach the
  switchboard without going through Access can forge it.
- **Log out** goes to `/cdn-cgi/access/logout`.

## Don't expose the admin port on your LAN

Access only protects traffic that goes through Cloudflare. The switchboard still validates the token, so
a request straight to its LAN port is refused, but a still-valid token captured by someone on your
network could be replayed there. Bind the UI to loopback or the tunnel interface (`HOST=127.0.0.1`, with
`cloudflared` on the same machine) and keep the agent endpoint wherever agents need to reach it.
Settings shows the same warning.

## If you lock yourself out

Switch back to passwords from the host, without needing Access:
see [Recovering access](recovering-access.md#switch-back-to-password-login). Turning Access *on* is only
possible from the UI, with a live Access token.
