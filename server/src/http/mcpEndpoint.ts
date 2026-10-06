import type { Context } from "hono";
import { cors } from "hono/cors";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { agents } from "../db/schema.js";
import { decrypt, timingSafeEqualStr } from "../lib/crypto.js";
import { oauthBaseUrl, resourceMetadataUrl } from "./agentOAuthRoutes.js";
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
 * ALL /mcp/:agentSlug → SwitchboardHub. Accepts the agent's static bearer token or an OAuth access
 * token issued to that agent; every request re-authenticates, so revocation takes effect at once.
 */
export function mcpEndpointHandler(ctx: AppContext) {
  return async (c: Context): Promise<Response> => {
    const slug = c.req.param("agentSlug") ?? "";
    const agent = ctx.db.select().from(agents).where(eq(agents.slug, slug)).get();

    const header = c.req.header("Authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const valid =
      agent !== undefined &&
      presented !== "" &&
      (ctx.agentOAuth.verifyAccessToken(presented)?.agentId === agent.id ||
        timingSafeEqualStr(presented, decrypt(agent.tokenEnc)));
    if (!valid) {
      // The resource_metadata pointer is how OAuth clients find the authorization server (RFC 9728 §5.1).
      const metadata = resourceMetadataUrl(oauthBaseUrl(c.req.raw, config.oauthPublicUrl), slug);
      const challenge = presented
        ? `Bearer error="invalid_token", resource_metadata="${metadata}"`
        : `Bearer resource_metadata="${metadata}"`;
      return c.json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": challenge });
    }
    return ctx.hub.handleRequest(agent, c.req.raw);
  };
}
