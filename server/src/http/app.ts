import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { oauthCredentials, servers } from "../db/schema.js";
import { adminAuthMiddleware } from "./adminAuth.js";
import type { AppContext } from "./context.js";
import { mcpEndpointHandler } from "./mcpEndpoint.js";
import { agentRoutes } from "./routes/agents.js";
import { authRoutes, isAuthDisabled } from "./routes/auth.js";
import { serverRoutes } from "./routes/servers.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export function createApp(ctx: AppContext, webDist: string): Hono {
  const app = new Hono();

  // --- Agent-facing MCP endpoint (bearer auth, NOT admin-cookie auth) ---
  app.all("/mcp/:agentSlug", mcpEndpointHandler(ctx));

  // --- OAuth callback (arrives via the admin's browser redirect) ---
  app.get("/oauth/callback", async (c) => {
    const { code, state, error } = c.req.query();
    if (error) return c.redirect(`/servers?auth=failed&reason=${encodeURIComponent(error)}`);
    if (!code || !state) return c.redirect("/servers?auth=failed&reason=missing_code_or_state");

    const cred = ctx.db.select().from(oauthCredentials).where(eq(oauthCredentials.pendingState, state)).get();
    if (!cred) return c.redirect("/servers?auth=failed&reason=unknown_state");
    const server = ctx.db.select().from(servers).where(eq(servers.id, cred.serverId)).get();
    if (!server?.url) return c.redirect("/servers?auth=failed&reason=server_missing");

    try {
      const provider = ctx.makeOAuthProvider(server.id);
      const result = await auth(provider, { serverUrl: server.url, authorizationCode: code });
      if (result !== "AUTHORIZED") throw new Error("authorization did not complete");
      ctx.refresher.schedule(server.id);
      await ctx.manager.restart(server.id);
      return c.redirect(`/servers?auth=ok&server=${server.id}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return c.redirect(`/servers?auth=failed&reason=${encodeURIComponent(reason)}`);
    }
  });

  // --- Admin REST API ---
  const api = new Hono();
  api.route("/auth", authRoutes(ctx));
  api.use("*", adminAuthMiddleware(ctx.adminSessions, () => isAuthDisabled(ctx)));
  api.route("/servers", serverRoutes(ctx));
  api.route("/agents", agentRoutes(ctx));
  api.get("/status", (c) =>
    c.json({
      version: ctx.version,
      servers: ctx.manager.statusSummary(),
    }),
  );
  app.route("/api", api);
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  // --- Static SPA (production build) ---
  app.get("*", async (c) => {
    const reqPath = decodeURIComponent(new URL(c.req.url).pathname);
    if (reqPath.includes("..")) return c.text("Bad path", 400);
    let filePath = path.join(webDist, reqPath === "/" ? "index.html" : reqPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      filePath = path.join(webDist, "index.html"); // SPA fallback
      if (!fs.existsSync(filePath)) {
        return c.text("Web UI not built. Run: npm run build (or use npm run dev for the Vite dev server).", 404);
      }
    }
    const ext = path.extname(filePath);
    return new Response(fs.readFileSync(filePath), {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  });

  return app;
}
