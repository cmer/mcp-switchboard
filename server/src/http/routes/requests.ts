import { Hono } from "hono";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { agents, serverRequests, type ServerRequestRow } from "../../db/schema.js";
import { addServers, applyRequestEdits, requestPayload, requestServerSummary } from "../../core/adminActions.js";
import { adminDeps, type AppContext } from "../context.js";
import { serializeServer } from "./servers.js";

const denySchema = z.object({ note: z.string().max(1000).nullish() });

/** Optional body of POST /:id/approve — the admin's changes to the agent's config. See `RequestEdits`. */
const editsSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().optional(),
  type: z.enum(["stdio", "http", "sse"]).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string().nullable()).optional(),
  url: z.string().url().optional(),
  authType: z.enum(["none", "bearer", "headers", "oauth"]).optional(),
  bearerToken: z.string().optional(),
  headers: z.record(z.string(), z.string().nullable()).optional(),
});

/**
 * The admin's view of a request. `server` is the decrypted config *summary*: env keys but
 * never their values, and no bearer token — `authType` is all the admin needs to see.
 */
function serialize(row: ServerRequestRow) {
  return {
    id: row.id,
    requestedByAgentSlug: row.requestedByAgentSlug,
    kind: row.kind,
    server: requestServerSummary(row),
    reason: row.reason,
    status: row.status,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

/** The requester, if it is still around — an approved server is switched on for it. */
function requesterId(ctx: AppContext, row: ServerRequestRow): number[] {
  const byId = row.requestedByAgentId
    ? ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.id, row.requestedByAgentId)).get()
    : undefined;
  const found =
    byId ?? ctx.db.select({ id: agents.id }).from(agents).where(eq(agents.slug, row.requestedByAgentSlug)).get();
  return found ? [found.id] : [];
}

export function requestRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const rows = ctx.db.select().from(serverRequests).orderBy(desc(serverRequests.id)).all();
    return c.json(rows.map(serialize));
  });

  app.post("/:id/approve", async (c) => {
    const id = Number(c.req.param("id"));
    const row = ctx.db.select().from(serverRequests).where(eq(serverRequests.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "pending") return c.json({ error: "Request already resolved" }, 409);
    if (row.kind !== "add_server") {
      const error = "Freeform requests can't be auto-executed — deny with a note, or add the server manually";
      return c.json({ error }, 400);
    }
    const stored = requestPayload(row);
    if (!stored) return c.json({ error: "Request has no stored config" }, 400);
    const edits = editsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!edits.success) return c.json({ error: edits.error.issues[0]?.message ?? "Invalid input" }, 400);
    // Edits apply to this approval only; the stored request keeps what the agent sent.
    const payload = applyRequestEdits(stored, edits.data);
    if ("error" in payload) return c.json({ error: payload.error }, 400);

    // Same executor the UI import uses: insert → reconcile → matrix → list_changed,
    // so the requesting agent's live session grows its toolset on approval.
    const [result] = await addServers(adminDeps(ctx), [payload], {
      createdByAgentSlug: row.requestedByAgentSlug,
      enableForAgentIds: requesterId(ctx, row),
    });
    // Left pending on failure (e.g. the slug got taken since) so it can be retried or denied.
    if ("error" in result) return c.json({ error: result.error }, result.status);

    ctx.db
      .update(serverRequests)
      .set({ status: "approved", resolvedAt: Date.now() })
      .where(eq(serverRequests.id, id))
      .run();
    return c.json({ ok: true, server: serializeServer(ctx, result.row) });
  });

  app.post("/:id/deny", async (c) => {
    const id = Number(c.req.param("id"));
    const row = ctx.db.select().from(serverRequests).where(eq(serverRequests.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "pending") return c.json({ error: "Request already resolved" }, 409);
    const parsed = denySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);

    ctx.db
      .update(serverRequests)
      // The agent reads this back with switchboard__request_status.
      .set({ status: "denied", resolutionNote: parsed.data.note ?? null, resolvedAt: Date.now() })
      .where(eq(serverRequests.id, id))
      .run();
    return c.json({ ok: true });
  });

  return app;
}
