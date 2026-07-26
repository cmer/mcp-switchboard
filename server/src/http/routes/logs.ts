import { Hono } from "hono";
import { z } from "zod";
import { and, asc, count, desc, eq, gt, gte, isNotNull, isNull, like, lt, or, type SQL } from "drizzle-orm";
import { requestLogs } from "../../db/schema.js";
import { LOG_SETTING_KEYS, LOG_SUMMARY_COLUMNS, type LogEvent } from "../../core/requestLogger.js";
import { writeSetting } from "../../lib/settings.js";
import type { AppContext } from "../context.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
/** Comments keep proxies (and their idle timeouts) from closing an otherwise silent stream. */
const SSE_KEEPALIVE_MS = 25_000;
/** Anything above this is flagged amber in the UI and matched by `?status=slow`. */
const SLOW_MS = 1_000;

const settingsSchema = z.object({
  retentionHours: z.number().int().min(1).max(24 * 365).optional(),
  capturePayloads: z.boolean().optional(),
  maxPayloadKb: z.number().int().min(1).max(1024).optional(),
});

/**
 * `serverSlug` null means the request spans every enabled server (tools/list, initialize …),
 * so those rows stay visible whichever server you filter by.
 */
function buildWhere(query: Record<string, string | undefined>): SQL | undefined {
  const clauses: (SQL | undefined)[] = [];

  if (query.agent) clauses.push(eq(requestLogs.agentSlug, query.agent));
  if (query.server) clauses.push(or(eq(requestLogs.serverSlug, query.server), isNull(requestLogs.serverSlug)));
  if (query.method) clauses.push(eq(requestLogs.method, query.method));
  if (query.status === "error" || query.status === "pending") clauses.push(eq(requestLogs.status, query.status));
  if (query.status === "slow") clauses.push(gt(requestLogs.durationMs, SLOW_MS));
  if (query.before) clauses.push(lt(requestLogs.id, Number(query.before)));

  const q = query.q?.trim();
  if (q) {
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    clauses.push(
      or(
        like(requestLogs.target, pattern),
        like(requestLogs.method, pattern),
        like(requestLogs.summary, pattern),
        like(requestLogs.errorMessage, pattern),
        like(requestLogs.agentSlug, pattern),
      ),
    );
  }

  const defined = clauses.filter((c): c is SQL => c !== undefined);
  return defined.length === 0 ? undefined : and(...defined);
}

export function logRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const query = c.req.query();
    const limit = Math.min(Number(query.limit) || DEFAULT_LIMIT, MAX_LIMIT);
    const rows = ctx.db
      .select(LOG_SUMMARY_COLUMNS)
      .from(requestLogs)
      .where(buildWhere(query))
      .orderBy(desc(requestLogs.id))
      .limit(limit)
      .all();
    return c.json({ rows, config: ctx.logger.config });
  });

  // Live tail. The UI falls back to polling when a proxy won't pass this through.
  app.get("/stream", (c) => {
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
        const unsubscribe = ctx.logger.subscribe((event: LogEvent) => write(`data: ${JSON.stringify(event)}\n\n`));
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

  // Headline numbers for the last 24h. SQLite has no percentile function, so we
  // pick the nth row of the sorted durations instead.
  app.get("/stats", (c) => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const tally = (extra?: SQL) =>
      ctx.db
        .select({ n: count() })
        .from(requestLogs)
        .where(extra ? and(gte(requestLogs.ts, since), extra) : gte(requestLogs.ts, since))
        .get()?.n ?? 0;

    const total = tally();
    const errors = tally(eq(requestLogs.status, "error"));
    const timed = tally(isNotNull(requestLogs.durationMs));
    const percentile = (fraction: number): number | null => {
      if (timed === 0) return null;
      const row = ctx.db
        .select({ ms: requestLogs.durationMs })
        .from(requestLogs)
        .where(and(gte(requestLogs.ts, since), isNotNull(requestLogs.durationMs)))
        .orderBy(asc(requestLogs.durationMs))
        .limit(1)
        .offset(Math.min(timed - 1, Math.floor(timed * fraction)))
        .get();
      return row?.ms ?? null;
    };

    return c.json({ total, errors, medianMs: percentile(0.5), p95Ms: percentile(0.95) });
  });

  app.get("/settings", (c) => c.json(ctx.logger.config));

  app.put("/settings", async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const { retentionHours, capturePayloads, maxPayloadKb } = parsed.data;
    if (retentionHours !== undefined) writeSetting(ctx.db, LOG_SETTING_KEYS.retentionHours, String(retentionHours));
    if (capturePayloads !== undefined) {
      writeSetting(ctx.db, LOG_SETTING_KEYS.capturePayloads, capturePayloads ? "1" : "0");
    }
    if (maxPayloadKb !== undefined) writeSetting(ctx.db, LOG_SETTING_KEYS.maxPayloadKb, String(maxPayloadKb));
    const config = ctx.logger.reloadConfig();
    // A shorter window should take effect now, not at the next sweep.
    if (retentionHours !== undefined) ctx.logger.prune();
    return c.json(config);
  });

  app.delete("/", (c) => c.json({ deleted: ctx.logger.clear() }));

  app.get("/:id", (c) => {
    const row = ctx.db
      .select()
      .from(requestLogs)
      .where(eq(requestLogs.id, Number(c.req.param("id"))))
      .get();
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  });

  return app;
}
