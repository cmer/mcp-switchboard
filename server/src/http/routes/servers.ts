import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { agentServers, agents, oauthCredentials, servers, type ServerRow } from "../../db/schema.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { probeAuth, type ProbeResult } from "../../lib/authProbe.js";
import { parseImport, type ParsedServer } from "../../lib/importParser.js";
import { isReservedSlug, isValidSlug, slugify } from "../../lib/slug.js";
import { nsName } from "../../core/namespace.js";
import { getSetting } from "./auth.js";
import type { AppContext } from "../context.js";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().optional(),
  description: z.string().max(500).nullish(),
  type: z.enum(["stdio", "http", "sse"]),
  enabled: z.boolean().optional().default(true),
  // stdio
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().nullish(),
  // remote
  url: z.string().url().optional(),
  authType: z.enum(["none", "bearer", "headers", "oauth"]).optional().default("none"),
  bearerToken: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const patchSchema = createSchema.partial().extend({
  // null = clear the stored secret; undefined = leave unchanged
  env: z.record(z.string(), z.string()).nullish(),
  bearerToken: z.string().nullish(),
  headers: z.record(z.string(), z.string()).nullish(),
});

function serialize(ctx: AppContext, row: ServerRow) {
  const conn = ctx.manager.get(row.id);
  const oauthRow =
    row.authType === "oauth"
      ? ctx.db.select().from(oauthCredentials).where(eq(oauthCredentials.serverId, row.id)).get()
      : undefined;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    type: row.type,
    enabled: row.enabled,
    command: row.command,
    args: row.argsJson ? (JSON.parse(row.argsJson) as string[]) : [],
    cwd: row.cwd,
    url: row.url,
    authType: row.authType,
    hasEnv: !!row.envJsonEnc,
    envKeys: row.envJsonEnc ? Object.keys(JSON.parse(decrypt(row.envJsonEnc)) as Record<string, string>) : [],
    hasBearerToken: !!row.bearerTokenEnc,
    hasHeaders: !!row.headersJsonEnc,
    headerKeys: row.headersJsonEnc ? Object.keys(JSON.parse(decrypt(row.headersJsonEnc)) as Record<string, string>) : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // live status
    state: row.enabled ? (conn?.state ?? "connecting") : "disabled",
    lastError: conn?.lastError ?? null,
    toolCount: conn?.toolsCache.length ?? 0,
    oauthStatus: oauthRow?.status ?? null,
    tokenExpiresAt: oauthRow?.tokenExpiresAt ?? null,
  };
}

/** Agents that currently have this server enabled (notify them after a mutation). */
function affectedAgents(ctx: AppContext, serverId: number): number[] {
  return ctx.db
    .select({ agentId: agentServers.agentId })
    .from(agentServers)
    .where(and(eq(agentServers.serverId, serverId), eq(agentServers.enabled, true)))
    .all()
    .map((r) => r.agentId);
}

type CreateInput = z.infer<typeof createSchema>;

/** Shared by POST / and POST /import. Does NOT reconcile — callers do that once. */
function insertServer(ctx: AppContext, input: CreateInput): { row: ServerRow } | { error: string; status: 400 | 409 } {
  const slug = input.slug ?? slugify(input.name);
  if (!isValidSlug(slug)) {
    return { error: "Slug must be 1-64 chars of a-z, 0-9, and dashes (no underscores)", status: 400 };
  }
  if (isReservedSlug(slug)) {
    return { error: `Slug "${slug}" is reserved for the switchboard's own tools`, status: 400 };
  }
  if (ctx.db.select().from(servers).where(eq(servers.slug, slug)).get()) {
    return { error: `Slug "${slug}" is already in use`, status: 409 };
  }
  if (input.type === "stdio" && !input.command) return { error: "Local servers need a command", status: 400 };
  if (input.type !== "stdio" && !input.url) return { error: "Remote servers need a URL", status: 400 };

  const now = Date.now();
  const row = ctx.db
    .insert(servers)
    .values({
      slug,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      enabled: input.enabled,
      command: input.command ?? null,
      argsJson: input.args ? JSON.stringify(input.args) : null,
      envJsonEnc: input.env && Object.keys(input.env).length > 0 ? encrypt(JSON.stringify(input.env)) : null,
      cwd: input.cwd ?? null,
      url: input.url ?? null,
      authType: input.type === "stdio" ? "none" : input.authType,
      bearerTokenEnc: input.bearerToken ? encrypt(input.bearerToken) : null,
      headersJsonEnc:
        input.headers && Object.keys(input.headers).length > 0 ? encrypt(JSON.stringify(input.headers)) : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  if (row.authType === "oauth") {
    ctx.db.insert(oauthCredentials).values({ serverId: row.id, status: "needs_auth", updatedAt: now }).run();
  }

  // Optional convenience (Settings → General): new servers start enabled for every agent.
  if (getSetting(ctx, "autoEnableNewServers") === "1") {
    for (const agent of ctx.db.select({ id: agents.id }).from(agents).all()) {
      ctx.db.insert(agentServers).values({ agentId: agent.id, serverId: row.id, enabled: true }).run();
    }
  }
  return { row };
}

const importSchema = z.object({ text: z.string().min(1), dryRun: z.boolean().optional().default(false) });

/**
 * Probe remote no-auth entries in parallel to detect servers that actually
 * require OAuth (or some token) before we save a config that would just 401.
 */
async function detectAuth(parsed: ParsedServer[]): Promise<(ProbeResult | null)[]> {
  return Promise.all(
    parsed.map((p) =>
      p.type !== "stdio" && p.authType === "none" && p.url ? probeAuth(p.url) : Promise.resolve(null),
    ),
  );
}

export function serverRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const rows = ctx.db.select().from(servers).all();
    return c.json(rows.map((r) => serialize(ctx, r)));
  });

  app.post("/", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const result = insertServer(ctx, parsed.data);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    await ctx.manager.reconcile();
    return c.json(serialize(ctx, result.row), 201);
  });

  app.post("/import", async (c) => {
    const body = importSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Body must be { text, dryRun? }" }, 400);

    let parsed;
    try {
      parsed = parseImport(body.data.text);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Could not parse input" }, 400);
    }

    const detected = await detectAuth(parsed);
    // A detected OAuth server is imported as OAuth so it lands on "Needs auth"
    // with a one-click Authorize instead of failing with a 401.
    for (let i = 0; i < parsed.length; i++) {
      if (detected[i] === "oauth") parsed[i].authType = "oauth";
    }

    if (body.data.dryRun) {
      return c.json({
        servers: parsed.map((p, i) => ({
          name: p.name,
          slug: p.slug,
          type: p.type,
          command: p.command ?? null,
          args: p.args ?? [],
          url: p.url ?? null,
          authType: p.authType,
          detectedAuth: detected[i] === "oauth" || detected[i] === "auth_required" ? detected[i] : null,
          envKeys: p.env ? Object.keys(p.env) : [],
          slugTaken: !!ctx.db.select().from(servers).where(eq(servers.slug, p.slug)).get(),
        })),
      });
    }

    const created: ReturnType<typeof serialize>[] = [];
    const errors: { name: string; error: string }[] = [];
    for (const p of parsed) {
      const result = insertServer(ctx, { enabled: true, ...p });
      if ("error" in result) errors.push({ name: p.name, error: result.error });
      else created.push(serialize(ctx, result.row));
    }
    if (created.length > 0) await ctx.manager.reconcile();
    return c.json({ created, errors }, errors.length > 0 && created.length === 0 ? 400 : 201);
  });

  app.get("/:id", (c) => {
    const row = ctx.db.select().from(servers).where(eq(servers.id, Number(c.req.param("id")))).get();
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(serialize(ctx, row));
  });

  app.patch("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const row = ctx.db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const input = parsed.data;

    if (input.slug !== undefined) {
      if (!isValidSlug(input.slug)) {
        return c.json({ error: "Slug must be 1-64 chars of a-z, 0-9, and dashes (no underscores)" }, 400);
      }
      if (isReservedSlug(input.slug)) {
        return c.json({ error: `Slug "${input.slug}" is reserved for the switchboard's own tools` }, 400);
      }
      const clash = ctx.db.select().from(servers).where(eq(servers.slug, input.slug)).get();
      if (clash && clash.id !== id) return c.json({ error: `Slug "${input.slug}" is already in use` }, 409);
    }

    const wasOauth = row.authType === "oauth";
    const values: Partial<typeof servers.$inferInsert> = { updatedAt: Date.now() };
    if (input.name !== undefined) values.name = input.name;
    if (input.slug !== undefined) values.slug = input.slug;
    if (input.description !== undefined) values.description = input.description || null;
    if (input.type !== undefined) values.type = input.type;
    if (input.enabled !== undefined) values.enabled = input.enabled;
    if (input.command !== undefined) values.command = input.command;
    if (input.args !== undefined) values.argsJson = JSON.stringify(input.args);
    if (input.cwd !== undefined) values.cwd = input.cwd;
    if (input.url !== undefined) values.url = input.url;
    if (input.authType !== undefined) values.authType = input.authType;
    if (input.env !== undefined) {
      values.envJsonEnc = input.env && Object.keys(input.env).length > 0 ? encrypt(JSON.stringify(input.env)) : null;
    }
    if (input.bearerToken !== undefined) {
      values.bearerTokenEnc = input.bearerToken ? encrypt(input.bearerToken) : null;
    }
    if (input.headers !== undefined) {
      values.headersJsonEnc =
        input.headers && Object.keys(input.headers).length > 0 ? encrypt(JSON.stringify(input.headers)) : null;
    }

    const affected = affectedAgents(ctx, id);
    const updated = ctx.db.update(servers).set(values).where(eq(servers.id, id)).returning().get();

    if (updated.authType === "oauth" && !wasOauth) {
      ctx.db
        .insert(oauthCredentials)
        .values({ serverId: id, status: "needs_auth", updatedAt: Date.now() })
        .onConflictDoNothing()
        .run();
    }
    await ctx.manager.reconcile();
    for (const agentId of affected) ctx.hub.notifyAgent(agentId);
    return c.json(serialize(ctx, updated));
  });

  app.delete("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const row = ctx.db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);
    const affected = affectedAgents(ctx, id);
    ctx.refresher.cancel(id);
    ctx.db.delete(servers).where(eq(servers.id, id)).run();
    await ctx.manager.reconcile();
    for (const agentId of affected) ctx.hub.notifyAgent(agentId);
    return c.json({ ok: true });
  });

  app.post("/:id/restart", async (c) => {
    const id = Number(c.req.param("id"));
    const ok = await ctx.manager.restart(id);
    if (!ok) return c.json({ error: "Server not found or disabled" }, 404);
    return c.json({ ok: true });
  });

  app.get("/:id/logs", (c) => {
    const conn = ctx.manager.get(Number(c.req.param("id")));
    return c.json({ lines: conn?.stderrLog.toArray() ?? [] });
  });

  app.get("/:id/tools", (c) => {
    const id = Number(c.req.param("id"));
    const row = ctx.db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);
    const conn = ctx.manager.get(id);
    return c.json({
      tools: (conn?.toolsCache ?? []).map((t) => ({
        name: t.name,
        namespacedName: nsName(row.slug, t.name),
        description: t.description ?? "",
      })),
      prompts: (conn?.promptsCache ?? []).map((p) => ({ name: p.name, description: p.description ?? "" })),
      resources: (conn?.resourcesCache ?? []).map((r) => ({ uri: r.uri, name: r.name ?? "" })),
    });
  });

  app.post("/:id/oauth/start", async (c) => {
    const id = Number(c.req.param("id"));
    const row = ctx.db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.authType !== "oauth" || !row.url) return c.json({ error: "Server is not OAuth-configured" }, 400);

    const provider = ctx.makeOAuthProvider(id);
    try {
      const result = await auth(provider, { serverUrl: row.url });
      if (result === "AUTHORIZED") {
        ctx.refresher.schedule(id);
        await ctx.manager.restart(id);
        return c.json({ authorized: true });
      }
      const authorizeUrl = provider.capturedAuthorizationUrl?.toString();
      if (!authorizeUrl) return c.json({ error: "Authorization URL was not produced" }, 500);
      return c.json({ authorized: false, authorizeUrl });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  return app;
}
