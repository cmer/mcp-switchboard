import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { oauthCredentials, type ServerRow } from "../../db/schema.js";
import { decrypt } from "../../lib/crypto.js";
import { parseImport, type ParsedServer } from "../../lib/importParser.js";
import { slugify } from "../../lib/slug.js";
import { addServers, detectAuth, fileServerRequest, insertServer } from "../../core/adminActions.js";
import { nsName } from "../../core/namespace.js";
import { userScope, type OwnedShare, type UserScope } from "../../core/userScope.js";
import { adminDeps, type AppContext } from "../context.js";
import { serializeOwnedShare } from "./shares.js";

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
  // null = clear the stored secret; undefined = leave unchanged; a null value = keep that key's stored value
  env: z.record(z.string(), z.string().nullable()).nullish(),
  bearerToken: z.string().nullish(),
  headers: z.record(z.string(), z.string().nullable()).nullish(),
});

/** Exported so an approved request can return exactly the shape GET /api/servers/:id does. */
export function serializeServer(ctx: AppContext, row: ServerRow, sharedWith: OwnedShare[] = []) {
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
    createdByAgentSlug: row.createdByAgentSlug,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // live status
    state: row.enabled ? (conn?.state ?? "connecting") : "disabled",
    lastError: conn?.lastError ?? null,
    toolCount: conn?.toolsCache.length ?? 0,
    oauthStatus: oauthRow?.status ?? null,
    tokenExpiresAt: oauthRow?.tokenExpiresAt ?? null,
    // Who it is shared with (names and usage), for the "shared with …" badge without a call per server.
    sharedWith: sharedWith.map(serializeOwnedShare),
  };
}

/** Said back when a local command is filed for the Admin instead of being created. */
export const LOCAL_COMMAND_ESCALATED_NOTE =
  "Local commands need the Admin's approval on this switchboard — it's waiting for the Admin";

/** Changing any of these on a local server changes what runs on the host. */
const LOCAL_COMMAND_FIELDS = ["type", "command", "args", "env", "cwd"] as const;

/** File a local server the caller may not run as an escalated request (they can cancel it). */
function escalate(scope: UserScope, server: ParsedServer): number {
  return fileServerRequest(scope, {
    agentId: null,
    agentSlug: "",
    kind: "add_server",
    payload: server,
    reason: `Added in the web UI by ${scope.user.username}`,
  }).id;
}

const scopeOf = (ctx: AppContext, c: Context) => userScope(ctx.db, c.get("user"));

const importSchema = z.object({ text: z.string().min(1), dryRun: z.boolean().optional().default(false) });

export function serverRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const scope = scopeOf(ctx, c);
    const shared = scope.shares.summaries();
    return c.json(scope.servers.list().map((r) => serializeServer(ctx, r, shared.get(r.id))));
  });

  app.post("/", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const scope = scopeOf(ctx, c);
    const input = parsed.data;

    if (input.type === "stdio" && !scope.canRunLocalCommands) {
      // Checked now, so the Admin isn't handed a request that can't be approved as filed.
      const slug = input.slug ?? slugify(input.name);
      const bad = scope.servers.checkSlug(slug);
      if (bad) return c.json({ error: bad.error }, bad.status);
      if (!input.command) return c.json({ error: "Local servers need a command" }, 400);
      const requestId = escalate(scope, {
        name: input.name,
        slug,
        type: "stdio",
        command: input.command,
        args: input.args,
        env: input.env,
        cwd: input.cwd ?? null,
        description: input.description ?? null,
        authType: "none",
      });
      return c.json({ requested: true, requestId, escalated: true, message: LOCAL_COMMAND_ESCALATED_NOTE }, 202);
    }

    const result = insertServer(scope, input);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    await ctx.manager.reconcile();
    return c.json(serializeServer(ctx, result.row), 201);
  });

  app.post("/import", async (c) => {
    const body = importSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Body must be { text, dryRun? }" }, 400);

    const scope = scopeOf(ctx, c);
    let parsed;
    try {
      parsed = parseImport(body.data.text);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Could not parse input" }, 400);
    }

    if (body.data.dryRun) {
      const detected = await detectAuth(parsed);
      for (let i = 0; i < parsed.length; i++) {
        if (detected[i] === "oauth") parsed[i].authType = "oauth";
      }
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
          slugTaken: scope.servers.checkSlug(p.slug)?.status === 409,
          // Saving files it for the Admin instead of creating it.
          needsApproval: p.type === "stdio" && !scope.canRunLocalCommands,
        })),
      });
    }

    // Local commands the caller can't run become escalated requests, one per server.
    const direct = parsed.filter((p) => p.type !== "stdio" || scope.canRunLocalCommands);
    const requested: { name: string; slug: string; requestId: number }[] = [];
    const errors: { name: string; error: string }[] = [];
    for (const p of parsed) {
      if (direct.includes(p)) continue;
      const bad = scope.servers.checkSlug(p.slug);
      if (bad) errors.push({ name: p.name, error: bad.error });
      else requested.push({ name: p.name, slug: p.slug, requestId: escalate(scope, p) });
    }

    const results = await addServers(adminDeps(ctx), scope, direct);
    const created: ReturnType<typeof serializeServer>[] = [];
    results.forEach((result, i) => {
      if ("error" in result) errors.push({ name: direct[i].name, error: result.error });
      else created.push(serializeServer(ctx, result.row));
    });
    const nothingDone = created.length === 0 && requested.length === 0;
    return c.json(
      {
        created,
        errors,
        ...(requested.length > 0 ? { requested, message: LOCAL_COMMAND_ESCALATED_NOTE } : {}),
      },
      errors.length > 0 && nothingDone ? 400 : 201,
    );
  });

  app.get("/:id", (c) => {
    const scope = scopeOf(ctx, c);
    const row = scope.servers.get(Number(c.req.param("id")));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(serializeServer(ctx, row, scope.shares.forServer(row.id)));
  });

  app.patch("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const scope = scopeOf(ctx, c);
    const row = scope.servers.get(id);
    if (!row) return c.json({ error: "Not found" }, 404);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const input = parsed.data;

    // Approved local servers stay usable (rename, describe, switch off), but what runs is the Admin's call.
    const staysLocal = (input.type ?? row.type) === "stdio";
    if (staysLocal && !scope.canRunLocalCommands && LOCAL_COMMAND_FIELDS.some((k) => input[k] !== undefined)) {
      return c.json({ error: "Changing a local command needs the Admin's \"can run local commands\" permission" }, 403);
    }

    const result = scope.servers.update(id, input);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    await ctx.manager.reconcile();
    for (const agentId of result.affectedAgentIds) ctx.hub.notifyAgent(agentId);
    return c.json(serializeServer(ctx, result.row, scope.shares.forServer(id)));
  });

  app.delete("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const scope = scopeOf(ctx, c);
    if (!scope.servers.get(id)) return c.json({ error: "Not found" }, 404);
    ctx.refresher.cancel(id);
    const { affectedAgentIds } = scope.servers.remove(id)!;
    await ctx.manager.reconcile();
    for (const agentId of affectedAgentIds) ctx.hub.notifyAgent(agentId);
    return c.json({ ok: true });
  });

  app.post("/:id/restart", async (c) => {
    const id = Number(c.req.param("id"));
    if (!scopeOf(ctx, c).servers.get(id)) return c.json({ error: "Server not found or disabled" }, 404);
    const ok = await ctx.manager.restart(id);
    if (!ok) return c.json({ error: "Server not found or disabled" }, 404);
    return c.json({ ok: true });
  });

  // stderr can carry anything the server printed: its owner's eyes only.
  app.get("/:id/logs", (c) => {
    const id = Number(c.req.param("id"));
    if (!scopeOf(ctx, c).servers.get(id)) return c.json({ error: "Not found" }, 404);
    return c.json({ lines: ctx.manager.get(id)?.stderrLog.toArray() ?? [] });
  });

  app.get("/:id/tools", (c) => {
    const id = Number(c.req.param("id"));
    const row = scopeOf(ctx, c).servers.get(id);
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

  // Only the owner authorizes: the tokens it produces are theirs.
  app.post("/:id/oauth/start", async (c) => {
    const id = Number(c.req.param("id"));
    const row = scopeOf(ctx, c).servers.get(id);
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
      let msg = err instanceof Error ? err.message : String(err);
      if (/invalid_redirect_uri|redirect[_ ]uri/i.test(msg)) {
        msg +=
          ` — the redirect URI is ${provider.redirectUrl}. Most providers only accept https or a` +
          " loopback (localhost / 127.0.0.1) address, so set PUBLIC_URL accordingly and try again.";
      }
      if (/dynamic client registration/i.test(msg)) {
        msg +=
          " — this provider requires a pre-registered OAuth app, which MCP clients can't do automatically. Use a bearer token / API key instead (e.g. a GitHub personal access token).";
      }
      return c.json({ error: msg }, 502);
    }
  });

  return app;
}
