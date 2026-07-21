import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { agentServers, agents, servers, type AgentRow } from "../../db/schema.js";
import { decrypt, encrypt, randomToken } from "../../lib/crypto.js";
import { isValidSlug, slugify } from "../../lib/slug.js";
import type { AppContext } from "../context.js";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().optional(),
});

const matrixSchema = z.object({ enabled: z.boolean() });

function serialize(ctx: AppContext, row: AgentRow) {
  const matrix = ctx.db
    .select({ serverId: agentServers.serverId, enabled: agentServers.enabled })
    .from(agentServers)
    .where(eq(agentServers.agentId, row.id))
    .all();
  const enabledMap = new Map(matrix.map((m) => [m.serverId, m.enabled]));
  const allServers = ctx.db.select({ id: servers.id }).from(servers).all();
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    token: decrypt(row.tokenEnc),
    createdAt: row.createdAt,
    sessions: ctx.hub.sessionCount(row.id),
    servers: allServers.map((s) => ({ serverId: s.id, enabled: enabledMap.get(s.id) ?? false })),
  };
}

export function agentRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const rows = ctx.db.select().from(agents).all();
    return c.json(rows.map((r) => serialize(ctx, r)));
  });

  app.post("/", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const slug = parsed.data.slug ?? slugify(parsed.data.name);
    if (!isValidSlug(slug)) {
      return c.json({ error: "Slug must be 1-64 chars of a-z, 0-9, and dashes (no underscores)" }, 400);
    }
    if (ctx.db.select().from(agents).where(eq(agents.slug, slug)).get()) {
      return c.json({ error: `Slug "${slug}" is already in use` }, 409);
    }
    const row = ctx.db
      .insert(agents)
      .values({ slug, name: parsed.data.name, tokenEnc: encrypt(randomToken()), createdAt: Date.now() })
      .returning()
      .get();
    return c.json(serialize(ctx, row), 201);
  });

  app.patch("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const row = ctx.db.select().from(agents).where(eq(agents.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    if (parsed.data.slug !== undefined) {
      if (!isValidSlug(parsed.data.slug)) {
        return c.json({ error: "Slug must be 1-64 chars of a-z, 0-9, and dashes (no underscores)" }, 400);
      }
      const clash = ctx.db.select().from(agents).where(eq(agents.slug, parsed.data.slug)).get();
      if (clash && clash.id !== id) return c.json({ error: `Slug "${parsed.data.slug}" is already in use` }, 409);
    }
    const updated = ctx.db.update(agents).set(parsed.data).where(eq(agents.id, id)).returning().get();
    return c.json(serialize(ctx, updated));
  });

  app.delete("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const row = ctx.db.select().from(agents).where(eq(agents.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);
    await ctx.hub.dropAgentSessions(id);
    ctx.db.delete(agents).where(eq(agents.id, id)).run();
    return c.json({ ok: true });
  });

  app.post("/:id/token/rotate", async (c) => {
    const id = Number(c.req.param("id"));
    const row = ctx.db.select().from(agents).where(eq(agents.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);
    // Old token dies immediately: live sessions are dropped and the stored token replaced.
    await ctx.hub.dropAgentSessions(id);
    const updated = ctx.db
      .update(agents)
      .set({ tokenEnc: encrypt(randomToken()) })
      .where(eq(agents.id, id))
      .returning()
      .get();
    return c.json(serialize(ctx, updated));
  });

  app.put("/:id/servers/:serverId", async (c) => {
    const agentId = Number(c.req.param("id"));
    const serverId = Number(c.req.param("serverId"));
    const agent = ctx.db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const server = ctx.db.select().from(servers).where(eq(servers.id, serverId)).get();
    if (!server) return c.json({ error: "Server not found" }, 404);
    const parsed = matrixSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { enabled: boolean }" }, 400);

    const existing = ctx.db
      .select()
      .from(agentServers)
      .where(and(eq(agentServers.agentId, agentId), eq(agentServers.serverId, serverId)))
      .get();
    if (existing) {
      ctx.db
        .update(agentServers)
        .set({ enabled: parsed.data.enabled })
        .where(and(eq(agentServers.agentId, agentId), eq(agentServers.serverId, serverId)))
        .run();
    } else {
      ctx.db.insert(agentServers).values({ agentId, serverId, enabled: parsed.data.enabled }).run();
    }
    // Live sessions of this agent see the change immediately.
    ctx.hub.notifyAgent(agentId);
    return c.json(serialize(ctx, agent));
  });

  return app;
}
