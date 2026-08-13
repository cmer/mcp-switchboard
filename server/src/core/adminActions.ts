import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  agentServers,
  agents,
  oauthCredentials,
  serverRequests,
  servers,
  type ServerRequestRow,
  type ServerRow,
} from "../db/schema.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { probeAuth, type ProbeResult } from "../lib/authProbe.js";
import type { ParsedServer } from "../lib/importParser.js";
import { readSetting } from "../lib/settings.js";
import { isReservedSlug, isValidSlug, slugify } from "../lib/slug.js";
import type { ChangedKind } from "./upstreamConnection.js";
import type { UpstreamManager } from "./upstreamManager.js";

/**
 * The slice of the app the mutating actions need. Deliberately narrower than
 * `AppContext`: the agent-facing meta-tools reach these through
 * `AgentServerDeps`, which cannot see the hub (the hub builds agent servers).
 */
export interface AdminDeps {
  db: Db;
  manager: UpstreamManager;
  /** Wired from the hub in index.ts; absent in tests and before the hub exists. */
  notifyAgent?: (agentId: number, kind?: ChangedKind) => void;
  /** Defaults to `manager.reconcile()`; injectable so tests don't dial real upstreams. */
  reconcile?: () => Promise<void>;
  /** Defaults to `probeAuth`; injectable so tests don't do network I/O. */
  probe?: (url: string) => Promise<ProbeResult>;
}

export interface InsertServerInput {
  name: string;
  slug?: string;
  description?: string | null;
  type: "stdio" | "http" | "sse";
  enabled?: boolean;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  // remote
  url?: string;
  authType?: "none" | "bearer" | "headers" | "oauth";
  bearerToken?: string;
  headers?: Record<string, string>;
  createdByAgentSlug?: string | null;
}

export type InsertServerResult = { row: ServerRow } | { error: string; status: 400 | 409 };

/** Shared by the REST create/import routes and the management meta-tools. Does NOT reconcile — callers do that once. */
export function insertServer(deps: AdminDeps, input: InsertServerInput): InsertServerResult {
  const slug = input.slug ?? slugify(input.name);
  if (!isValidSlug(slug)) {
    return { error: "Slug must be 1-64 chars of a-z, 0-9, and dashes (no underscores)", status: 400 };
  }
  if (isReservedSlug(slug)) {
    return { error: `Slug "${slug}" is reserved for the switchboard's own tools`, status: 400 };
  }
  if (deps.db.select().from(servers).where(eq(servers.slug, slug)).get()) {
    return { error: `Slug "${slug}" is already in use`, status: 409 };
  }
  if (input.type === "stdio" && !input.command) return { error: "Local servers need a command", status: 400 };
  if (input.type !== "stdio" && !input.url) return { error: "Remote servers need a URL", status: 400 };

  const now = Date.now();
  const row = deps.db
    .insert(servers)
    .values({
      slug,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      enabled: input.enabled ?? true,
      command: input.command ?? null,
      argsJson: input.args ? JSON.stringify(input.args) : null,
      envJsonEnc: input.env && Object.keys(input.env).length > 0 ? encrypt(JSON.stringify(input.env)) : null,
      cwd: input.cwd ?? null,
      url: input.url ?? null,
      authType: input.type === "stdio" ? "none" : (input.authType ?? "none"),
      bearerTokenEnc: input.bearerToken ? encrypt(input.bearerToken) : null,
      headersJsonEnc:
        input.headers && Object.keys(input.headers).length > 0 ? encrypt(JSON.stringify(input.headers)) : null,
      createdByAgentSlug: input.createdByAgentSlug ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  if (row.authType === "oauth") {
    deps.db.insert(oauthCredentials).values({ serverId: row.id, status: "needs_auth", updatedAt: now }).run();
  }

  // Optional convenience (Settings → General): new servers start enabled for every agent.
  if (readSetting(deps.db, "autoEnableNewServers") === "1") {
    for (const agent of deps.db.select({ id: agents.id }).from(agents).all()) {
      deps.db.insert(agentServers).values({ agentId: agent.id, serverId: row.id, enabled: true }).run();
    }
  }
  return { row };
}

/**
 * Probe remote no-auth entries in parallel to detect servers that actually
 * require OAuth (or some token) before we save a config that would just 401.
 */
export async function detectAuth(
  parsed: ParsedServer[],
  probe: (url: string) => Promise<ProbeResult> = probeAuth,
): Promise<(ProbeResult | null)[]> {
  return Promise.all(
    parsed.map((p) => (p.type !== "stdio" && p.authType === "none" && p.url ? probe(p.url) : Promise.resolve(null))),
  );
}

export interface AddServersOptions {
  createdByAgentSlug?: string;
  /** Agents to flip on in the matrix for every server that gets created. */
  enableForAgentIds?: number[];
}

/**
 * Create servers from parsed configs: OAuth upgrade, insert, one reconcile,
 * matrix rows, then `list_changed` for every agent whose toolset just grew.
 */
export async function addServers(
  deps: AdminDeps,
  parsed: ParsedServer[],
  opts: AddServersOptions = {},
): Promise<InsertServerResult[]> {
  const detected = await detectAuth(parsed, deps.probe);
  // A detected OAuth server is imported as OAuth so it lands on "Needs auth"
  // with a one-click Authorize instead of failing with a 401.
  for (let i = 0; i < parsed.length; i++) {
    if (detected[i] === "oauth") parsed[i].authType = "oauth";
  }

  const results = parsed.map((p) =>
    insertServer(deps, { enabled: true, ...p, createdByAgentSlug: opts.createdByAgentSlug }),
  );
  const created = results.flatMap((r) => ("row" in r ? [r.row] : []));
  if (created.length > 0) await (deps.reconcile ? deps.reconcile() : deps.manager.reconcile());

  for (const agentId of opts.enableForAgentIds ?? []) {
    for (const row of created) upsertMatrix(deps, agentId, row.id, true);
    if (created.length > 0) deps.notifyAgent?.(agentId);
  }
  return results;
}

function upsertMatrix(deps: AdminDeps, agentId: number, serverId: number, enabled: boolean): void {
  const existing = deps.db
    .select()
    .from(agentServers)
    .where(and(eq(agentServers.agentId, agentId), eq(agentServers.serverId, serverId)))
    .get();
  if (existing) {
    deps.db
      .update(agentServers)
      .set({ enabled })
      .where(and(eq(agentServers.agentId, agentId), eq(agentServers.serverId, serverId)))
      .run();
  } else {
    deps.db.insert(agentServers).values({ agentId, serverId, enabled }).run();
  }
}

/** Flip one matrix cell. Live sessions of this agent see the change immediately. */
export function setMatrix(deps: AdminDeps, agentId: number, serverId: number, enabled: boolean): void {
  upsertMatrix(deps, agentId, serverId, enabled);
  deps.notifyAgent?.(agentId);
}

export interface FileRequestInput {
  agentId: number | null;
  agentSlug: string;
  kind: "add_server" | "freeform";
  /** The exact config the admin will approve; null for a freeform ask. */
  payload?: ParsedServer | null;
  reason?: string | null;
}

/** Park an agent's ask in the approval queue. Returns the request id to quote back to the agent. */
export function fileServerRequest(deps: AdminDeps, input: FileRequestInput): number {
  return deps.db
    .insert(serverRequests)
    .values({
      requestedByAgentId: input.agentId,
      requestedByAgentSlug: input.agentSlug,
      kind: input.kind,
      // Encrypted at rest: a pasted config can carry env values and bearer tokens.
      payloadJsonEnc: input.payload ? encrypt(JSON.stringify(input.payload)) : null,
      reason: input.reason ?? null,
      status: "pending",
      createdAt: Date.now(),
    })
    .returning({ id: serverRequests.id })
    .get().id;
}

export function requestPayload(row: ServerRequestRow): ParsedServer | null {
  return row.payloadJsonEnc ? (JSON.parse(decrypt(row.payloadJsonEnc)) as ParsedServer) : null;
}

export interface RequestServerSummary {
  name: string;
  slug: string;
  type: "stdio" | "http" | "sse";
  command: string | null;
  args: string[];
  url: string | null;
  authType: ParsedServer["authType"];
  envKeys: string[];
}

/**
 * What the admin (and the requesting agent) may see of a stored config: env *keys* but never
 * their values, and no bearer token — `authType` already says one is there.
 */
export function requestServerSummary(row: ServerRequestRow): RequestServerSummary | null {
  const payload = requestPayload(row);
  if (!payload) return null;
  return {
    name: payload.name,
    slug: payload.slug,
    type: payload.type,
    command: payload.command ?? null,
    args: payload.args ?? [],
    url: payload.url ?? null,
    authType: payload.authType,
    envKeys: payload.env ? Object.keys(payload.env) : [],
  };
}
