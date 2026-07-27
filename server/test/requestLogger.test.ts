import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { requestLogs, type AgentRow, type RequestLogRow } from "../src/db/schema.js";
import { RequestLogger, LOG_SETTING_KEYS } from "../src/core/requestLogger.js";
import { writeSetting } from "../src/lib/settings.js";
import { encrypt, loadOrCreateKey } from "../src/lib/crypto.js";

const AGENT: AgentRow = { id: 1, slug: "claude", name: "Claude", tokenEnc: "x", createdAt: 0 };

/** Stand-in transport: `sent` collects what the switchboard wrote back to the agent. */
function fakeTransport(): Transport & { sent: JSONRPCMessage[] } {
  const t = {
    sent: [] as JSONRPCMessage[],
    sessionId: "sess-1",
    start: async () => {},
    close: async () => {},
    send: async (message: JSONRPCMessage) => {
      t.sent.push(message);
    },
  };
  return t as unknown as Transport & { sent: JSONRPCMessage[] };
}

let db: Db;
let logger: RequestLogger;
let transport: Transport & { sent: JSONRPCMessage[] };

function rows(): RequestLogRow[] {
  return db.select().from(requestLogs).orderBy(desc(requestLogs.id)).all();
}

function latest(): RequestLogRow {
  return rows()[0];
}

beforeEach(() => {
  closeDb();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-logs-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  logger = new RequestLogger(db);
  transport = fakeTransport();
  logger.attach({ ...AGENT, tokenEnc: encrypt("t") }, transport);
});

/** Drive one full request/response round trip through the wrapped transport. */
async function roundTrip(request: JSONRPCMessage, response: JSONRPCMessage): Promise<void> {
  transport.onmessage?.(request);
  await transport.send(response);
}

describe("RequestLogger", () => {
  it("pairs a tool call with its response and attributes it to the upstream server", async () => {
    await roundTrip(
      {
        jsonrpc: "2.0",
        id: 27,
        method: "tools/call",
        params: { name: "github__create_issue", arguments: { title: "Fix it" } },
      },
      { jsonrpc: "2.0", id: 27, result: { content: [{ type: "text", text: "Created #142" }] } },
    );

    const row = latest();
    expect(row.method).toBe("tools/call");
    expect(row.target).toBe("github__create_issue");
    expect(row.serverSlug).toBe("github");
    expect(row.agentSlug).toBe("claude");
    expect(row.status).toBe("ok");
    expect(row.summary).toBe('{"title":"Fix it"}');
    expect(row.sessionId).toBe("sess-1");
    expect(row.durationMs).not.toBeNull();
    expect(JSON.parse(row.requestJson!).params.name).toBe("github__create_issue");
    expect(JSON.parse(row.responseJson!).result.content[0].text).toBe("Created #142");
  });

  it("leaves the row pending until the response is sent", () => {
    transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(latest().status).toBe("pending");
    expect(latest().responseJson).toBeNull();
  });

  it("records JSON-RPC errors with their code", async () => {
    await roundTrip(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "postgres__query" } },
      { jsonrpc: "2.0", id: 9, error: { code: -32603, message: 'relation "x" does not exist' } },
    );

    const row = latest();
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe(-32603);
    expect(row.errorMessage).toBe('relation "x" does not exist');
  });

  it("treats a tool result flagged isError as a failure", async () => {
    await roundTrip(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "exa__search" } },
      { jsonrpc: "2.0", id: 3, result: { isError: true, content: [{ type: "text", text: "rate limited" }] } },
    );

    const row = latest();
    expect(row.status).toBe("error");
    expect(row.errorMessage).toBe("rate limited");
  });

  it("summarises list results by count and spans every server", async () => {
    await roundTrip(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "a" }, { name: "b" }] } },
    );

    const row = latest();
    expect(row.summary).toBe("2 tools");
    expect(row.serverSlug).toBeNull();
  });

  it("attributes the switchboard's own meta tool to no upstream server", async () => {
    await roundTrip(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "switchboard__list_servers" } },
      { jsonrpc: "2.0", id: 4, result: { content: [] } },
    );
    expect(latest().serverSlug).toBeNull();
  });

  it("resolves the server from a namespaced resource URI", async () => {
    await roundTrip(
      { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "sb://github/README.md" } },
      { jsonrpc: "2.0", id: 5, result: { contents: [] } },
    );
    expect(latest().serverSlug).toBe("github");
  });

  it("logs notifications as completed one-way rows", () => {
    transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/initialized" });
    const row = latest();
    expect(row.status).toBe("ok");
    expect(row.rpcId).toBeNull();
    expect(row.durationMs).toBe(0);
  });

  it("ignores server-initiated notifications on the way out", async () => {
    await transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect(rows()).toHaveLength(0);
  });

  it("still forwards messages to the underlying transport", async () => {
    transport.onmessage?.({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    const response: JSONRPCMessage = { jsonrpc: "2.0", id: 7, result: { tools: [] } };
    await transport.send(response);
    expect(transport.sent).toEqual([response]);
  });

  it("records byte counts but no payloads when capture is off", async () => {
    writeSetting(db, LOG_SETTING_KEYS.capturePayloads, "0");
    logger.reloadConfig();

    await roundTrip(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "github__x", arguments: { a: 1 } } },
      { jsonrpc: "2.0", id: 1, result: { content: [] } },
    );

    const row = latest();
    expect(row.requestJson).toBeNull();
    expect(row.responseJson).toBeNull();
    expect(row.requestBytes).toBeGreaterThan(0);
    expect(row.responseBytes).toBeGreaterThan(0);
    // Metadata is still there — that's the point of the metadata-only mode.
    expect(row.target).toBe("github__x");
    expect(row.status).toBe("ok");
  });

  it("clips oversized payloads and flags them, keeping the true size", async () => {
    writeSetting(db, LOG_SETTING_KEYS.maxPayloadKb, "1");
    logger.reloadConfig();

    const big = "x".repeat(4000);
    await roundTrip(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "github__x", arguments: { big } } },
      { jsonrpc: "2.0", id: 1, result: { content: [] } },
    );

    const row = latest();
    expect(row.truncated).toBe(true);
    expect(row.requestJson!.length).toBe(1024);
    expect(row.requestBytes).toBeGreaterThan(4000);
  });

  it("prunes rows past the retention window", () => {
    writeSetting(db, LOG_SETTING_KEYS.retentionHours, "48");
    logger.reloadConfig();

    const insert = (ts: number) =>
      db
        .insert(requestLogs)
        .values({ ts, agentSlug: "a", agentName: "A", method: "tools/list", status: "ok" })
        .run();
    insert(Date.now() - 49 * 60 * 60 * 1000);
    insert(Date.now() - 1000);

    expect(logger.prune()).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it("notifies subscribers on insert and on completion", async () => {
    const events: string[] = [];
    const unsubscribe = logger.subscribe((e) => events.push(`${e.type}:${e.row.status}`));

    await roundTrip(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    );
    unsubscribe();

    expect(events).toEqual(["insert:pending", "update:ok"]);

    await roundTrip(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    );
    expect(events).toHaveLength(2); // unsubscribed
  });

  it("marks requests interrupted when the switchboard restarts mid-flight", () => {
    transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "github__slow" } });
    const id = latest().id;

    // A fresh process: in-memory sessions are gone, so no response can arrive.
    new RequestLogger(db).startGc();

    const row = db.select().from(requestLogs).where(eq(requestLogs.id, id)).get()!;
    expect(row.status).toBe("error");
    expect(row.errorMessage).toMatch(/Interrupted/);
  });
});
