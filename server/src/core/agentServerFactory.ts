import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Prompt,
  type Resource,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { and, desc, eq, or } from "drizzle-orm";
import { agentServers, agents, serverRequests, servers, type AgentRow } from "../db/schema.js";
import { parseImport, type ParsedServer } from "../lib/importParser.js";
import { schemaToTs } from "../lib/schemaToTs.js";
import { readSetting } from "../lib/settings.js";
import {
  addServers,
  fileServerRequest,
  requestServerSummary,
  setMatrix,
  type AdminDeps,
} from "./adminActions.js";
import { nsName, nsResourceUri, parseNsName, parseNsResourceUri } from "./namespace.js";
import type { RequestLogger } from "./requestLogger.js";
import { paginate, searchTools, suggest, type SearchableTool } from "./toolSearch.js";
import type { UpstreamConnection } from "./upstreamConnection.js";

/**
 * Extends `AdminDeps` because the management meta-tools mutate the switchboard.
 * Its `notifyAgent` / `reconcile` callbacks are patched in from index.ts once
 * the hub exists — the hub builds these servers, so it can't be injected.
 */
export interface AgentServerDeps extends AdminDeps {
  version: string;
  /** Optional so tests can build agent servers without a logger. */
  logger?: RequestLogger;
}

export const META_TOOL_LIST_SERVERS = "switchboard__list_servers";
export const META_TOOL_ADD_SERVER = "switchboard__add_server";
export const META_TOOL_ASSIGN_SERVER = "switchboard__assign_server";
export const META_TOOL_LIST_AGENTS = "switchboard__list_agents";
export const META_TOOL_SERVER_STATUS = "switchboard__server_status";
export const META_TOOL_REQUEST_SERVER = "switchboard__request_server";
export const META_TOOL_REQUEST_STATUS = "switchboard__request_status";
export const META_TOOL_SEARCH_TOOLS = "switchboard__search_tools";
export const META_TOOL_DESCRIBE_TOOLS = "switchboard__describe_tools";
export const META_TOOL_CALL_TOOL = "switchboard__call_tool";

/** Every switchboard-owned tool is prefixed with the reserved slug, which no server may take. */
export const META_TOOL_PREFIX = "switchboard__";

/** Settings → General; "0" hides the request tools entirely. Unset (or anything else) = on. */
const REQUESTS_SETTING_KEY = "allowServerRequests";

/** Only manager agents see or may call these. */
const MANAGEMENT_TOOLS: Tool[] = [
  {
    name: META_TOOL_ADD_SERVER,
    description:
      "Register a new MCP server on the switchboard from a pasted config: a `claude mcp add …` line, an `mcpServers` JSON blob, or a single server object. Remote (http/sse) servers are created immediately; local stdio servers are filed as a request for the admin to approve, because running a command on the host needs a human. By default the new server is enabled for the calling agent, whose tool list updates in this same session.",
    inputSchema: {
      type: "object",
      properties: {
        config: {
          type: "string",
          description: "The config to import, exactly as found in a README (CLI line or JSON, code fences allowed).",
        },
        enable_for: {
          type: "array",
          items: { type: "string" },
          description: "Agent slugs to enable the new servers for. Defaults to the calling agent.",
        },
      },
      required: ["config"],
    },
  },
  {
    name: META_TOOL_ASSIGN_SERVER,
    description:
      "Enable or disable one server for one agent in the switchboard matrix. The target agent's live sessions are notified immediately.",
    inputSchema: {
      type: "object",
      properties: {
        server_slug: { type: "string", description: "Server slug (the tool-name prefix)." },
        agent_slug: { type: "string", description: "Agent slug, as listed by switchboard__list_agents." },
        enabled: { type: "boolean", description: "true to grant the server, false to revoke it." },
      },
      required: ["server_slug", "agent_slug", "enabled"],
    },
  },
  {
    name: META_TOOL_LIST_AGENTS,
    description:
      "List the agents configured on this switchboard: slug, name, role, and which servers each has enabled. Never returns tokens.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: META_TOOL_SERVER_STATUS,
    description:
      "Diagnose one server: connection state, last error, tool/prompt/resource counts, and recent stderr for local servers. Use it after adding a server that isn't working.",
    inputSchema: {
      type: "object",
      properties: { server_slug: { type: "string", description: "Server slug (the tool-name prefix)." } },
      required: ["server_slug"],
    },
  },
];

const MANAGEMENT_TOOL_NAMES = new Set(MANAGEMENT_TOOLS.map((t) => t.name));

/** Every agent gets these, unless the admin switched requests off. */
const REQUEST_TOOLS: Tool[] = [
  {
    name: META_TOOL_REQUEST_SERVER,
    description:
      "Ask the switchboard admin to add an MCP server. Include `config` (a `claude mcp add …` line, an `mcpServers` JSON blob, or a single server object) when you have one — otherwise describe what you need in `reason` alone. Returns immediately with a request id; nothing runs until a human approves. If it is approved, the new tools appear in this session automatically.",
    inputSchema: {
      type: "object",
      properties: {
        config: {
          type: "string",
          description: "Optional config to import, exactly as found in a README (CLI line or JSON, code fences allowed).",
        },
        reason: {
          type: "string",
          description: "Why you need this server — the admin reads this when deciding.",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: META_TOOL_REQUEST_STATUS,
    description:
      "Check the requests you filed with switchboard__request_server: status (pending/approved/denied) and the admin's note if there is one. Returns only this agent's own requests, newest first.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "A single request id. Omit for all of this agent's requests." } },
    },
  },
];

const REQUEST_TOOL_NAMES = new Set(REQUEST_TOOLS.map((t) => t.name));

/** Shown to every agent in both modes: the roster is how a model picks between similar servers. */
const LIST_SERVERS_TOOL: Tool = {
  name: META_TOOL_LIST_SERVERS,
  description:
    "List the MCP servers behind this switchboard for this agent: slug (the tool-name prefix), what each server/account is for, connection status, and tool count. Call this when unsure which server's tools to use — e.g. which of several connected accounts of the same service.",
  inputSchema: { type: "object", properties: {} },
};

/**
 * Lean mode's whole tool surface: instead of proxying every upstream tool, the agent gets a
 * constant three-call loop (search → describe → call). Descriptions stay terse because these
 * three are re-sent on every `tools/list`, which is exactly the cost lean mode exists to cut.
 */
const LEAN_TOOLS: Tool[] = [
  {
    name: META_TOOL_SEARCH_TOOLS,
    description:
      'Search this agent\'s available tools by intent, e.g. "create calendar event" or "list github issues". Returns ranked matches; then call switchboard__describe_tools before calling one.',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Short intent phrase. Required unless `server` is given." },
        server: {
          type: "string",
          description: "Restrict to one server slug (see the roster). With an empty query, enumerates that server's tools.",
        },
        limit: { type: "number", description: "Max results, default 10, cap 25." },
        offset: { type: "number", description: "Pagination offset from a previous nextOffset." },
      },
    },
  },
  {
    name: META_TOOL_DESCRIBE_TOOLS,
    description:
      "Get full details for tools found via switchboard__search_tools: description and input/output shapes as compact TypeScript.",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: 'Namespaced tool names, e.g. ["gmail__send_email"]. Max 8 per call.',
        },
      },
      required: ["names"],
    },
  },
  {
    name: META_TOOL_CALL_TOOL,
    description:
      'Call a tool by its namespaced name (from search results), e.g. { "name": "gmail__send_email", "arguments": { … } }.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Namespaced tool name: <server>__<tool>." },
        arguments: {
          type: "object",
          description: "Arguments matching the tool's inputType from switchboard__describe_tools.",
        },
      },
      required: ["name"],
    },
  },
];

const LEAN_TOOL_NAMES = new Set(LEAN_TOOLS.map((t) => t.name));

/** Search defaults: a page small enough to read, a cap small enough to stay cheap. */
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 25;
/** Descriptions are for triage in search results; the full text comes back from describe. */
const SEARCH_DESCRIPTION_CHARS = 160;
/** Describing more than a handful at once defeats the point of not listing everything. */
const DESCRIBE_MAX_NAMES = 8;

const STDIO_PENDING_NOTE =
  "stdio servers require admin approval — the admin will see this request in the web UI";

/** Read from the db on every call so a role toggle in the UI applies to sessions that are already live. */
function agentRole(deps: AgentServerDeps, agentId: number): string {
  return deps.db.select({ role: agents.role }).from(agents).where(eq(agents.id, agentId)).get()?.role ?? "standard";
}

/** Same freshness argument as the role: a mode toggle in the UI must apply to sessions already live. */
function toolMode(deps: AgentServerDeps, agentId: number): "full" | "lean" {
  return deps.db.select({ mode: agents.toolMode }).from(agents).where(eq(agents.id, agentId)).get()?.mode ?? "full";
}

/** Same freshness argument as the role: read per call so the Settings toggle hits live sessions. */
function requestsEnabled(deps: AgentServerDeps): boolean {
  return readSetting(deps.db, REQUESTS_SETTING_KEY) !== "0";
}

function jsonContent(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * A mistake the model can recover from on its own (bad slug, no query) comes back as a tool
 * error, not a protocol error: the model reads the text and retries in the same turn.
 */
function errorContent(text: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `"${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

/** Servers this agent has switched on, by slug — the projection used by list_agents. */
function enabledServerSlugs(deps: AgentServerDeps, agentId: number): string[] {
  return deps.db
    .select({ slug: servers.slug })
    .from(agentServers)
    .innerJoin(servers, eq(agentServers.serverId, servers.id))
    .where(and(eq(agentServers.agentId, agentId), eq(agentServers.enabled, true)))
    .all()
    .map((r) => r.slug);
}

/** Parse errors come back to the agent as a tool error so it can fix the config and retry. */
function parseConfigOrThrow(config: string): ParsedServer[] {
  try {
    return parseImport(config);
  } catch (err) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Could not parse config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function addServerTool(deps: AgentServerDeps, agent: AgentRow, args: Record<string, unknown>) {
  const config = requireString(args, "config");
  const parsed = parseConfigOrThrow(config);

  const warnings: string[] = [];
  const requested = Array.isArray(args.enable_for)
    ? args.enable_for.filter((s): s is string => typeof s === "string")
    : [agent.slug];
  const enableForAgentIds: number[] = [];
  for (const slug of requested) {
    const row = deps.db.select({ id: agents.id }).from(agents).where(eq(agents.slug, slug)).get();
    if (row) enableForAgentIds.push(row.id);
    else warnings.push(`Unknown agent slug "${slug}" — not enabled for it`);
  }

  // stdio = arbitrary command execution on the host: never created from a tool call,
  // whatever the caller's role. It goes to the human as a request instead.
  const remote = parsed.filter((p) => p.type !== "stdio");
  const results = await addServers(deps, remote, { createdByAgentSlug: agent.slug, enableForAgentIds });

  let next = 0;
  const outcomes = parsed.map((p) => {
    if (p.type === "stdio") {
      const requestId = fileServerRequest(deps, {
        agentId: agent.id,
        agentSlug: agent.slug,
        kind: "add_server",
        payload: p,
        reason: `Filed automatically from ${META_TOOL_ADD_SERVER} by "${agent.slug}"`,
      });
      return { slug: p.slug, status: "pending_approval", requestId, note: STDIO_PENDING_NOTE };
    }
    const result = results[next++];
    if ("error" in result) return { slug: p.slug, status: "error", error: result.error };
    if (result.row.authType === "oauth") {
      return { slug: result.row.slug, status: "needs_auth", note: "authorize in the web UI at /servers" };
    }
    const conn = deps.manager.get(result.row.id);
    return {
      slug: result.row.slug,
      status: conn?.state === "connected" ? "connected" : "connecting",
      toolCount: conn?.toolsCache.length ?? 0,
    };
  });

  return jsonContent(warnings.length > 0 ? { servers: outcomes, warnings } : { servers: outcomes });
}

function pendingMessage(ids: number[]): string {
  const label = ids.length === 1 ? `Request #${ids[0]}` : `Requests ${ids.map((id) => `#${id}`).join(", ")}`;
  return `${label} pending — the admin will review it. Your tools will update automatically if approved.`;
}

function requestServerTool(deps: AgentServerDeps, agent: AgentRow, args: Record<string, unknown>) {
  const reason = requireString(args, "reason");
  const config = typeof args.config === "string" && args.config.trim() !== "" ? args.config.trim() : null;

  // One row per parsed server, so the admin approves each config on its own merits.
  const ids = config
    ? parseConfigOrThrow(config).map((payload) =>
        fileServerRequest(deps, { agentId: agent.id, agentSlug: agent.slug, kind: "add_server", payload, reason }),
      )
    : [fileServerRequest(deps, { agentId: agent.id, agentSlug: agent.slug, kind: "freeform", reason })];

  return jsonContent({ requestIds: ids, message: pendingMessage(ids) });
}

function requestStatusTool(deps: AgentServerDeps, agent: AgentRow, args: Record<string, unknown>) {
  // Slug fallback covers rows filed before an agent was recreated; never widens past this agent.
  const mine = or(
    eq(serverRequests.requestedByAgentId, agent.id),
    eq(serverRequests.requestedByAgentSlug, agent.slug),
  );
  const where = typeof args.id === "number" ? and(mine, eq(serverRequests.id, args.id)) : mine;
  const rows = deps.db.select().from(serverRequests).where(where).orderBy(desc(serverRequests.id)).all();
  return jsonContent(
    rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      reason: row.reason,
      resolutionNote: row.resolutionNote,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
      server: requestServerSummary(row),
    })),
  );
}

function assignServerTool(deps: AgentServerDeps, args: Record<string, unknown>) {
  const serverSlug = requireString(args, "server_slug");
  const agentSlug = requireString(args, "agent_slug");
  if (typeof args.enabled !== "boolean") {
    throw new McpError(ErrorCode.InvalidParams, '"enabled" is required and must be a boolean');
  }
  const server = deps.db.select().from(servers).where(eq(servers.slug, serverSlug)).get();
  if (!server) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown server "${serverSlug}" — call ${META_TOOL_LIST_SERVERS}`);
  }
  const target = deps.db.select().from(agents).where(eq(agents.slug, agentSlug)).get();
  if (!target) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown agent "${agentSlug}" — call ${META_TOOL_LIST_AGENTS}`);
  }
  setMatrix(deps, target.id, server.id, args.enabled);
  return jsonContent({ serverSlug: server.slug, agentSlug: target.slug, enabled: args.enabled });
}

function listAgentsTool(deps: AgentServerDeps) {
  // Deliberately its own projection: the REST serializer returns decrypted tokens.
  const rows = deps.db
    .select({ id: agents.id, slug: agents.slug, name: agents.name, role: agents.role })
    .from(agents)
    .all();
  return jsonContent(
    rows.map((a) => ({ slug: a.slug, name: a.name, role: a.role, servers: enabledServerSlugs(deps, a.id) })),
  );
}

function serverStatusTool(deps: AgentServerDeps, args: Record<string, unknown>) {
  const slug = requireString(args, "server_slug");
  const row = deps.db.select().from(servers).where(eq(servers.slug, slug)).get();
  if (!row) throw new McpError(ErrorCode.InvalidParams, `Unknown server "${slug}" — call ${META_TOOL_LIST_SERVERS}`);
  const conn = deps.manager.get(row.id);
  return jsonContent({
    slug: row.slug,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    state: row.enabled ? (conn?.state ?? "connecting") : "disabled",
    lastError: conn?.lastError ?? null,
    toolCount: conn?.toolsCache.length ?? 0,
    promptCount: conn?.promptsCache.length ?? 0,
    resourceCount: conn?.resourcesCache.length ?? 0,
    ...(row.type === "stdio" ? { stderr: conn?.stderrLog.toArray().slice(-20) ?? [] } : {}),
  });
}

/**
 * Prefix a tool/prompt description with the server's note so the model can
 * disambiguate same-named tools from different accounts (kept terse on purpose).
 */
export function annotateDescription(
  slug: string,
  serverDescription: string | null,
  description: string | undefined,
): string | undefined {
  if (!serverDescription) return description;
  return `(via ${slug}: ${serverDescription}) ${description ?? ""}`.trimEnd();
}

/** All servers this agent has enabled in the matrix (connected or not), for the roster. */
function matrixServers(deps: AgentServerDeps, agentId: number) {
  return deps.db
    .select({
      id: servers.id,
      slug: servers.slug,
      name: servers.name,
      description: servers.description,
      type: servers.type,
      enabled: servers.enabled,
    })
    .from(agentServers)
    .innerJoin(servers, eq(agentServers.serverId, servers.id))
    .where(and(eq(agentServers.agentId, agentId), eq(agentServers.enabled, true)))
    .all();
}

function buildInstructions(deps: AgentServerDeps, agentId: number): string {
  const rows = matrixServers(deps, agentId).filter((r) => r.enabled);
  const roster =
    rows.length === 0
      ? "No servers are currently enabled for this agent."
      : rows
          .map((r) => `- ${r.slug}__* — ${r.name}${r.description ? `: ${r.description}` : ""}`)
          .join("\n");
  // Lean mode's instructions carry the search→describe→call loop, because the tool list no
  // longer shows the model what is available.
  const lines =
    toolMode(deps, agentId) === "lean"
      ? [
          "MCP Switchboard (lean mode): tools from multiple MCP servers are available by search, not listed upfront. Tool names are <server-slug>__<tool>.",
          "Workflow:",
          `1. ${META_TOOL_SEARCH_TOOLS} { query: "<intent + key nouns>" } — ranked matches.`,
          `2. ${META_TOOL_DESCRIBE_TOOLS} { names: [...] } — input/output shapes as TypeScript.`,
          `3. ${META_TOOL_CALL_TOOL} { name, arguments } — invoke the tool.`,
          `Search again with the \`server\` filter or a different phrasing if the first query misses. Call ${META_TOOL_LIST_SERVERS} for the roster and live status.`,
        ]
      : [
          "MCP Switchboard: aggregates multiple MCP servers. Tool and prompt names are prefixed with the upstream server slug as <server>__<name>; resource URIs as sb://<server>/….",
          "When several servers expose similar tools (e.g. multiple accounts of the same service), pick by prefix using the roster below.",
          `Call ${META_TOOL_LIST_SERVERS} for live status and details.`,
        ];
  if (requestsEnabled(deps)) {
    lines.push(
      `Need a server that isn't listed? ${META_TOOL_REQUEST_SERVER} files it for the admin to approve (paste the config if you have one); ${META_TOOL_REQUEST_STATUS} reads the verdict back.`,
    );
  }
  if (agentRole(deps, agentId) === "manager") {
    lines.push(
      "",
      `Management: this agent may reconfigure the switchboard. ${META_TOOL_ADD_SERVER} registers a remote MCP server from a pasted config, ${META_TOOL_ASSIGN_SERVER} grants or revokes a server for an agent, ${META_TOOL_LIST_AGENTS} shows the agent roster, and ${META_TOOL_SERVER_STATUS} diagnoses a server.`,
    );
  }
  lines.push("", "Servers:", roster);
  return lines.join("\n");
}

/** Connected upstream connections enabled for this agent, with their slugs. (Exported for tests.) */
export function enabledConnections(deps: AgentServerDeps, agentId: number): UpstreamConnection[] {
  const rows = deps.db
    .select({ serverId: agentServers.serverId })
    .from(agentServers)
    .innerJoin(servers, eq(agentServers.serverId, servers.id))
    .where(and(eq(agentServers.agentId, agentId), eq(agentServers.enabled, true), eq(servers.enabled, true)))
    .all();
  const out: UpstreamConnection[] = [];
  for (const { serverId } of rows) {
    const conn = deps.manager.get(serverId);
    if (conn && conn.state === "connected") out.push(conn);
  }
  return out;
}

/** Resolve a namespaced name to its (connection, bare name), enforcing the agent matrix. (Exported for tests.) */
export function resolveTarget(
  deps: AgentServerDeps,
  agentId: number,
  namespaced: string,
): { conn: UpstreamConnection; name: string } {
  const parsed = parseNsName(namespaced);
  if (!parsed) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown name "${namespaced}" (expected <server>__<name>)`);
  }
  const conn = deps.manager.getBySlug(parsed.slug);
  if (!conn) throw new McpError(ErrorCode.InvalidParams, `Unknown server "${parsed.slug}"`);
  const matrix = deps.db
    .select()
    .from(agentServers)
    .where(and(eq(agentServers.agentId, agentId), eq(agentServers.serverId, conn.serverId)))
    .get();
  if (!matrix?.enabled) {
    // Deliberately identical to the unknown-server error so an agent cannot probe which slugs
    // exist globally by comparing the two failures.
    throw new McpError(ErrorCode.InvalidParams, `Unknown server "${parsed.slug}"`);
  }
  return { conn, name: parsed.name };
}

/**
 * The catalog lean mode searches over, rebuilt per call: caches move (an upstream reconnects,
 * the matrix changes) and a stale search space would offer tools that can no longer be called.
 * Same projection as the full-mode tool list, minus the schemas.
 */
function searchSpace(deps: AgentServerDeps, agentId: number): SearchableTool[] {
  const space: SearchableTool[] = [];
  for (const conn of enabledConnections(deps, agentId)) {
    for (const tool of conn.toolsCache) {
      space.push({
        name: nsName(conn.row.slug, tool.name),
        server: conn.row.slug,
        description: annotateDescription(conn.row.slug, conn.row.description, tool.description),
      });
    }
  }
  return space;
}

/** Non-numbers (and NaN) behave as "not given" so a model passing `"10"` gets the default, not an error. */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function truncate(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function searchToolsTool(deps: AgentServerDeps, agentId: number, args: Record<string, unknown>) {
  const space = searchSpace(deps, agentId);
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const server = typeof args.server === "string" && args.server.trim() !== "" ? args.server.trim() : undefined;
  const limit = clampNumber(args.limit, SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX);
  const offset = clampNumber(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  // Dumping the whole catalog is exactly the cost lean mode exists to avoid, so an empty
  // search is refused rather than answered.
  if (query === "" && server === undefined) {
    return errorContent('Provide a query (e.g. "send email"), or a server slug to enumerate one server\'s tools.');
  }

  if (server !== undefined) {
    // Valid slugs come from this agent's own roster: an unknown slug never reveals another agent's servers.
    const valid = matrixServers(deps, agentId)
      .filter((r) => r.enabled)
      .map((r) => r.slug);
    if (!valid.includes(server)) {
      return errorContent(
        valid.length === 0
          ? `Unknown server "${server}" — no servers are enabled for this agent.`
          : `Unknown server "${server}" — this agent's servers are: ${valid.join(", ")}.`,
      );
    }
  }

  // Empty query + a server is the "show me what this one can do" case; scores are meaningless there.
  const matches =
    query === ""
      ? space
          .filter((tool) => tool.server === server)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((tool) => ({ ...tool, score: 0 }))
      : searchTools(space, query, { server });

  const page = paginate(matches, offset, limit);
  return jsonContent({
    items: page.items.map((match) => ({
      name: match.name,
      server: match.server,
      // Clipped for output only — scoring already saw the full text.
      description: truncate(match.description, SEARCH_DESCRIPTION_CHARS),
      score: match.score,
    })),
    total: page.total,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
  });
}

/**
 * One entry of a describe batch. A name the agent may not use is reported exactly like a name
 * that does not exist — otherwise the error itself would disclose servers this agent lacks.
 */
function describeOne(
  deps: AgentServerDeps,
  agentId: number,
  space: SearchableTool[],
  name: string,
): Record<string, unknown> {
  const notFound = () => ({ name, error: "tool_not_found", suggestions: suggest(space, name, 3) });

  let resolved: { conn: UpstreamConnection; name: string };
  try {
    resolved = resolveTarget(deps, agentId, name);
  } catch {
    return notFound();
  }
  const tool = resolved.conn.toolsCache.find((t) => t.name === resolved.name);
  if (!tool) return notFound();

  const entry: Record<string, unknown> = {
    name,
    server: resolved.conn.row.slug,
    description: annotateDescription(resolved.conn.row.slug, resolved.conn.row.description, tool.description),
  };
  // Null-prototype so a def named `__proto__` or `constructor` is stored as an ordinary key.
  const definitions: Record<string, string> = Object.create(null);
  const outputDefinitions: Record<string, string> = Object.create(null);

  // schemaToTs throws on anything that isn't a schema; one odd tool must not fail the batch,
  // so that entry falls back to the raw JSON Schema.
  const input = renderSchema(tool.inputSchema);
  if (input) {
    entry.inputType = input.type;
    for (const [key, value] of Object.entries(input.definitions)) definitions[key] = value;
  } else {
    entry.inputSchema = tool.inputSchema;
  }
  if (tool.outputSchema !== undefined) {
    const output = renderSchema(tool.outputSchema);
    if (output) {
      entry.outputType = output.type;
      // Input and output schemas each carry their own `$defs` and routinely reuse names for
      // different shapes. Overwriting would hand the model the wrong input contract, so a
      // conflicting output def is kept apart instead; identical ones just merge.
      for (const [key, value] of Object.entries(output.definitions)) {
        if (!Object.hasOwn(definitions, key)) definitions[key] = value;
        else if (definitions[key] !== value) outputDefinitions[key] = value;
      }
    } else {
      entry.outputSchema = tool.outputSchema;
    }
  }
  if (Object.keys(definitions).length > 0) entry.definitions = definitions;
  if (Object.keys(outputDefinitions).length > 0) entry.outputDefinitions = outputDefinitions;
  return entry;
}

function renderSchema(schema: unknown): { type: string; definitions: Record<string, string> } | null {
  try {
    return schemaToTs(schema);
  } catch {
    return null;
  }
}

function describeToolsTool(deps: AgentServerDeps, agentId: number, args: Record<string, unknown>) {
  const names = args.names;
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
    throw new McpError(ErrorCode.InvalidParams, '"names" is required and must be an array of namespaced tool names');
  }
  if (names.length > DESCRIBE_MAX_NAMES) {
    return errorContent(`Too many names — call with at most ${DESCRIBE_MAX_NAMES} per call.`);
  }
  const space = searchSpace(deps, agentId);
  return jsonContent({ tools: (names as string[]).map((name) => describeOne(deps, agentId, space, name)) });
}

/**
 * Progress forwarding for an upstream tool call, shared by the direct path and
 * switchboard__call_tool — the two must behave identically for the same tool.
 */
function upstreamCallOpts(
  progressToken: string | number | undefined,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  return {
    signal: extra.signal,
    onprogress:
      progressToken !== undefined
        ? (p: { progress: number; total?: number; message?: string }) => {
            void extra
              .sendNotification({ method: "notifications/progress", params: { progressToken, ...p } })
              .catch(() => {});
          }
        : undefined,
  };
}

async function callToolTool(
  deps: AgentServerDeps,
  agentId: number,
  args: Record<string, unknown>,
  progressToken: string | number | undefined,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  const name = requireString(args, "name");
  // Wrapping a meta-tool would route it back through resolveTarget as server "switchboard".
  if (name.startsWith(META_TOOL_PREFIX)) {
    return errorContent(`Meta-tools are called directly, not through ${META_TOOL_CALL_TOOL}.`);
  }
  const { conn, name: bare } = resolveTarget(deps, agentId, name);
  const toolArgs = args.arguments as Record<string, unknown> | undefined;
  return conn.callTool(bare, toolArgs, upstreamCallOpts(progressToken, extra));
}

/** Build the agent-facing MCP server: aggregates enabled upstreams with namespaced names. */
export function buildAgentServer(agent: AgentRow, deps: AgentServerDeps): Server {
  const server = new Server(
    { name: `mcp-switchboard-${agent.slug}`, version: deps.version },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true },
      },
      // MCP delivers instructions only in the `initialize` result and has no
      // `instructions_changed` notification, so the mode is read once here, at session build.
      // Flipping the mode mid-session updates tools/list and tools/call behaviour immediately,
      // but this session's instructions stay stale until the client re-initializes — a known
      // protocol limitation, not something the switchboard can push.
      instructions: buildInstructions(deps, agent.id),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [];
    // Lean mode's list is constant-size: upstream tools are reachable through search, not listed.
    if (toolMode(deps, agent.id) === "lean") {
      tools.push(...LEAN_TOOLS);
    } else {
      for (const conn of enabledConnections(deps, agent.id)) {
        for (const tool of conn.toolsCache) {
          tools.push({
            ...tool,
            name: nsName(conn.row.slug, tool.name),
            description: annotateDescription(conn.row.slug, conn.row.description, tool.description),
          });
        }
      }
    }
    tools.push(LIST_SERVERS_TOOL);
    if (requestsEnabled(deps)) tools.push(...REQUEST_TOOLS);
    if (agentRole(deps, agent.id) === "manager") tools.push(...MANAGEMENT_TOOLS);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (LEAN_TOOL_NAMES.has(req.params.name)) {
      if (toolMode(deps, agent.id) !== "lean") {
        throw new McpError(ErrorCode.InvalidParams, "This agent uses full tool exposure; call tools directly by name.");
      }
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      switch (req.params.name) {
        case META_TOOL_SEARCH_TOOLS:
          return searchToolsTool(deps, agent.id, args);
        case META_TOOL_DESCRIBE_TOOLS:
          return describeToolsTool(deps, agent.id, args);
        default:
          return callToolTool(deps, agent.id, args, req.params._meta?.progressToken, extra);
      }
    }
    if (REQUEST_TOOL_NAMES.has(req.params.name)) {
      if (!requestsEnabled(deps)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `"${req.params.name}" is disabled on this switchboard — ask the admin to add the server for you.`,
        );
      }
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      return req.params.name === META_TOOL_REQUEST_SERVER
        ? requestServerTool(deps, agent, args)
        : requestStatusTool(deps, agent, args);
    }
    if (MANAGEMENT_TOOL_NAMES.has(req.params.name)) {
      if (agentRole(deps, agent.id) !== "manager") {
        throw new McpError(
          ErrorCode.InvalidParams,
          `"${req.params.name}" requires the manager role — ask the switchboard admin to grant it to "${agent.slug}".`,
        );
      }
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      switch (req.params.name) {
        case META_TOOL_ADD_SERVER:
          return addServerTool(deps, agent, args);
        case META_TOOL_ASSIGN_SERVER:
          return assignServerTool(deps, args);
        case META_TOOL_LIST_AGENTS:
          return listAgentsTool(deps);
        default:
          return serverStatusTool(deps, args);
      }
    }
    if (req.params.name === META_TOOL_LIST_SERVERS) {
      const catalog = matrixServers(deps, agent.id).map((r) => {
        const conn = deps.manager.get(r.id);
        return {
          slug: r.slug,
          toolPrefix: `${r.slug}__`,
          name: r.name,
          description: r.description ?? null,
          type: r.type,
          status: !r.enabled ? "disabled" : (conn?.state ?? "disabled"),
          toolCount: conn?.toolsCache.length ?? 0,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }] };
    }
    // Lean mode hides upstream tools from the list but does not block them: an agent that already
    // knows a namespaced name may still call it directly, with the same matrix enforcement.
    const { conn, name } = resolveTarget(deps, agent.id, req.params.name);
    return conn.callTool(name, req.params.arguments, upstreamCallOpts(req.params._meta?.progressToken, extra));
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts: Prompt[] = [];
    for (const conn of enabledConnections(deps, agent.id)) {
      for (const prompt of conn.promptsCache) {
        prompts.push({
          ...prompt,
          name: nsName(conn.row.slug, prompt.name),
          description: annotateDescription(conn.row.slug, conn.row.description, prompt.description),
        });
      }
    }
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req, extra) => {
    const { conn, name } = resolveTarget(deps, agent.id, req.params.name);
    return conn.getPrompt(name, req.params.arguments, { signal: extra.signal });
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Resource[] = [];
    for (const conn of enabledConnections(deps, agent.id)) {
      for (const resource of conn.resourcesCache) {
        resources.push({ ...resource, uri: nsResourceUri(conn.row.slug, resource.uri) });
      }
    }
    return { resources };
  });

  // Resource templates embed uriTemplates we can't rewrite losslessly — none in v1.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
    const parsed = parseNsResourceUri(req.params.uri);
    if (!parsed) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI "${req.params.uri}" (expected sb://<server>/…)`);
    }
    const conn = deps.manager.getBySlug(parsed.slug);
    if (!conn) throw new McpError(ErrorCode.InvalidParams, `Unknown server "${parsed.slug}"`);
    const matrix = deps.db
      .select()
      .from(agentServers)
      .where(and(eq(agentServers.agentId, agent.id), eq(agentServers.serverId, conn.serverId)))
      .get();
    if (!matrix?.enabled) {
      // Same error as an unknown server, for the same reason as in resolveTarget: a server this
      // agent lacks must be indistinguishable from one that does not exist.
      throw new McpError(ErrorCode.InvalidParams, `Unknown server "${parsed.slug}"`);
    }
    const result = await conn.readResource(parsed.uri, { signal: extra.signal });
    // Re-namespace URIs in the response so follow-up reads route correctly.
    return {
      ...result,
      contents: result.contents.map((c) => ({ ...c, uri: nsResourceUri(parsed.slug, c.uri) })),
    };
  });

  return server;
}
