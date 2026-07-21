import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { agents } from "../db/schema.js";
import { decrypt, timingSafeEqualStr } from "../lib/crypto.js";
import type { AppContext } from "./context.js";

/** Bearer-authenticated MCP endpoint: ALL /mcp/:agentSlug → SwitchboardHub. */
export function mcpEndpointHandler(ctx: AppContext) {
  return async (c: Context): Promise<Response> => {
    const slug = c.req.param("agentSlug") ?? "";
    const agent = ctx.db.select().from(agents).where(eq(agents.slug, slug)).get();

    const header = c.req.header("Authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const valid = agent !== undefined && presented !== "" && timingSafeEqualStr(presented, decrypt(agent.tokenEnc));
    if (!valid) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
      });
    }
    return ctx.hub.handleRequest(agent, c.req.raw);
  };
}
