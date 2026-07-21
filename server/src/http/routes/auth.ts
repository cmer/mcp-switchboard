import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { settings } from "../../db/schema.js";
import { hashPassword, verifyPassword } from "../../lib/crypto.js";
import { clearSessionCookie, getSessionId, setSessionCookie } from "../adminAuth.js";
import type { AppContext } from "../context.js";

const passwordSchema = z.object({ password: z.string().min(4) });

export function authRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  const getHash = () =>
    ctx.db.select().from(settings).where(eq(settings.key, "adminPasswordHash")).get()?.value ?? null;

  app.get("/me", (c) => {
    const needsSetup = getHash() === null;
    const authenticated = ctx.adminSessions.has(getSessionId(c));
    return c.json({ needsSetup, authenticated });
  });

  app.post("/setup", async (c) => {
    if (getHash() !== null) return c.json({ error: "Password already set" }, 409);
    const body = passwordSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Password must be at least 4 characters" }, 400);
    ctx.db.insert(settings).values({ key: "adminPasswordHash", value: hashPassword(body.data.password) }).run();
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

  return app;
}
