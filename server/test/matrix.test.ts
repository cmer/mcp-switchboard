import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { defaultUserId } from "../src/core/users.js";
import { agentServers, agents, servers } from "../src/db/schema.js";
import { annotateDescription, type AgentServerDeps } from "../src/core/agentServerFactory.js";
import { agentReach } from "../src/core/agentReach.js";
import { loadOrCreateKey, encrypt } from "../src/lib/crypto.js";
import type { UpstreamConnection, UpstreamState } from "../src/core/upstreamConnection.js";
import type { UpstreamManager } from "../src/core/upstreamManager.js";

let db: Db;

/** Minimal stand-in for a live connection. */
function fakeConn(id: number, slug: string, state: UpstreamState, tools: string[]): UpstreamConnection {
  return {
    serverId: id,
    state,
    row: { id, slug },
    toolsCache: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
    promptsCache: [],
    resourcesCache: [],
  } as unknown as UpstreamConnection;
}

function fakeManager(conns: UpstreamConnection[]): UpstreamManager {
  return {
    get: (id: number) => conns.find((c) => c.serverId === id),
  } as unknown as UpstreamManager;
}

let deps: AgentServerDeps;
const AGENT_ID = 1;

beforeAll(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-matrix-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  const now = Date.now();

  // three servers: github (enabled+connected), postgres (enabled but disconnected), linear (matrix-disabled)
  for (const [id, slug] of [
    [1, "github"],
    [2, "postgres"],
    [3, "linear"],
    [4, "globally-off"],
  ] as const) {
    db.insert(servers)
      .values({
        userId: defaultUserId(db),
        id,
        slug,
        name: slug,
        type: "stdio",
        enabled: slug !== "globally-off",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  db.insert(agents).values({ userId: defaultUserId(db), id: AGENT_ID, slug: "claude", name: "Claude", tokenEnc: encrypt("t"), createdAt: now }).run();
  db.insert(agentServers).values({ agentId: AGENT_ID, serverId: 1, enabled: true }).run();
  db.insert(agentServers).values({ agentId: AGENT_ID, serverId: 2, enabled: true }).run();
  db.insert(agentServers).values({ agentId: AGENT_ID, serverId: 3, enabled: false }).run();
  db.insert(agentServers).values({ agentId: AGENT_ID, serverId: 4, enabled: true }).run();

  const conns = [
    fakeConn(1, "github", "connected", ["create_issue", "search"]),
    fakeConn(2, "postgres", "backoff", ["query"]),
    fakeConn(3, "linear", "connected", ["create_ticket"]),
    fakeConn(4, "globally-off", "connected", ["x"]),
  ];
  deps = { db, manager: fakeManager(conns), version: "test" };
});

const reach = () => agentReach(db, { id: AGENT_ID, userId: defaultUserId(db) }, deps.manager);

describe("agent reach: connected", () => {
  it("includes only matrix-enabled + globally-enabled + connected servers", () => {
    expect(reach().connected().map((t) => t.server.name)).toEqual(["github"]);
  });
});

describe("annotateDescription", () => {
  it("prefixes with the server note when one is set", () => {
    expect(annotateDescription("gmail-work", "Work Gmail — carl@company.com", "Search messages")).toBe(
      "(via gmail-work: Work Gmail — carl@company.com) Search messages",
    );
  });

  it("passes descriptions through untouched when no note is set", () => {
    expect(annotateDescription("gmail-work", null, "Search messages")).toBe("Search messages");
    expect(annotateDescription("x", null, undefined)).toBeUndefined();
  });

  it("handles tools without their own description", () => {
    expect(annotateDescription("gmail-work", "Work account", undefined)).toBe("(via gmail-work: Work account)");
  });
});

describe("agent reach: resolve", () => {
  it("resolves a server name to its connection", () => {
    const target = reach().resolve("github");
    expect(target?.conn.serverId).toBe(1);
    expect(target?.server).toMatchObject({ name: "github", serverId: 1 });
  });

  it("rejects servers not enabled for this agent, indistinguishably from unknown ones", () => {
    expect(reach().resolve("linear")).toBeUndefined();
    expect(reach().resolve("globally-off")).toBeUndefined();
    expect(reach().resolve("nope")).toBeUndefined();
  });
});
