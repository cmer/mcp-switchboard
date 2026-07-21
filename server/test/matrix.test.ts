import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agentServers, agents, servers } from "../src/db/schema.js";
import {
  annotateDescription,
  enabledConnections,
  resolveTarget,
  type AgentServerDeps,
} from "../src/core/agentServerFactory.js";
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
    getBySlug: (slug: string) => conns.find((c) => c.row.slug === slug),
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
  db.insert(agents).values({ id: AGENT_ID, slug: "claude", name: "Claude", tokenEnc: encrypt("t"), createdAt: now }).run();
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

describe("enabledConnections", () => {
  it("includes only matrix-enabled + globally-enabled + connected servers", () => {
    const conns = enabledConnections(deps, AGENT_ID);
    expect(conns.map((c) => c.row.slug)).toEqual(["github"]);
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

describe("resolveTarget", () => {
  it("resolves a namespaced tool to its connection", () => {
    const { conn, name } = resolveTarget(deps, AGENT_ID, "github__create_issue");
    expect(conn.row.slug).toBe("github");
    expect(name).toBe("create_issue");
  });

  it("rejects servers not enabled for this agent", () => {
    expect(() => resolveTarget(deps, AGENT_ID, "linear__create_ticket")).toThrow(/not enabled/);
  });

  it("rejects unknown servers and malformed names", () => {
    expect(() => resolveTarget(deps, AGENT_ID, "nope__tool")).toThrow(/Unknown server/);
    expect(() => resolveTarget(deps, AGENT_ID, "no-separator")).toThrow(/Unknown name/);
  });
});
