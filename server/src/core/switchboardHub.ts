import crypto from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { agentServers, type AgentRow } from "../db/schema.js";
import { buildAgentServer, type AgentServerDeps } from "./agentServerFactory.js";
import type { ChangedKind } from "./upstreamConnection.js";

interface SessionEntry {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}

const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 60 * 1000;

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Owns all agent-facing MCP sessions. One Server+transport pair per session
 * (SDK requirement); sessions are in-memory only — after a switchboard restart,
 * unknown session ids get HTTP 404, which tells spec-compliant clients to
 * re-initialize.
 */
export class SwitchboardHub {
  /** agentId → sessionId → entry */
  private sessions = new Map<number, Map<string, SessionEntry>>();
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(private deps: AgentServerDeps) {}

  startGc(): void {
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
    this.gcTimer.unref?.();
  }

  private gc(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const sessions of this.sessions.values()) {
      for (const [sid, entry] of sessions) {
        if (entry.lastSeen < cutoff) {
          void entry.transport.close().catch(() => {});
          sessions.delete(sid);
        }
      }
    }
  }

  private agentSessions(agentId: number): Map<string, SessionEntry> {
    let map = this.sessions.get(agentId);
    if (!map) {
      map = new Map();
      this.sessions.set(agentId, map);
    }
    return map;
  }

  sessionCount(agentId: number): number {
    return this.sessions.get(agentId)?.size ?? 0;
  }

  async handleRequest(agent: AgentRow, req: Request): Promise<Response> {
    const sessions = this.agentSessions(agent.id);
    const sessionId = req.headers.get("mcp-session-id");

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await req.clone().json();
      } catch {
        return jsonRpcError(400, -32700, "Parse error: invalid JSON");
      }

      if (!sessionId && isInitializeRequest(body)) {
        let entry: SessionEntry | null = null;
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            if (entry) sessions.set(sid, entry);
          },
          onsessionclosed: (sid) => {
            sessions.delete(sid);
          },
        });
        const server = buildAgentServer(agent, this.deps);
        entry = { server, transport, lastSeen: Date.now() };
        await server.connect(transport);
        return transport.handleRequest(req, { parsedBody: body });
      }

      if (!sessionId) {
        return jsonRpcError(400, -32000, "Bad Request: missing mcp-session-id header (send initialize first)");
      }
      const entry = sessions.get(sessionId);
      if (!entry) return jsonRpcError(404, -32001, "Session not found — re-initialize");
      entry.lastSeen = Date.now();
      return entry.transport.handleRequest(req, { parsedBody: body });
    }

    // GET (SSE notification stream) and DELETE (session termination)
    if (!sessionId) return jsonRpcError(400, -32000, "Bad Request: missing mcp-session-id header");
    const entry = sessions.get(sessionId);
    if (!entry) return jsonRpcError(404, -32001, "Session not found — re-initialize");
    entry.lastSeen = Date.now();
    return entry.transport.handleRequest(req);
  }

  /** Fan out list_changed to every live session of agents that have `serverId` enabled. */
  notifyChanged(serverId: number, kind: ChangedKind): void {
    const rows = this.deps.db
      .select({ agentId: agentServers.agentId })
      .from(agentServers)
      .where(and(eq(agentServers.serverId, serverId), eq(agentServers.enabled, true)))
      .all();
    for (const { agentId } of rows) this.notifyAgent(agentId, kind);
  }

  /** Fan out list_changed to every live session of one agent (all kinds if omitted). */
  notifyAgent(agentId: number, kind?: ChangedKind): void {
    const sessions = this.sessions.get(agentId);
    if (!sessions) return;
    const kinds: ChangedKind[] = kind ? [kind] : ["tools", "prompts", "resources"];
    for (const entry of sessions.values()) {
      for (const k of kinds) {
        const send =
          k === "tools"
            ? entry.server.sendToolListChanged()
            : k === "prompts"
              ? entry.server.sendPromptListChanged()
              : entry.server.sendResourceListChanged();
        void send.catch(() => {});
      }
    }
  }

  notifyAllAgents(kind?: ChangedKind): void {
    for (const agentId of this.sessions.keys()) this.notifyAgent(agentId, kind);
  }

  /** Close and forget all sessions for an agent (e.g. on delete / token rotate). */
  async dropAgentSessions(agentId: number): Promise<void> {
    const sessions = this.sessions.get(agentId);
    if (!sessions) return;
    for (const entry of sessions.values()) {
      await entry.transport.close().catch(() => {});
    }
    this.sessions.delete(agentId);
  }

  async stopAll(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    for (const sessions of this.sessions.values()) {
      for (const entry of sessions.values()) await entry.transport.close().catch(() => {});
    }
    this.sessions.clear();
  }
}
