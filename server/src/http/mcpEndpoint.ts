import type { Context } from "hono";
import { cors } from "hono/cors";
import { config } from "../config.js";
import { decrypt, timingSafeEqualStr } from "../lib/crypto.js";
import { endpointAgent } from "./agentEndpoint.js";
import { oauthBaseUrl } from "./agentOAuthRoutes.js";
import type { AppContext } from "./context.js";

/**
 * Browser-based clients (MCP Inspector) need CORS on the endpoint itself — including on the 401, or
 * they can't read the `resource_metadata` pointer that starts OAuth discovery. Bearer auth only, no
 * cookies, so any origin is fine.
 */
export const mcpCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-Id"],
  exposeHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
});

/**
 * ALL /mcp/:username/:agentSlug and the legacy ALL /mcp/:agentSlug (the Default user's agent) →
 * SwitchboardHub. Accepts the agent's static bearer token or an OAuth access token issued to that
 * agent, whichever URL form it was issued through; every request re-authenticates, so revocation
 * takes effect at once.
 */
export function mcpEndpointHandler(ctx: AppContext) {
  return async (c: Context): Promise<Response> => {
    const username = c.req.param("username");
    const agent = endpointAgent(ctx.db, { username: username ?? null, agentSlug: c.req.param("agentSlug") ?? "" });

    const header = c.req.header("Authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    // Unknown user, unknown agent, disabled user and wrong token all get this same 401, so the
    // endpoint never reveals which usernames or agents exist.
    const valid =
      agent !== undefined &&
      presented !== "" &&
      (ctx.agentOAuth.verifyAccessToken(presented)?.agentId === agent.id ||
        timingSafeEqualStr(presented, decrypt(agent.tokenEnc)));
    if (!valid) {
      // The resource_metadata pointer is how OAuth clients find the authorization server (RFC 9728 §5.1).
      // It names the URL exactly as requested (still percent-encoded, so it can't break the header).
      const path = new URL(c.req.url).pathname.replace(/\/$/, "");
      const metadata = `${oauthBaseUrl(c.req.raw, config.oauthPublicUrl, config.publicUrl)}/.well-known/oauth-protected-resource${path}`;
      const challenge = presented
        ? `Bearer error="invalid_token", resource_metadata="${metadata}"`
        : `Bearer resource_metadata="${metadata}"`;
      return c.json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": challenge });
    }
    return ctx.hub.handleRequest(agent, c.req.raw);
  };
}
