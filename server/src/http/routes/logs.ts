import { Hono, type Context } from "hono";
import { z } from "zod";
import { LOG_SETTING_KEYS, type LogEvent } from "../../core/requestLogger.js";
import { userScope } from "../../core/userScope.js";
import { writeSetting } from "../../lib/settings.js";
import type { AppContext } from "../context.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
/** Comments keep proxies (and their idle timeouts) from closing an otherwise silent stream. */
const SSE_KEEPALIVE_MS = 25_000;

const settingsSchema = z.object({
  retentionHours: z.number().int().min(1).max(24 * 365).optional(),
  capturePayloads: z.boolean().optional(),
  maxPayloadKb: z.number().int().min(1).max(1024).optional(),
});

const scopeOf = (ctx: AppContext, c: Context) => userScope(ctx.db, c.get("user"));

/** Every route here sees the caller's own rows only: log rows belong to the calling agent's owner. */
export function logRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  /** Retention and max payload are the instance's; whether payloads are captured is the caller's. */
  const configFor = (userId: number) => ({ ...ctx.logger.config, capturePayloads: ctx.logger.capturePayloads(userId) });

  app.get("/", (c) => {
    const query = c.req.query();
    const limit = Math.min(Number(query.limit) || DEFAULT_LIMIT, MAX_LIMIT);
    return c.json({ rows: scopeOf(ctx, c).logs.list(query, limit), config: configFor(c.get("user").id) });
  });

  // Live tail. The UI falls back to polling when a proxy won't pass this through.
  app.get("/stream", (c) => {
    const userId = c.get("user").id;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const write = (chunk: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            open = false;
          }
        };

        write(": connected\n\n");
        const unsubscribe = ctx.logger.subscribe(userId, (event: LogEvent) => write(`data: ${JSON.stringify(event)}\n\n`));
        const keepalive = setInterval(() => write(": keepalive\n\n"), SSE_KEEPALIVE_MS);

        const close = () => {
          if (!open) return;
          open = false;
          clearInterval(keepalive);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed by the runtime
          }
        };
        c.req.raw.signal.addEventListener("abort", close);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // nginx buffers proxied responses by default, which would stall the tail.
        "X-Accel-Buffering": "no",
      },
    });
  });

  // Headline numbers for the last 24h.
  app.get("/stats", (c) => c.json(scopeOf(ctx, c).logs.stats(Date.now() - 24 * 60 * 60 * 1000)));

  app.get("/settings", (c) => c.json(configFor(c.get("user").id)));

  app.put("/settings", async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const { retentionHours, capturePayloads, maxPayloadKb } = parsed.data;
    const user = c.get("user");
    if ((retentionHours !== undefined || maxPayloadKb !== undefined) && user.role !== "admin") {
      return c.json({ error: "Only the Admin can change log retention and payload size" }, 403);
    }
    if (retentionHours !== undefined) writeSetting(ctx.db, LOG_SETTING_KEYS.retentionHours, String(retentionHours));
    if (capturePayloads !== undefined) scopeOf(ctx, c).settings.set("capturePayloads", capturePayloads);
    if (maxPayloadKb !== undefined) writeSetting(ctx.db, LOG_SETTING_KEYS.maxPayloadKb, String(maxPayloadKb));
    ctx.logger.reloadConfig();
    // A shorter window should take effect now, not at the next sweep.
    if (retentionHours !== undefined) ctx.logger.prune();
    return c.json(configFor(user.id));
  });

  app.delete("/", (c) => c.json({ deleted: scopeOf(ctx, c).logs.clear() }));

  app.get("/:id", (c) => {
    const row = scopeOf(ctx, c).logs.get(Number(c.req.param("id")));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  });

  return app;
}
