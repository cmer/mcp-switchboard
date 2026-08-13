import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { and, desc, eq, or } from "drizzle-orm";
import { agentServers, agents, serverRequests, servers, type AgentRow } from "../db/schema.js";
import { parseImport, type ParsedServer } from "../lib/importParser.js";
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

const STDIO_PENDING_NOTE =
  "stdio servers require admin approval — the admin will see this request in the web UI";

/** Read from the db on every call so a role toggle in the UI applies to sessions that are already live. */
function agentRole(deps: AgentServerDeps, agentId: number): string {
  return deps.db.select({ role: agents.role }).from(agents).where(eq(agents.id, agentId)).get()?.role ?? "standard";
}

/** Same freshness argument as the role: read per call so the Settings toggle hits live sessions. */
function requestsEnabled(deps: AgentServerDeps): boolean {
  return readSetting(deps.db, REQUESTS_SETTING_KEY) !== "0";
}

function jsonContent(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
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
  const lines = [
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
    throw new McpError(ErrorCode.InvalidParams, `Server "${parsed.slug}" is not enabled for this agent`);
  }
  return { conn, name: parsed.name };
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
      instructions: buildInstructions(deps, agent.id),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [];
    for (const conn of enabledConnections(deps, agent.id)) {
      for (const tool of conn.toolsCache) {
        tools.push({
          ...tool,
          name: nsName(conn.row.slug, tool.name),
          description: annotateDescription(conn.row.slug, conn.row.description, tool.description),
        });
      }
    }
    tools.push({
      name: META_TOOL_LIST_SERVERS,
      description:
        "List the MCP servers behind this switchboard for this agent: slug (the tool-name prefix), what each server/account is for, connection status, and tool count. Call this when unsure which server's tools to use — e.g. which of several connected accounts of the same service.",
      inputSchema: { type: "object", properties: {} },
    });
    if (requestsEnabled(deps)) tools.push(...REQUEST_TOOLS);
    if (agentRole(deps, agent.id) === "manager") tools.push(...MANAGEMENT_TOOLS);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
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
    const { conn, name } = resolveTarget(deps, agent.id, req.params.name);
    const progressToken = req.params._meta?.progressToken;
    return conn.callTool(name, req.params.arguments, {
      signal: extra.signal,
      onprogress:
        progressToken !== undefined
          ? (p) => {
              void extra
                .sendNotification({ method: "notifications/progress", params: { progressToken, ...p } })
                .catch(() => {});
            }
          : undefined,
    });
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
      throw new McpError(ErrorCode.InvalidParams, `Server "${parsed.slug}" is not enabled for this agent`);
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
