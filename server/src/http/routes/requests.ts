import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ServerRequestRow } from "../../db/schema.js";
import { approveServerRequest, requestServerSummary } from "../../core/adminActions.js";
import { escalatedRequest, escalatedRequests, type EscalatedRequestView } from "../../core/adminView.js";
import { userScope, type UserScope } from "../../core/userScope.js";
import { adminDeps, type AppContext } from "../context.js";
import { serializeServer } from "./servers.js";

const denySchema = z.object({ note: z.string().max(1000).nullish() });

const WAITING_FOR_ADMIN = "Waiting for the Admin — only the Admin can approve a local command you can't run";

/**
 * A request as its queue shows it. `server` is the decrypted config *summary*: env keys but
 * never their values, and no bearer token — `authType` is all the approver needs to see.
 * `requestedByUsername` labels another user's escalated request in the Admin's queue (null for
 * the caller's own); `escalated` on your own request means it is waiting for the Admin.
 */
function serialize(row: ServerRequestRow) {
  return {
    id: row.id,
    requestedByAgentSlug: row.requestedByAgentSlug || null,
    requestedByUsername: null as string | null,
    escalated: row.escalated,
    kind: row.kind,
    server: requestServerSummary(row),
    reason: row.reason,
    status: row.status,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

function serializeEscalated(view: EscalatedRequestView): ReturnType<typeof serialize> {
  return {
    id: view.id,
    requestedByAgentSlug: view.requestedByAgentSlug,
    requestedByUsername: view.username,
    escalated: true,
    kind: view.kind,
    server: view.server,
    reason: view.reason,
    status: view.status,
    resolutionNote: view.resolutionNote,
    createdAt: view.createdAt,
    resolvedAt: view.resolvedAt,
  };
}

/**
 * Whose scope a request is acted on in: the caller's for their own; the requester's when the
 * Admin handles another user's escalated request. Undefined (→ 404) for anything else.
 */
function requesterScope(ctx: AppContext, c: Context, id: number): { scope: UserScope; own?: ServerRequestRow } | undefined {
  const user = c.get("user");
  const mine = userScope(ctx.db, user);
  const own = mine.requests.get(id);
  if (own) return { scope: mine, own };
  if (user.role !== "admin") return undefined;
  const escalated = escalatedRequest(ctx.db, id);
  return escalated ? { scope: userScope(ctx.db, escalated.userId) } : undefined;
}

export function requestRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  // Your own requests; the Admin's queue adds every other user's escalated ones.
  app.get("/", (c) => {
    const user = c.get("user");
    const own = userScope(ctx.db, user).requests.list().map(serialize);
    if (user.role !== "admin") return c.json(own);
    const others = escalatedRequests(ctx.db)
      .filter((r) => r.userId !== user.id)
      .map(serializeEscalated);
    return c.json([...own, ...others].sort((a, b) => b.id - a.id));
  });

  app.post("/:id/approve", async (c) => {
    const id = Number(c.req.param("id"));
    const found = requesterScope(ctx, c, id);
    if (!found) return c.json({ error: "Not found" }, 404);
    const { scope, own } = found;
    // Your own request for a local command needs the flag (escalated ones never have it; it can
    // also be revoked after filing). The Admin approving someone else's is the whole point.
    if (own?.status === "pending" && requestServerSummary(own)?.type === "stdio" && !scope.canRunLocalCommands) {
      return c.json({ error: WAITING_FOR_ADMIN }, 403);
    }

    const result = await approveServerRequest(adminDeps(ctx), scope, id);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    // Another user's server: the Admin learns it exists, not its config.
    const server = own ? serializeServer(ctx, result.row) : { id: result.row.id, slug: result.row.slug, name: result.row.name };
    return c.json({ ok: true, server });
  });

  app.post("/:id/deny", async (c) => {
    const id = Number(c.req.param("id"));
    const found = requesterScope(ctx, c, id);
    if (!found) return c.json({ error: "Not found" }, 404);
    const { scope, own } = found;
    const row = own ?? scope.requests.get(id)!;
    if (row.status !== "pending") return c.json({ error: "Request already resolved" }, 409);
    if (own?.escalated && c.get("user").role !== "admin") {
      return c.json({ error: "Waiting for the Admin — cancel it instead" }, 403);
    }
    const parsed = denySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);

    // The agent reads this back with switchboard__request_status.
    scope.requests.resolve(id, { status: "denied", note: parsed.data.note ?? null });
    return c.json({ ok: true });
  });

  // Withdraw your own pending request — typically one waiting for the Admin.
  app.post("/:id/cancel", (c) => {
    const id = Number(c.req.param("id"));
    const user = c.get("user");
    const scope = userScope(ctx.db, user);
    const row = scope.requests.get(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "pending") return c.json({ error: "Request already resolved" }, 409);
    scope.requests.resolve(id, { status: "denied", note: `Cancelled by ${user.username}` });
    return c.json({ ok: true });
  });

  return app;
}
