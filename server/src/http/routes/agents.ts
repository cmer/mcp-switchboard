import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { agentOAuthClients, agentOAuthGrants, type AgentRow } from "../../db/schema.js";
import { decrypt } from "../../lib/crypto.js";
import { setMatrix } from "../../core/adminActions.js";
import { userScope, type UserScope } from "../../core/userScope.js";
import { adminDeps, type AppContext } from "../context.js";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().optional(),
  role: z.enum(["standard", "manager"]).optional(),
  toolMode: z.enum(["full", "lean"]).optional(),
});

const matrixSchema = z.object({ enabled: z.boolean() });

function serialize(ctx: AppContext, scope: UserScope, row: AgentRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    toolMode: row.toolMode,
    token: decrypt(row.tokenEnc),
    createdAt: row.createdAt,
    sessions: ctx.hub.sessionCount(row.id),
    servers: scope.matrix.forAgent(row.id),
    oauthGrants: oauthGrants(ctx, row.id),
  };
}

function redirectHost(redirectUrisJson: string): string | null {
  try {
    const first = (JSON.parse(redirectUrisJson) as string[])[0];
    if (!first) return null;
    const url = new URL(first);
    return url.host || url.protocol; // custom-scheme redirects (cursor://…) may have no host
  } catch {
    return null;
  }
}

function oauthGrants(ctx: AppContext, agentId: number) {
  return ctx.db
    .select({
      id: agentOAuthGrants.id,
      clientName: agentOAuthClients.clientName,
      redirectUrisJson: agentOAuthClients.redirectUrisJson,
      createdAt: agentOAuthGrants.createdAt,
      lastUsedAt: agentOAuthGrants.lastUsedAt,
    })
    .from(agentOAuthGrants)
    .innerJoin(agentOAuthClients, eq(agentOAuthClients.clientId, agentOAuthGrants.clientId))
    .where(eq(agentOAuthGrants.agentId, agentId))
    .all()
    .map(({ redirectUrisJson, ...g }) => ({ ...g, redirectHost: redirectHost(redirectUrisJson) }));
}

const scopeOf = (ctx: AppContext, c: Context) => userScope(ctx.db, c.get("user"));

export function agentRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const scope = scopeOf(ctx, c);
    return c.json(scope.agents.list().map((r) => serialize(ctx, scope, r)));
  });

  app.post("/", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const scope = scopeOf(ctx, c);
    const result = scope.agents.create(parsed.data);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(serialize(ctx, scope, result.row), 201);
  });

  app.patch("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const scope = scopeOf(ctx, c);
    if (!scope.agents.get(id)) return c.json({ error: "Not found" }, 404);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const result = scope.agents.update(id, parsed.data);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    const { row: updated, previous } = result;
    // Both fields reshape the advertised tool list — the role adds/removes the management tools,
    // the tool mode swaps the proxied tools for meta-tools. One notify covers a patch touching both.
    const roleChanged = parsed.data.role !== undefined && parsed.data.role !== previous.role;
    const toolModeChanged = parsed.data.toolMode !== undefined && parsed.data.toolMode !== previous.toolMode;
    if (roleChanged || toolModeChanged) ctx.hub.notifyAgent(id, "tools");
    return c.json(serialize(ctx, scope, updated));
  });

  app.delete("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const scope = scopeOf(ctx, c);
    if (!scope.agents.get(id)) return c.json({ error: "Not found" }, 404);
    await ctx.hub.dropAgentSessions(id);
    scope.agents.remove(id);
    return c.json({ ok: true });
  });

  app.post("/:id/token/rotate", async (c) => {
    const id = Number(c.req.param("id"));
    const scope = scopeOf(ctx, c);
    if (!scope.agents.get(id)) return c.json({ error: "Not found" }, 404);
    // Old token dies immediately: live sessions are dropped and the stored token replaced. OAuth
    // grants are separate credentials (approved with pairing codes) and are revoked on their own.
    await ctx.hub.dropAgentSessions(id);
    const updated = scope.agents.rotateToken(id)!;
    return c.json(serialize(ctx, scope, updated));
  });

  // One-time code the owner types on the OAuth consent page to approve a connection for this agent.
  app.post("/:id/oauth-pairing-code", (c) => {
    const id = Number(c.req.param("id"));
    if (!scopeOf(ctx, c).agents.get(id)) return c.json({ error: "Not found" }, 404);
    return c.json(ctx.agentOAuth.createPairingCode(id));
  });

  // Requests re-authenticate one by one, but an open SSE stream doesn't — so drop the sessions too.
  app.delete("/:id/oauth-grants/:grantId", async (c) => {
    const agentId = Number(c.req.param("id"));
    const grantId = Number(c.req.param("grantId"));
    if (!scopeOf(ctx, c).agents.get(agentId)) return c.json({ error: "Not found" }, 404);
    const deleted = ctx.db
      .delete(agentOAuthGrants)
      .where(and(eq(agentOAuthGrants.id, grantId), eq(agentOAuthGrants.agentId, agentId)))
      .returning()
      .get();
    if (!deleted) return c.json({ error: "Not found" }, 404);
    await ctx.hub.dropAgentSessions(agentId);
    return c.json({ ok: true });
  });

  app.put("/:id/servers/:serverId", async (c) => {
    const agentId = Number(c.req.param("id"));
    const serverId = Number(c.req.param("serverId"));
    const scope = scopeOf(ctx, c);
    const agent = scope.agents.get(agentId);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const parsed = matrixSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { enabled: boolean }" }, 400);

    // The scope decides which servers this agent may be linked to; anything else reads as unknown.
    if (!setMatrix(adminDeps(ctx), scope, agentId, serverId, parsed.data.enabled)) {
      return c.json({ error: "Server not found" }, 404);
    }
    return c.json(serialize(ctx, scope, agent));
  });

  return app;
}
