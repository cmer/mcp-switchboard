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
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { agentServers, servers, type AgentRow } from "../db/schema.js";
import { nsName, nsResourceUri, parseNsName, parseNsResourceUri } from "./namespace.js";
import type { UpstreamConnection } from "./upstreamConnection.js";
import type { UpstreamManager } from "./upstreamManager.js";

export interface AgentServerDeps {
  db: Db;
  manager: UpstreamManager;
  version: string;
}

export const META_TOOL_LIST_SERVERS = "switchboard__list_servers";

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
  return [
    "MCP Switchboard: aggregates multiple MCP servers. Tool and prompt names are prefixed with the upstream server slug as <server>__<name>; resource URIs as sb://<server>/….",
    "When several servers expose similar tools (e.g. multiple accounts of the same service), pick by prefix using the roster below.",
    `Call ${META_TOOL_LIST_SERVERS} for live status and details.`,
    "",
    "Servers:",
    roster,
  ].join("\n");
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
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
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
