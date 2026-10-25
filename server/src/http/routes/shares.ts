import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { userDirectory } from "../../core/users.js";
import { userScope, type OwnedShare, type ReceivedShare, type UserScope } from "../../core/userScope.js";
import type { AppContext } from "../context.js";

const scopeOf = (ctx: AppContext, c: Context) => userScope(ctx.db, c.get("user"));

const offerSchema = z.object({ username: z.string().trim().min(1) });
const acceptSchema = z.object({ alias: z.string().trim().min(1).optional() });
const patchSchema = z
  .object({ alias: z.string().trim().min(1).optional(), enabled: z.boolean().optional() })
  .refine((v) => v.alias !== undefined || v.enabled !== undefined, { message: "Body must be { alias?, enabled? }" });

/** What an owner sees of a recipient: their name and how much they use the server. */
export function serializeOwnedShare(share: OwnedShare) {
  return {
    id: share.id,
    username: share.username,
    status: share.status,
    callCount: share.callCount,
    lastUsedAt: share.lastUsedAt,
    createdAt: share.createdAt,
  };
}

/**
 * Owner side, mounted at `/api/servers/:id/shares`. A server that isn't the caller's reads as
 * missing, so the endpoints say nothing about other users' servers or who they share with.
 */
export function ownerShareRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const shares = scopeOf(ctx, c).shares.forServer(Number(c.req.param("id")));
    if (!shares) return c.json({ error: "Not found" }, 404);
    return c.json(shares.map(serializeOwnedShare));
  });

  app.post("/", async (c) => {
    const parsed = offerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { username }" }, 400);
    const result = scopeOf(ctx, c).shares.offer(Number(c.req.param("id")), parsed.data.username);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(serializeOwnedShare(result.share), 201);
  });

  // Immediate: the recipient's rows are gone before anyone is told, and their live sessions hear at once.
  app.delete("/:shareId", (c) => {
    const result = scopeOf(ctx, c).shares.revoke(Number(c.req.param("id")), Number(c.req.param("shareId")));
    if (!result) return c.json({ error: "Not found" }, 404);
    for (const agentId of result.affectedAgentIds) ctx.hub.notifyAgent(agentId);
    return c.json({ ok: true });
  });

  return app;
}

type Status = "connected" | "waiting_for_owner" | "unavailable";

/** The share's state in the recipient's terms; the owner's connection details never leave the server. */
function shareStatus(ctx: AppContext, share: ReceivedShare): Status {
  if (!share.ownerAvailable) return "unavailable";
  const state = ctx.manager.get(share.serverId)?.state;
  if (state === "connected") return "connected";
  return state === "needs_auth" ? "waiting_for_owner" : "unavailable";
}

function serializeReceived(ctx: AppContext, share: ReceivedShare) {
  if (share.status === "offered") {
    return {
      id: share.id,
      ownerUsername: share.ownerUsername,
      serverName: share.serverName,
      description: share.description,
      proposedAlias: share.proposedAlias,
      createdAt: share.createdAt,
    };
  }
  return {
    id: share.id,
    // The owner's server id: the key of the recipient's per-agent switch in the matrix.
    serverId: share.serverId,
    alias: share.alias,
    ownerUsername: share.ownerUsername,
    serverName: share.serverName,
    description: share.description,
    toolCount: ctx.manager.get(share.serverId)?.toolsCache.length ?? 0,
    enabled: share.enabled,
    status: shareStatus(ctx, share),
    createdAt: share.createdAt,
  };
}

function listReceived(ctx: AppContext, scope: UserScope) {
  const all = scope.shares.received();
  return {
    offers: all.filter((s) => s.status === "offered").map((s) => serializeReceived(ctx, s)),
    accepted: all.filter((s) => s.status === "accepted").map((s) => serializeReceived(ctx, s)),
  };
}

/** Recipient side, mounted at `/api/shares`. */
export function receivedShareRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json(listReceived(ctx, scopeOf(ctx, c))));

  app.post("/:id/accept", async (c) => {
    const body = acceptSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Body must be { alias? }" }, 400);
    const scope = scopeOf(ctx, c);
    const id = Number(c.req.param("id"));
    const offer = scope.shares.received().find((s) => s.id === id);
    if (!offer) return c.json({ error: "Not found" }, 404);
    const result = scope.shares.accept(id, body.data.alias ?? offer.proposedAlias);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    for (const agentId of result.enabledAgentIds) ctx.hub.notifyAgent(agentId);
    return c.json(serializeReceived(ctx, result.share));
  });

  app.post("/:id/decline", (c) => {
    if (!scopeOf(ctx, c).shares.decline(Number(c.req.param("id")))) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  // The alias renames the tool prefix; the switch hides or restores the whole share. Both tell the
  // agents that have it on. A patch carrying both is applied in full or not at all.
  app.patch("/:id", async (c) => {
    const body = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid input" }, 400);
    const scope = scopeOf(ctx, c);
    const id = Number(c.req.param("id"));
    const { alias, enabled } = body.data;
    const affected = new Set<number>();

    if (alias !== undefined) {
      const result = scope.shares.rename(id, alias);
      if ("error" in result) return c.json({ error: result.error }, result.status);
      result.affectedAgentIds.forEach((a) => affected.add(a));
    }
    if (enabled !== undefined) {
      const result = scope.shares.setEnabled(id, enabled);
      if (!result) return c.json({ error: "Not found" }, 404);
      result.affectedAgentIds.forEach((a) => affected.add(a));
    }
    for (const agentId of affected) ctx.hub.notifyAgent(agentId);
    const share = scope.shares.received().find((s) => s.id === id)!;
    return c.json(serializeReceived(ctx, share));
  });

  app.delete("/:id", (c) => {
    const result = scopeOf(ctx, c).shares.remove(Number(c.req.param("id")));
    if (!result) return c.json({ error: "Not found" }, 404);
    for (const agentId of result.affectedAgentIds) ctx.hub.notifyAgent(agentId);
    return c.json({ ok: true });
  });

  return app;
}

/** Any signed-in user: the other active users' names, for the Share dialog. Names only. */
export function directoryRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  app.get("/users", (c) => c.json(userDirectory(ctx.db, c.get("user").id).map((username) => ({ username }))));
  return app;
}
