import { Hono } from "hono";
import { z } from "zod";
import type { UserRow } from "../../db/schema.js";
import { userAgents, userCounts, userDeletionFallout } from "../../core/adminView.js";
import { issueSetupCode, resetUserPassword } from "../../core/setupCodes.js";
import {
  UserError,
  createUser,
  deleteUser,
  disableUser,
  enableUser,
  getUser,
  isDefaultUser,
  listUsers,
  renameUser,
  setCanRunLocalCommands,
  setUserEmail,
} from "../../core/users.js";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../adminAuth.js";

const createSchema = z.object({ username: z.string().trim().min(1), email: z.string().nullish() });
// Strict: there is deliberately no way to set `role` (exactly one Admin, the Default user).
const patchSchema = z
  .object({
    username: z.string().trim().min(1).optional(),
    email: z.string().nullable().optional(),
    canRunLocalCommands: z.boolean().optional(),
  })
  .strict();

function serializeUser(ctx: AppContext, user: UserRow, counts: { servers: number; agents: number }) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    email: user.email,
    canRunLocalCommands: user.canRunLocalCommands,
    disabled: user.disabledAt !== null,
    isDefault: isDefaultUser(ctx.db, user.id),
    hasPassword: user.passwordHash !== null,
    setupCodePending: user.setupCodeHash !== null && (user.setupCodeExpiresAt ?? 0) > Date.now(),
    serverCount: counts.servers,
    agentCount: counts.agents,
    createdAt: user.createdAt,
  };
}

const countsFor = (ctx: AppContext, userId: number) => userCounts(ctx.db, userId);

/**
 * Admin-only user management. Everything here returns names and counts: no endpoint exposes the
 * contents of another user's servers, agents or logs.
 */
export function userRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.use("*", requireAdmin);
  app.onError((err, c) => {
    if (err instanceof UserError) return c.json({ error: err.message }, err.status);
    console.error("[users]", err);
    return c.json({ error: "Internal error" }, 500);
  });

  const target = (id: string): UserRow => {
    const user = getUser(ctx.db, Number(id));
    if (!user) throw new UserError("User not found", 404);
    return user;
  };

  app.get("/", (c) => c.json(listUsers(ctx.db).map((u) => serializeUser(ctx, u, countsFor(ctx, u.id)))));

  // Agent slugs only (names, not contents): the Rename dialog lists the URLs a new username would break.
  app.get("/:id/agents", (c) => c.json(userAgents(ctx.db, target(c.req.param("id")).id).map((a) => ({ slug: a.slug }))));

  app.post("/", async (c) => {
    const body = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Body must be { username, email? }" }, 400);
    const user = createUser(ctx.db, { username: body.data.username, email: body.data.email });
    const setupCode = issueSetupCode(ctx.db, user.id);
    const fresh = getUser(ctx.db, user.id)!; // re-read: it now carries the setup code
    return c.json({ user: serializeUser(ctx, fresh, { servers: 0, agents: 0 }), setupCode }, 201);
  });

  // Rename, email and the local-command permission. A rename breaks the user's agent URLs, so the
  // response names the agents it affected.
  app.patch("/:id", async (c) => {
    const user = target(c.req.param("id"));
    const body = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Body must be { username?, email?, canRunLocalCommands? }" }, 400);
    const { username, email, canRunLocalCommands } = body.data;

    // One transaction, so a taken username or email leaves the other fields as they were.
    const renamed = username !== undefined && username !== user.username;
    ctx.db.$client.transaction(() => {
      if (renamed) renameUser(ctx.db, user.id, username);
      if (email !== undefined) setUserEmail(ctx.db, user.id, email);
      if (canRunLocalCommands !== undefined) setCanRunLocalCommands(ctx.db, user.id, canRunLocalCommands);
    })();
    const brokenAgentSlugs = renamed ? userAgents(ctx.db, user.id).map((a) => a.slug) : [];
    return c.json({
      user: serializeUser(ctx, getUser(ctx.db, user.id)!, countsFor(ctx, user.id)),
      brokenAgentSlugs,
    });
  });

  app.post("/:id/disable", async (c) => {
    const user = target(c.req.param("id"));
    disableUser(ctx.db, user.id);
    // Live sessions go first, then reconcile stops the user's servers (and so notifies recipients).
    for (const agent of userAgents(ctx.db, user.id)) await ctx.hub.dropAgentSessions(agent.id);
    await ctx.manager.reconcile();
    return c.json({ user: serializeUser(ctx, getUser(ctx.db, user.id)!, countsFor(ctx, user.id)) });
  });

  app.post("/:id/enable", async (c) => {
    const user = target(c.req.param("id"));
    enableUser(ctx.db, user.id);
    await ctx.manager.reconcile();
    return c.json({ user: serializeUser(ctx, getUser(ctx.db, user.id)!, countsFor(ctx, user.id)) });
  });

  app.delete("/:id", async (c) => {
    const user = target(c.req.param("id"));
    if (isDefaultUser(ctx.db, user.id)) throw new UserError("The Default user can't be deleted", 400);

    // Everything below must be collected before the cascade removes the rows it is read from.
    const { serverIds, agentIds, recipientAgentIds: recipients } = userDeletionFallout(ctx.db, user.id);

    for (const serverId of serverIds) ctx.refresher.cancel(serverId);
    for (const agentId of agentIds) await ctx.hub.dropAgentSessions(agentId);
    deleteUser(ctx.db, user.id);
    await ctx.manager.reconcile(); // stops the deleted servers' connections
    for (const agentId of recipients) ctx.hub.notifyAgent(agentId);
    return c.json({ ok: true });
  });

  // A new setup code, with the old password and every session gone. Resetting your own account
  // would leave the install with a password-less Admin, which first-run setup treats as unclaimed.
  app.post("/:id/reset-password", (c) => {
    const user = target(c.req.param("id"));
    if (isDefaultUser(ctx.db, user.id)) {
      throw new UserError("The Default user's password can't be reset here — change it in Settings, or use the CLI", 400);
    }
    return c.json({ setupCode: resetUserPassword(ctx.db, user.id) });
  });

  return app;
}
