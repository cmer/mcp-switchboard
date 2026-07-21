import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { settings } from "../../db/schema.js";
import { hashPassword, verifyPassword } from "../../lib/crypto.js";
import { clearSessionCookie, getSessionId, setSessionCookie } from "../adminAuth.js";
import type { AppContext } from "../context.js";

const passwordSchema = z.object({ password: z.string().min(4) });
const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(4),
});
const authSettingsSchema = z.object({
  authDisabled: z.boolean().optional(),
  instanceName: z.string().max(60).nullish(),
  autoEnableNewServers: z.boolean().optional(),
});

export function getSetting(ctx: AppContext, key: string): string | null {
  return ctx.db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

function setSetting(ctx: AppContext, key: string, value: string): void {
  ctx.db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export function isAuthDisabled(ctx: AppContext): boolean {
  return getSetting(ctx, "authDisabled") === "1";
}

export function authRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  const getHash = () => getSetting(ctx, "adminPasswordHash");
  const isAdmin = (c: Context) => isAuthDisabled(ctx) || ctx.adminSessions.has(getSessionId(c));

  app.get("/me", (c) => {
    const disabled = isAuthDisabled(ctx);
    return c.json({
      needsSetup: getHash() === null && !disabled,
      authenticated: disabled || ctx.adminSessions.has(getSessionId(c)),
      authDisabled: disabled,
      instanceName: getSetting(ctx, "instanceName") || null,
      autoEnableNewServers: getSetting(ctx, "autoEnableNewServers") === "1",
    });
  });

  app.post("/setup", async (c) => {
    if (getHash() !== null) return c.json({ error: "Password already set" }, 409);
    const body = passwordSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Password must be at least 4 characters" }, 400);
    setSetting(ctx, "adminPasswordHash", hashPassword(body.data.password));
    setSessionCookie(c, ctx.adminSessions.create());
    return c.json({ ok: true });
  });

  app.post("/login", async (c) => {
    const hash = getHash();
    if (hash === null) return c.json({ error: "No password set — complete setup first" }, 409);
    const body = passwordSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success || !verifyPassword(body.data.password, hash)) {
      return c.json({ error: "Wrong password" }, 401);
    }
    setSessionCookie(c, ctx.adminSessions.create());
    return c.json({ ok: true });
  });

  app.post("/logout", (c) => {
    ctx.adminSessions.delete(clearSessionCookie(c));
    return c.json({ ok: true });
  });

  // Change the admin password. Requires the current password while auth is
  // enabled; while auth is disabled anyone with UI access could reset it
  // anyway, so no current password is demanded (useful if it was forgotten).
  app.post("/change-password", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
    const body = changePasswordSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "New password must be at least 4 characters" }, 400);
    const hash = getHash();
    if (!isAuthDisabled(ctx) && hash !== null) {
      if (!body.data.currentPassword || !verifyPassword(body.data.currentPassword, hash)) {
        return c.json({ error: "Current password is wrong" }, 401);
      }
    }
    setSetting(ctx, "adminPasswordHash", hashPassword(body.data.newPassword));
    // Other browsers' sessions die; this one gets a fresh session.
    ctx.adminSessions.deleteAll();
    setSessionCookie(c, ctx.adminSessions.create());
    return c.json({ ok: true });
  });

  // UI settings: auth on/off (trusted networks only) and the instance name.
  app.post("/settings", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
    const body = authSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Body must be { authDisabled?, instanceName? }" }, 400);

    if (body.data.instanceName !== undefined) {
      setSetting(ctx, "instanceName", (body.data.instanceName ?? "").trim());
    }

    if (body.data.autoEnableNewServers !== undefined) {
      setSetting(ctx, "autoEnableNewServers", body.data.autoEnableNewServers ? "1" : "0");
    }

    if (body.data.authDisabled !== undefined) {
      if (!body.data.authDisabled && getHash() === null) {
        return c.json({ error: "Set a password before enabling auth" }, 400);
      }
      setSetting(ctx, "authDisabled", body.data.authDisabled ? "1" : "0");
      if (!body.data.authDisabled) {
        // Auth just turned back on — make sure the requesting browser stays logged in.
        setSessionCookie(c, ctx.adminSessions.create());
      }
    }
    return c.json({ ok: true });
  });

  return app;
}
