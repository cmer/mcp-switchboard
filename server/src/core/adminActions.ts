import type { Db } from "../db/index.js";
import type { ServerRequestRow, ServerRow } from "../db/schema.js";
import { decrypt } from "../lib/crypto.js";
import { probeAuth, type ProbeResult } from "../lib/authProbe.js";
import type { ParsedServer } from "../lib/importParser.js";
import type { ChangedKind } from "./upstreamConnection.js";
import type { UpstreamManager } from "./upstreamManager.js";
import type { NewServer, NewServerRequest, ScopeError, UserScope } from "./userScope.js";

/**
 * The slice of the app the mutating actions need. Deliberately narrower than
 * `AppContext`: the agent-facing meta-tools reach these through
 * `AgentServerDeps`, which cannot see the hub (the hub builds agent servers).
 *
 * Whose data an action touches is never in here: every action takes the `UserScope` it acts in.
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

export type InsertServerInput = NewServer;
export type InsertServerResult = { row: ServerRow } | ScopeError;

/** Shared by the REST create/import routes and the management meta-tools. Does NOT reconcile — callers do that once. */
export function insertServer(scope: UserScope, input: InsertServerInput): InsertServerResult {
  return scope.servers.create(input);
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
  /** The owner's agents to flip on in the matrix for every server that gets created. */
  enableForAgentIds?: number[];
}

/**
 * Create servers owned by `scope`'s user from parsed configs: OAuth upgrade, insert, one
 * reconcile, matrix rows, then `list_changed` for every agent whose toolset just grew.
 */
export async function addServers(
  deps: AdminDeps,
  scope: UserScope,
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
    insertServer(scope, { enabled: true, ...p, createdByAgentSlug: opts.createdByAgentSlug }),
  );
  const created = results.flatMap((r) => ("row" in r ? [r.row] : []));
  if (created.length > 0) await (deps.reconcile ? deps.reconcile() : deps.manager.reconcile());

  for (const agentId of opts.enableForAgentIds ?? []) {
    const switched = created.filter((row) => scope.matrix.set(agentId, row.id, true));
    if (switched.length > 0) deps.notifyAgent?.(agentId);
  }
  return results;
}

/**
 * Flip one matrix cell. Live sessions of this agent see the change immediately. False when the
 * agent or the server isn't `scope`'s user's to link.
 */
export function setMatrix(
  deps: AdminDeps,
  scope: UserScope,
  agentId: number,
  serverId: number,
  enabled: boolean,
): boolean {
  if (!scope.matrix.set(agentId, serverId, enabled)) return false;
  deps.notifyAgent?.(agentId);
  return true;
}

export type FileRequestInput = NewServerRequest;

/**
 * Park an ask in the owner's approval queue — or the Admin's, for a local command the owner
 * can't run. Returns the request id to quote back, and whether it went to the Admin.
 */
export function fileServerRequest(scope: UserScope, input: FileRequestInput): { id: number; escalated: boolean } {
  return scope.requests.file(input);
}

/**
 * Approve an `add_server` request in its requester's scope: the server is created owned by the
 * requester, with the payload's values, and switched on for the requesting agent. Who may
 * approve (the requester, or the Admin for an escalated one) is the caller's check.
 */
export async function approveServerRequest(
  deps: AdminDeps,
  requester: UserScope,
  id: number,
): Promise<InsertServerResult> {
  const row = requester.requests.get(id);
  if (!row) return { error: "Not found", status: 404 };
  if (row.status !== "pending") return { error: "Request already resolved", status: 409 };
  if (row.kind !== "add_server") {
    return {
      error: "Freeform requests can't be auto-executed — deny with a note, or add the server manually",
      status: 400,
    };
  }
  const payload = requestPayload(row);
  if (!payload) return { error: "Request has no stored config", status: 400 };

  // The requester, if it is still around. The slug fallback stays inside the requester's own agents.
  const agent =
    (row.requestedByAgentId !== null ? requester.agents.get(row.requestedByAgentId) : undefined) ??
    (row.requestedByAgentSlug ? requester.agents.bySlug(row.requestedByAgentSlug) : undefined);

  // Same executor the UI import uses: insert → reconcile → matrix → list_changed,
  // so the requesting agent's live session grows its toolset on approval.
  const [result] = await addServers(deps, requester, [payload], {
    createdByAgentSlug: row.requestedByAgentSlug || undefined,
    enableForAgentIds: agent ? [agent.id] : [],
  });
  // Left pending on failure (e.g. the slug got taken since) so it can be retried or denied.
  if ("error" in result) return result;
  requester.requests.resolve(id, { status: "approved" });
  return result;
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
  cwd: string | null;
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
    cwd: payload.cwd ?? null,
    url: payload.url ?? null,
    authType: payload.authType,
    envKeys: payload.env ? Object.keys(payload.env) : [],
  };
}
