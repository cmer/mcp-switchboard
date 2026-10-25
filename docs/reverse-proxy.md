# Reverse proxies, HTTPS and the agent port

The switchboard speaks plain HTTP. For anything beyond a trusted LAN, put Caddy, a Cloudflare Tunnel
or `tailscale serve` in front of it. Claude Desktop and claude.ai connect from Anthropic's cloud, so
for them the agent endpoint has to be reachable over public HTTPS. Variable details are in
[Configuration](configuration.md).

## OAuth over plain HTTP

OAuth 2.1 providers (Linear and most others) only accept a redirect URI that is `https` or a
loopback address. A `PUBLIC_URL` like `http://nas.lan:8787` or `http://192.168.1.10:8787` therefore
gets authorization refused before you see a consent screen. Two ways out:

1. **Terminate TLS.** Caddy, a Cloudflare Tunnel, or `tailscale serve --bg 8787` give you an
   `https://` hostname with a real certificate. `PUBLIC_URL=https://...` then works with no further
   steps, and your session cookie and agent tokens stop crossing the network in the clear.
2. **Open the UI through a loopback port-forward** (`ssh -L 8787:localhost:8787 nas`) and leave
   `PUBLIC_URL` at its `http://localhost:8787` default. The callback comes back down the tunnel, so
   authorization stays automatic. Agents still reach `/mcp/...` over the LAN; set `MCP_PUBLIC_URL`
   so the connection snippets show the address they should use.

Changing `PUBLIC_URL` after a server has been authorized invalidates its registration with the
provider, because the redirect URI it registered no longer exists. The switchboard notices and
registers again on the next authorization, so the fix is to click **Authorize** on that server once more.

## Behind a reverse proxy

When `MCP_PUBLIC_URL` is unset, the agent OAuth metadata is built from the incoming request,
honouring `X-Forwarded-Proto` and `X-Forwarded-Host`. That works for a single proxy that terminates
TLS. It breaks when:

- **Proxies are chained over plain HTTP**, for example Cloudflare to Caddy where Cloudflare talks
  HTTP to Caddy. Caddy reports *its* hop as `X-Forwarded-Proto: http`, so the metadata advertises
  `http://...` and Claude rejects it. An `https://` `PUBLIC_URL` for the same host fixes the scheme
  automatically. Otherwise set `MCP_PUBLIC_URL`, or have Caddy send `header_up X-Forwarded-Proto https`.
- **The proxy rewrites `Host`** and doesn't send `X-Forwarded-Host`.

### Checking what Claude will see

The `resource` must be exactly the URL you paste into the connector:

```bash
curl -s https://<public-host>/.well-known/oauth-protected-resource/mcp/<username>/<agent>
# {"resource":"https://<public-host>/mcp/<username>/<agent>","authorization_servers":["https://<public-host>"],...}
```

Legacy one-segment URLs (`/mcp/<agent>`) are answered the same way and echo back the form you asked
for. Anything `http://`, or a different host, means `MCP_PUBLIC_URL=https://<public-host>` is needed.

If you protect the hostname with Cloudflare Access, the agent paths have to bypass it. See
[Cloudflare Access](cloudflare-access.md).

## Splitting the agent endpoint onto its own port

By default one port serves everything: the UI, the REST API and `/mcp/...`. Set `MCP_PORT` and the
switchboard opens a second listener, in the same process with the same database and upstream
connections, that serves **only** the agent endpoint and its OAuth routes (`/oauth/*` and
`/.well-known/*`). The UI port stops serving `/mcp/*`.

```bash
MCP_PORT=8788 HOST=127.0.0.1 MCP_HOST=0.0.0.0 npx @cmer/mcp-switchboard
```

That combination keeps the admin UI on loopback (reach it through an SSH tunnel or Tailscale) while
the agent endpoint listens on every interface, ready to be forwarded or reverse-proxied. The endpoint
is still bearer-token authenticated, and there is still no TLS: put Caddy or a tunnel in front of the
MCP port before exposing it to the internet, and set `MCP_PUBLIC_URL` to the URL agents will use so the
connection snippets match.

With Docker, publish the second port in `docker-compose.yml` (there is a commented example) and set
`MCP_PORT` in `environment`.
