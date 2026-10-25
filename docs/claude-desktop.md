# Claude Desktop, claude.ai and other OAuth-only clients

Clients that can't send a custom header, such as Claude Desktop and claude.ai custom connectors,
connect over OAuth instead. The switchboard is its own authorization server, so there is no OAuth app
to register anywhere.

1. Make `/mcp/<username>/<agent>` reachable over **public HTTPS** (Caddy, Cloudflare Tunnel,
   `tailscale funnel`). Claude's connectors connect from Anthropic's cloud, not from your machine.
   Check that the switchboard advertises the same `https://` origin: see
   [Reverse proxy](reverse-proxy.md#checking-what-claude-will-see).
2. In Claude: **Settings, Connectors, Add custom connector**. Paste the full endpoint
   `https://<public-host>/mcp/<username>/<agent>` (the bare host 404s), then keep **Sign in now** and
   **Register automatically** (dynamic client registration). "Claude's published identity" (CIMD) is
   not supported.
3. Claude opens an approval page served by the switchboard. On the Agents page, open the agent's
   **Connection instructions, Claude Desktop**, click **Generate pairing code**, type the code into the
   approval page and click **Approve**.

Pairing codes are single-use and expire after 10 minutes, so the agent's long-lived token never has to
be pasted into a web page. Each user can only generate codes for their own agents. The approved client
shows up under the agent's **OAuth connections**, where it can be revoked. Access tokens last an hour
and are refreshed automatically; an unused connection lapses after 90 days. Static bearer tokens keep
working alongside OAuth.

The authorization server lives next to `/mcp` (on `MCP_PORT` when the ports are split), because Claude
calls its token endpoint from the same place it calls the MCP endpoint. If the hostname is behind
Cloudflare Access, see [Cloudflare Access](cloudflare-access.md) for the paths that must bypass it.
