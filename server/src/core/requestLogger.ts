import { and, eq, lt } from "drizzle-orm";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db/index.js";
import { requestLogs, type AgentRow, type RequestLogRow } from "../db/schema.js";
import { readBoolSetting, readNumberSetting } from "../lib/settings.js";
import { parseNsName, parseNsResourceUri } from "./namespace.js";
import { META_TOOL_LIST_SERVERS } from "./agentServerFactory.js";

export const LOG_SETTING_KEYS = {
  retentionHours: "logs.retentionHours",
  capturePayloads: "logs.capturePayloads",
  maxPayloadKb: "logs.maxPayloadKb",
} as const;

export const LOG_DEFAULTS = {
  retentionHours: 48,
  capturePayloads: true,
  maxPayloadKb: 32,
};

export interface LogConfig {
  retentionHours: number;
  capturePayloads: boolean;
  maxPayloadKb: number;
}

/** The columns the list view and the live stream need — payloads are fetched per row on expand. */
export const LOG_SUMMARY_COLUMNS = {
  id: requestLogs.id,
  ts: requestLogs.ts,
  agentId: requestLogs.agentId,
  agentSlug: requestLogs.agentSlug,
  agentName: requestLogs.agentName,
  serverSlug: requestLogs.serverSlug,
  method: requestLogs.method,
  target: requestLogs.target,
  summary: requestLogs.summary,
  status: requestLogs.status,
  durationMs: requestLogs.durationMs,
  errorCode: requestLogs.errorCode,
  errorMessage: requestLogs.errorMessage,
  requestBytes: requestLogs.requestBytes,
  responseBytes: requestLogs.responseBytes,
} as const;

export type LogSummary = {
  [K in keyof typeof LOG_SUMMARY_COLUMNS]: RequestLogRow[K];
};

export type LogEvent = { type: "insert" | "update"; row: LogSummary };

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
/** A request still `pending` after this long is never coming back (upstream calls time out at 120s). */
const STALE_PENDING_MS = 15 * 60 * 1000;
const SUMMARY_CHARS = 300;

type Json = Record<string, unknown>;

function isRequest(m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number; method: string; params?: Json } {
  return "method" in m && "id" in m;
}
function isNotification(m: JSONRPCMessage): m is JSONRPCMessage & { method: string; params?: Json } {
  return "method" in m && !("id" in m);
}
function isResult(m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number; result: Json } {
  return "result" in m && "id" in m;
}
function isError(
  m: JSONRPCMessage,
): m is JSONRPCMessage & { id: string | number; error: { code: number; message: string } } {
  return "error" in m && "id" in m;
}

function clip(text: string, max = SUMMARY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Row label, owning server and one-line preview, derived from the request itself. */
function describeRequest(method: string, params: Json | undefined): {
  target: string | null;
  serverSlug: string | null;
  summary: string | null;
} {
  const name = typeof params?.name === "string" ? params.name : null;
  const uri = typeof params?.uri === "string" ? params.uri : null;

  if ((method === "tools/call" || method === "prompts/get") && name) {
    // The switchboard's own meta tool has no upstream server behind it.
    const slug = name === META_TOOL_LIST_SERVERS ? null : (parseNsName(name)?.slug ?? null);
    const args = params?.arguments;
    return {
      target: name,
      serverSlug: slug,
      summary: args && Object.keys(args as Json).length > 0 ? clip(JSON.stringify(args)) : null,
    };
  }
  if (method === "resources/read" && uri) {
    return { target: uri, serverSlug: parseNsResourceUri(uri)?.slug ?? null, summary: null };
  }
  if (method === "initialize") {
    const info = params?.clientInfo as { name?: string; version?: string } | undefined;
    const parts = [
      info?.name ? `${info.name} ${info.version ?? ""}`.trim() : null,
      params?.protocolVersion ? `protocol ${String(params.protocolVersion)}` : null,
    ].filter(Boolean);
    return { target: null, serverSlug: null, summary: parts.join(" · ") || null };
  }
  return {
    target: null,
    serverSlug: null,
    summary: params && Object.keys(params).length > 0 ? clip(JSON.stringify(params)) : null,
  };
}

/** Prefer a count over a wall of JSON for the list-shaped results. */
function describeResult(method: string, result: Json): { summary: string | null; toolError: string | null } {
  const count = (key: string): number | null => (Array.isArray(result[key]) ? (result[key] as unknown[]).length : null);

  if (method === "tools/call" && result.isError === true) {
    const first = Array.isArray(result.content) ? (result.content[0] as { text?: string } | undefined) : undefined;
    return { summary: null, toolError: clip(first?.text ?? "tool reported an error", 500) };
  }
  for (const [key, noun] of [
    ["tools", "tools"],
    ["prompts", "prompts"],
    ["resources", "resources"],
  ] as const) {
    const n = count(key);
    if (n !== null) return { summary: `${n} ${noun}`, toolError: null };
  }
  return { summary: null, toolError: null };
}

interface Pending {
  logId: number;
  startedAt: number;
  method: string;
}

/**
 * Records every JSON-RPC frame an agent sends and the frame sent back, by wrapping the
 * session transport: `onmessage` is installed before `Server.connect()` (the SDK chains
 * onto whatever is already there) and `send` is wrapped in place.
 */
export class RequestLogger {
  private subscribers = new Set<(event: LogEvent) => void>();
  private cfg: LogConfig;
  private timer: NodeJS.Timeout | null = null;

  constructor(private db: Db) {
    this.cfg = this.readConfig();
  }

  private readConfig(): LogConfig {
    return {
      retentionHours: readNumberSetting(this.db, LOG_SETTING_KEYS.retentionHours, LOG_DEFAULTS.retentionHours),
      capturePayloads: readBoolSetting(this.db, LOG_SETTING_KEYS.capturePayloads, LOG_DEFAULTS.capturePayloads),
      maxPayloadKb: readNumberSetting(this.db, LOG_SETTING_KEYS.maxPayloadKb, LOG_DEFAULTS.maxPayloadKb),
    };
  }

  get config(): LogConfig {
    return this.cfg;
  }

  /** Called after the settings route writes new values. */
  reloadConfig(): LogConfig {
    this.cfg = this.readConfig();
    return this.cfg;
  }

  subscribe(fn: (event: LogEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(type: LogEvent["type"], id: number): void {
    if (this.subscribers.size === 0) return;
    const row = this.db.select(LOG_SUMMARY_COLUMNS).from(requestLogs).where(eq(requestLogs.id, id)).get();
    if (!row) return;
    for (const fn of this.subscribers) {
      try {
        fn({ type, row });
      } catch {
        // a dead subscriber must never break request logging
      }
    }
  }

  private payload(text: string): { json: string | null; bytes: number; truncated: boolean } {
    const bytes = Buffer.byteLength(text, "utf8");
    if (!this.cfg.capturePayloads) return { json: null, bytes, truncated: false };
    const max = Math.max(1, this.cfg.maxPayloadKb) * 1024;
    return bytes <= max
      ? { json: text, bytes, truncated: false }
      : { json: text.slice(0, max), bytes, truncated: true };
  }

  /** Wrap one agent session's transport. Must run before `server.connect(transport)`. */
  attach(agent: AgentRow, transport: Transport): void {
    const pending = new Map<string, Pending>();

    transport.onmessage = (message) => {
      try {
        this.recordInbound(agent, transport, message, pending);
      } catch {
        // logging must never take down a live session
      }
    };

    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      try {
        this.recordOutbound(transport, message, pending);
      } catch {
        // ditto
      }
      return send(message, options);
    };
  }

  private recordInbound(
    agent: AgentRow,
    transport: Transport,
    message: JSONRPCMessage,
    pending: Map<string, Pending>,
  ): void {
    const now = Date.now();
    if (isRequest(message)) {
      const { target, serverSlug, summary } = describeRequest(message.method, message.params);
      const req = this.payload(JSON.stringify(message));
      const row = this.db
        .insert(requestLogs)
        .values({
          ts: now,
          agentId: agent.id,
          agentSlug: agent.slug,
          agentName: agent.name,
          serverSlug,
          sessionId: transport.sessionId ?? null,
          rpcId: String(message.id),
          method: message.method,
          target,
          summary,
          status: "pending",
          requestJson: req.json,
          requestBytes: req.bytes,
          truncated: req.truncated,
        })
        .returning({ id: requestLogs.id })
        .get();
      pending.set(String(message.id), { logId: row.id, startedAt: now, method: message.method });
      this.emit("insert", row.id);
      return;
    }

    if (isNotification(message)) {
      const { target, serverSlug, summary } = describeRequest(message.method, message.params);
      const req = this.payload(JSON.stringify(message));
      const row = this.db
        .insert(requestLogs)
        .values({
          ts: now,
          agentId: agent.id,
          agentSlug: agent.slug,
          agentName: agent.name,
          serverSlug,
          sessionId: transport.sessionId ?? null,
          rpcId: null,
          method: message.method,
          target,
          summary,
          status: "ok",
          durationMs: 0,
          requestJson: req.json,
          requestBytes: req.bytes,
          truncated: req.truncated,
        })
        .returning({ id: requestLogs.id })
        .get();
      this.emit("insert", row.id);
    }
  }

  private recordOutbound(transport: Transport, message: JSONRPCMessage, pending: Map<string, Pending>): void {
    if (!isResult(message) && !isError(message)) return; // server-initiated notifications aren't request/response pairs
    const key = String(message.id);
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);

    const res = this.payload(JSON.stringify(message));
    const patch: Partial<RequestLogRow> = {
      durationMs: Date.now() - entry.startedAt,
      responseJson: res.json,
      responseBytes: res.bytes,
      sessionId: transport.sessionId ?? null,
    };

    if (isError(message)) {
      patch.status = "error";
      patch.errorCode = message.error.code;
      patch.errorMessage = clip(message.error.message, 500);
    } else {
      const { summary, toolError } = describeResult(entry.method, message.result);
      if (toolError) {
        patch.status = "error";
        patch.errorMessage = toolError;
      } else {
        patch.status = "ok";
        if (summary) patch.summary = summary;
      }
    }

    this.db.update(requestLogs).set(patch).where(eq(requestLogs.id, entry.logId)).run();
    this.emit("update", entry.logId);
  }

  startGc(): void {
    // Sessions are in-memory, so at boot every still-pending request is orphaned.
    this.markInterrupted();
    this.prune();
    this.timer = setInterval(() => {
      this.markInterrupted(STALE_PENDING_MS);
      this.prune();
    }, PRUNE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stopGc(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Requests whose response can no longer arrive (a restart, or a session that went away).
   * With no age given, every pending row qualifies.
   */
  private markInterrupted(olderThanMs?: number): void {
    const stale = olderThanMs === undefined ? undefined : lt(requestLogs.ts, Date.now() - olderThanMs);
    this.db
      .update(requestLogs)
      .set({ status: "error", errorMessage: "Interrupted — no response was sent" })
      .where(and(eq(requestLogs.status, "pending"), stale))
      .run();
  }

  prune(): number {
    const hours = Math.max(1, this.cfg.retentionHours);
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return this.db.delete(requestLogs).where(lt(requestLogs.ts, cutoff)).run().changes;
  }

  clear(): number {
    return this.db.delete(requestLogs).run().changes;
  }
}
