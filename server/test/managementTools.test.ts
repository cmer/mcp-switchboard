import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq } from "drizzle-orm";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agentServers, agents, serverRequests, servers } from "../src/db/schema.js";
import {
  buildAgentServer,
  META_TOOL_ADD_SERVER,
  META_TOOL_ASSIGN_SERVER,
  META_TOOL_LIST_AGENTS,
  META_TOOL_SERVER_STATUS,
  type AgentServerDeps,
} from "../src/core/agentServerFactory.js";
import { encrypt, loadOrCreateKey } from "../src/lib/crypto.js";
import type { UpstreamManager } from "../src/core/upstreamManager.js";

const BOSS_TOKEN = "boss-token-do-not-leak";
const HELPER_TOKEN = "helper-token-do-not-leak";

let db: Db;
let deps: AgentServerDeps;
let notifyAgent: ReturnType<typeof vi.fn>;
let tmp: string;

/** No connections: every server the tools create reports as "connecting". */
const emptyManager = { get: () => undefined, getBySlug: () => undefined } as unknown as UpstreamManager;

function agentId(slug: string): number {
  return db.select({ id: agents.id }).from(agents).where(eq(agents.slug, slug)).get()!.id;
}

function matrixRow(agentSlug: string, serverSlug: string) {
  const server = db.select().from(servers).where(eq(servers.slug, serverSlug)).get();
  if (!server) return undefined;
  return db
    .select()
    .from(agentServers)
    .where(and(eq(agentServers.agentId, agentId(agentSlug)), eq(agentServers.serverId, server.id)))
    .get();
}

/** Drive the agent-facing server the way a real client does, over an in-memory transport. */
async function connect(slug: string): Promise<Client> {
  const row = db.select().from(agents).where(eq(agents.slug, slug)).get()!;
  const server = buildAgentServer(row, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[] };
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-mgmt-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  const now = Date.now();
  db.insert(agents)
    .values({ slug: "boss", name: "Boss", role: "manager", tokenEnc: encrypt(BOSS_TOKEN), createdAt: now })
    .run();
  db.insert(agents)
    .values({ slug: "helper", name: "Helper", role: "standard", tokenEnc: encrypt(HELPER_TOKEN), createdAt: now })
    .run();
  db.insert(servers)
    .values({ slug: "github", name: "GitHub", type: "http", url: "https://api.github.com/mcp", createdAt: now, updatedAt: now })
    .run();

  notifyAgent = vi.fn();
  deps = {
    db,
    manager: emptyManager,
    version: "test",
    notifyAgent,
    reconcile: async () => {},
    probe: async () => "none",
  };
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("standard agents", () => {
  it("never see the management tools", async () => {
    const client = await connect("helper");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("switchboard__list_servers");
    expect(names).not.toContain(META_TOOL_ADD_SERVER);
    expect(names).not.toContain(META_TOOL_ASSIGN_SERVER);
    expect(names).not.toContain(META_TOOL_LIST_AGENTS);
    expect(names).not.toContain(META_TOOL_SERVER_STATUS);
  });

  it("are refused when they call one by name", async () => {
    const client = await connect("helper");
    await expect(
      client.callTool({ name: META_TOOL_ADD_SERVER, arguments: { config: "{}" } }),
    ).rejects.toThrow(/requires the manager role/);
    await expect(client.callTool({ name: META_TOOL_LIST_AGENTS, arguments: {} })).rejects.toThrow(
      /requires the manager role/,
    );
  });
});

describe("manager agents", () => {
  it("see the management tools", async () => {
    const client = await connect("boss");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([META_TOOL_ADD_SERVER, META_TOOL_ASSIGN_SERVER, META_TOOL_LIST_AGENTS, META_TOOL_SERVER_STATUS]),
    );
  });

  it("pick up a role granted mid-session on the next tools/list", async () => {
    db.update(agents).set({ role: "standard" }).where(eq(agents.slug, "boss")).run();
    const client = await connect("boss");
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(META_TOOL_ADD_SERVER);

    db.update(agents).set({ role: "manager" }).where(eq(agents.slug, "boss")).run();
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(META_TOOL_ADD_SERVER);
  });
});

describe(META_TOOL_ADD_SERVER, () => {
  it("registers a server from a `claude mcp add` line and enables it for the caller", async () => {
    const client = await connect("boss");
    const res = await callJson(client, META_TOOL_ADD_SERVER, {
      config: "claude mcp add foo --transport http https://example.com/mcp",
    });

    expect(res.servers).toEqual([{ slug: "foo", status: "connecting", toolCount: 0 }]);
    const row = db.select().from(servers).where(eq(servers.slug, "foo")).get();
    expect(row).toMatchObject({ type: "http", url: "https://example.com/mcp", createdByAgentSlug: "boss" });
    expect(matrixRow("boss", "foo")?.enabled).toBe(true);
    expect(notifyAgent).toHaveBeenCalledWith(agentId("boss"));
  });

  it("registers servers from an mcpServers JSON blob", async () => {
    const client = await connect("boss");
    const res = await callJson(client, META_TOOL_ADD_SERVER, {
      config: JSON.stringify({
        mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      }),
    });

    expect(res.servers).toEqual([{ slug: "linear", status: "connecting", toolCount: 0 }]);
    expect(db.select().from(servers).where(eq(servers.slug, "linear")).get()?.createdByAgentSlug).toBe("boss");
    expect(matrixRow("boss", "linear")?.enabled).toBe(true);
  });

  it("enables the new server for other agents named in enable_for", async () => {
    const client = await connect("boss");
    await callJson(client, META_TOOL_ADD_SERVER, {
      config: "claude mcp add foo --transport http https://example.com/mcp",
      enable_for: ["helper", "ghost"],
    });

    expect(matrixRow("helper", "foo")?.enabled).toBe(true);
    expect(matrixRow("boss", "foo")).toBeUndefined();
    expect(notifyAgent).toHaveBeenCalledWith(agentId("helper"));
  });

  it("warns instead of throwing when enable_for names an unknown agent", async () => {
    const client = await connect("boss");
    const res = await callJson(client, META_TOOL_ADD_SERVER, {
      config: "claude mcp add foo --transport http https://example.com/mcp",
      enable_for: ["ghost"],
    });
    expect(res.warnings).toEqual([expect.stringContaining("ghost")]);
    expect(res.servers[0].status).toBe("connecting");
  });

  it("files stdio servers as a pending request instead of creating them", async () => {
    const client = await connect("boss");
    const res = await callJson(client, META_TOOL_ADD_SERVER, {
      config: JSON.stringify({ mcpServers: { local: { command: "npx", args: ["-y", "evil"] } } }),
    });

    expect(res.servers[0]).toMatchObject({ slug: "local", status: "pending_approval", requestId: expect.any(Number) });
    expect(res.servers[0].note).toMatch(/admin approval/);
    expect(db.select().from(servers).where(eq(servers.slug, "local")).get()).toBeUndefined();

    const request = db.select().from(serverRequests).where(eq(serverRequests.id, res.servers[0].requestId)).get();
    expect(request).toMatchObject({ kind: "add_server", status: "pending", requestedByAgentSlug: "boss" });
  });

  it("reports slug collisions and reserved slugs as per-server errors", async () => {
    const client = await connect("boss");
    const res = await callJson(client, META_TOOL_ADD_SERVER, {
      config: [
        "claude mcp add github --transport http https://example.com/one",
        "claude mcp add switchboard --transport http https://example.com/two",
      ].join("\n"),
    });

    expect(res.servers).toEqual([
      { slug: "github", status: "error", error: expect.stringContaining("already in use") },
      { slug: "switchboard", status: "error", error: expect.stringContaining("reserved") },
    ]);
    expect(db.select().from(servers).all()).toHaveLength(1);
  });

  it("creates OAuth-detected servers as needs_auth", async () => {
    deps.probe = async () => "oauth";
    const client = await connect("boss");
    const res = await callJson(client, META_TOOL_ADD_SERVER, {
      config: "claude mcp add notion --transport http https://mcp.notion.com/mcp",
    });

    expect(res.servers[0]).toMatchObject({ slug: "notion", status: "needs_auth" });
    expect(db.select().from(servers).where(eq(servers.slug, "notion")).get()?.authType).toBe("oauth");
  });

  it("surfaces unparseable configs as a tool error", async () => {
    const client = await connect("boss");
    await expect(client.callTool({ name: META_TOOL_ADD_SERVER, arguments: { config: "nonsense" } })).rejects.toThrow(
      /Could not parse config/,
    );
  });
});

describe(META_TOOL_ASSIGN_SERVER, () => {
  it("upserts the matrix row and notifies the target agent", async () => {
    const client = await connect("boss");
    const res = await callJson(client, META_TOOL_ASSIGN_SERVER, {
      server_slug: "github",
      agent_slug: "helper",
      enabled: true,
    });

    expect(res).toEqual({ serverSlug: "github", agentSlug: "helper", enabled: true });
    expect(matrixRow("helper", "github")?.enabled).toBe(true);
    expect(notifyAgent).toHaveBeenCalledWith(agentId("helper"));
  });

  it("revokes an existing assignment", async () => {
    const client = await connect("boss");
    await callJson(client, META_TOOL_ASSIGN_SERVER, { server_slug: "github", agent_slug: "helper", enabled: true });
    await callJson(client, META_TOOL_ASSIGN_SERVER, { server_slug: "github", agent_slug: "helper", enabled: false });
    expect(matrixRow("helper", "github")?.enabled).toBe(false);
  });

  it("rejects unknown slugs with a clear message", async () => {
    const client = await connect("boss");
    await expect(
      client.callTool({ name: META_TOOL_ASSIGN_SERVER, arguments: { server_slug: "nope", agent_slug: "helper", enabled: true } }),
    ).rejects.toThrow(/Unknown server "nope"/);
    await expect(
      client.callTool({ name: META_TOOL_ASSIGN_SERVER, arguments: { server_slug: "github", agent_slug: "nope", enabled: true } }),
    ).rejects.toThrow(/Unknown agent "nope"/);
  });
});

describe(META_TOOL_LIST_AGENTS, () => {
  it("lists roles and enabled servers without any token material", async () => {
    db.insert(agentServers).values({ agentId: agentId("helper"), serverId: 1, enabled: true }).run();
    const client = await connect("boss");
    const result = (await client.callTool({ name: META_TOOL_LIST_AGENTS, arguments: {} })) as {
      content: { text: string }[];
    };
    const text = result.content[0].text;

    expect(JSON.parse(text)).toEqual([
      { slug: "boss", name: "Boss", role: "manager", servers: [] },
      { slug: "helper", name: "Helper", role: "standard", servers: ["github"] },
    ]);
    expect(text).not.toContain(BOSS_TOKEN);
    expect(text).not.toContain(HELPER_TOKEN);
    expect(text).not.toContain("token");
  });
});

describe(META_TOOL_SERVER_STATUS, () => {
  it("reports connection state for a known server", async () => {
    const client = await connect("boss");
    const res = await callJson(client, META_TOOL_SERVER_STATUS, { server_slug: "github" });
    expect(res).toMatchObject({ slug: "github", type: "http", state: "connecting", toolCount: 0, lastError: null });
    expect(res.stderr).toBeUndefined();
  });

  it("rejects unknown servers", async () => {
    const client = await connect("boss");
    await expect(
      client.callTool({ name: META_TOOL_SERVER_STATUS, arguments: { server_slug: "nope" } }),
    ).rejects.toThrow(/Unknown server "nope"/);
  });
});
