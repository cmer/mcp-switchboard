import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { eq } from "drizzle-orm";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agentServers, agents, requestLogs, type AgentRow } from "../src/db/schema.js";
import { insertServer } from "../src/core/adminActions.js";
import { buildAgentServer, META_TOOL_REQUEST_SERVER, type AgentServerDeps } from "../src/core/agentServerFactory.js";
import { RequestLogger } from "../src/core/requestLogger.js";
import { createUser, defaultUserId } from "../src/core/users.js";
import { encrypt, loadOrCreateKey } from "../src/lib/crypto.js";
import { userScope } from "../src/core/userScope.js";

let tmp: string;
let db: Db;

function addAgent(userId: number, slug: string): AgentRow {
  return db
    .insert(agents)
    .values({ userId, slug, name: slug, tokenEnc: encrypt("t"), createdAt: 1 })
    .returning()
    .get();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-usersettings-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("per-user settings isolation", () => {
  it("autoEnableNewServers switches a new server on for the owner's agents only", async () => {
    const bob = createUser(db, { username: "bob" });
    const mine = addAgent(defaultUserId(db), "mine");
    const bobs = addAgent(bob.id, "bobs");

    // Bob has it on, the Default user hasn't: the Default user's new server stays off everywhere.
    userScope(db, bob.id).settings.set("autoEnableNewServers", true);
    const first = insertServer(userScope(db, defaultUserId(db)), { name: "First", type: "http", url: "https://a.example/mcp" });
    expect("row" in first).toBe(true);
    expect(db.select().from(agentServers).all()).toEqual([]);

    // Bob's own new server goes on for Bob's agents, and never for anyone else's.
    const second = insertServer(userScope(db, bob.id), { name: "Second", type: "http", url: "https://b.example/mcp" }) as {
      row: { id: number };
    };
    const rows = db.select().from(agentServers).all();
    expect(rows.map((r) => [r.agentId, r.serverId])).toEqual([[bobs.id, second.row.id]]);
    expect(rows.some((r) => r.agentId === mine.id)).toBe(false);
  });

  it("allowServerRequests is read for the agent's owner", async () => {
    const bob = createUser(db, { username: "bob" });
    const mine = addAgent(defaultUserId(db), "mine");
    const bobs = addAgent(bob.id, "bobs");
    userScope(db, bob.id).settings.set("allowServerRequests", false);
    const deps: AgentServerDeps = { db, manager: { get: () => undefined } as never, version: "test" };

    const toolNames = async (agent: AgentRow) => {
      const server = buildAgentServer(agent, deps);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return (await client.listTools()).tools.map((t) => t.name);
    };
    expect(await toolNames(bobs)).not.toContain(META_TOOL_REQUEST_SERVER);
    expect(await toolNames(mine)).toContain(META_TOOL_REQUEST_SERVER);
  });

  it("capturePayloads follows the calling agent's owner", async () => {
    const bob = createUser(db, { username: "bob" });
    const mine = addAgent(defaultUserId(db), "mine");
    const bobs = addAgent(bob.id, "bobs");
    userScope(db, bob.id).settings.set("capturePayloads", false);
    const logger = new RequestLogger(db);

    const roundTrip = async (agent: AgentRow) => {
      const transport = {
        sessionId: `s-${agent.id}`,
        start: async () => {},
        close: async () => {},
        send: async () => {},
      } as unknown as Transport;
      logger.attach(agent, transport);
      transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/list" } as JSONRPCMessage);
      await transport.send({ jsonrpc: "2.0", id: 1, result: { tools: [] } } as JSONRPCMessage);
      return db.select().from(requestLogs).where(eq(requestLogs.agentId, agent.id)).get()!;
    };
    expect(await roundTrip(mine)).toMatchObject({ userId: defaultUserId(db), requestJson: expect.any(String), responseJson: expect.any(String) });
    expect(await roundTrip(bobs)).toMatchObject({ userId: bob.id, requestJson: null, responseJson: null });
  });
});
