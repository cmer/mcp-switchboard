import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq } from "drizzle-orm";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agentServers, agents, servers } from "../src/db/schema.js";
import {
  buildAgentServer,
  META_TOOL_CALL_TOOL,
  META_TOOL_DESCRIBE_TOOLS,
  META_TOOL_LIST_SERVERS,
  META_TOOL_REQUEST_SERVER,
  META_TOOL_REQUEST_STATUS,
  META_TOOL_SEARCH_TOOLS,
  type AgentServerDeps,
} from "../src/core/agentServerFactory.js";
import { encrypt, loadOrCreateKey } from "../src/lib/crypto.js";
import { writeSetting } from "../src/lib/settings.js";
import type { UpstreamConnection } from "../src/core/upstreamConnection.js";
import type { UpstreamManager } from "../src/core/upstreamManager.js";

const GMAIL_NOTE = "Work Gmail — carl@company.com";
const LONG_DESCRIPTION = `Search the mailbox for messages. ${"Supports the same operators as the web UI. ".repeat(6)}`.trim();

const GMAIL_TOOLS: Tool[] = [
  {
    name: "send_email",
    description: "Send an email message to one or more recipients.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" } },
      required: ["to"],
    },
  },
  { name: "search_messages", description: LONG_DESCRIPTION, inputSchema: { type: "object", properties: {} } },
  { name: "archive_thread", description: "Archive a thread.", inputSchema: { type: "object", properties: {} } },
];

const GITHUB_TOOLS: Tool[] = [
  {
    name: "create_issue",
    description: "Open a new issue on a repository.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, labels: { type: "array", items: { $ref: "#/$defs/Label" } } },
      required: ["owner"],
      $defs: { Label: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    },
    outputSchema: { type: "object", properties: { number: { type: "number" } }, required: ["number"] },
  },
  {
    name: "list_issues",
    description: "List issues on a repository.",
    inputSchema: { type: "object", properties: { state: { type: "string" } } },
  },
  // Input and output both `$ref` a `Value` def, with deliberately different bodies.
  {
    name: "get_setting",
    description: "Read one repository setting.",
    inputSchema: {
      type: "object",
      properties: { value: { $ref: "#/$defs/Value" } },
      required: ["value"],
      $defs: { Value: { type: "string" } },
    },
    outputSchema: {
      type: "object",
      properties: { value: { $ref: "#/$defs/Value" } },
      required: ["value"],
      $defs: { Value: { type: "object", properties: { raw: { type: "string" } }, required: ["raw"] } },
    },
  },
  // Same def name, same body on both sides — nothing to keep apart.
  {
    name: "list_labels",
    description: "List the labels on a repository.",
    inputSchema: {
      type: "object",
      properties: { label: { $ref: "#/$defs/Label" } },
      required: ["label"],
      $defs: { Label: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    },
    outputSchema: {
      type: "object",
      properties: { labels: { type: "array", items: { $ref: "#/$defs/Label" } } },
      required: ["labels"],
      $defs: { Label: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    },
  },
];

/** Lives on a server only the lean agent has, so full-mode listing never sees its unrenderable schema. */
const QUIRKY_TOOLS: Tool[] = [
  { name: "weird_thing", description: "Does something odd.", inputSchema: "garbage" as unknown as Tool["inputSchema"] },
];

const SECRET_TOOLS: Tool[] = [
  { name: "send_email", description: "Send an email from the secret account.", inputSchema: { type: "object" } },
];

type FakeConn = UpstreamConnection & { callTool: ReturnType<typeof vi.fn> };

let db: Db;
let deps: AgentServerDeps;
let tmp: string;
let conns: Record<string, FakeConn>;

function fakeConn(id: number, slug: string, description: string | null, tools: Tool[]): FakeConn {
  return {
    serverId: id,
    state: "connected",
    row: { id, slug, name: slug, description, type: "http", enabled: true },
    toolsCache: [...tools],
    promptsCache: [],
    resourcesCache: [],
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  } as unknown as FakeConn;
}

function agentId(slug: string): number {
  return db.select({ id: agents.id }).from(agents).where(eq(agents.slug, slug)).get()!.id;
}

async function connect(slug: string): Promise<Client> {
  const row = db.select().from(agents).where(eq(agents.slug, slug)).get()!;
  const server = buildAgentServer(row, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name);
}

async function callRaw(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await callRaw(client, name, args);
  return JSON.parse(result.content[0].text);
}

async function search(client: Client, args: Record<string, unknown>): Promise<any> {
  return callJson(client, META_TOOL_SEARCH_TOOLS, args);
}

async function describe_(client: Client, names: string[]): Promise<any[]> {
  return (await callJson(client, META_TOOL_DESCRIBE_TOOLS, { names })).tools;
}

/** Grow one server's cache to prove the lean surface does not grow with it. */
function fillTools(conn: FakeConn, count: number): void {
  conn.toolsCache = Array.from({ length: count }, (_, i) => ({
    name: `bulk_tool_${String(i).padStart(3, "0")}`,
    description: `Bulk tool number ${i} for load testing the lean surface.`,
    inputSchema: { type: "object" as const, properties: {} },
  }));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-lean-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  const now = Date.now();

  for (const [id, slug, description] of [
    [1, "gmail", GMAIL_NOTE],
    [2, "github", null],
    [3, "secret", null],
    [4, "quirky", null],
  ] as const) {
    db.insert(servers)
      .values({ id, slug, name: slug, description, type: "http", url: `https://${slug}.test/mcp`, createdAt: now, updatedAt: now })
      .run();
  }

  db.insert(agents)
    .values({ id: 1, slug: "lean", name: "Lean", toolMode: "lean", tokenEnc: encrypt("lean-token"), createdAt: now })
    .run();
  db.insert(agents)
    .values({ id: 2, slug: "fully", name: "Fully", toolMode: "full", tokenEnc: encrypt("full-token"), createdAt: now })
    .run();

  // The lean agent gets gmail + github + quirky; "secret" is deliberately switched off for it.
  for (const [agentIdValue, serverId, enabled] of [
    [1, 1, true],
    [1, 2, true],
    [1, 3, false],
    [1, 4, true],
    [2, 1, true],
    [2, 2, true],
  ] as const) {
    db.insert(agentServers).values({ agentId: agentIdValue, serverId, enabled }).run();
  }

  conns = {
    gmail: fakeConn(1, "gmail", GMAIL_NOTE, GMAIL_TOOLS),
    github: fakeConn(2, "github", null, GITHUB_TOOLS),
    secret: fakeConn(3, "secret", null, SECRET_TOOLS),
    quirky: fakeConn(4, "quirky", null, QUIRKY_TOOLS),
  };
  const all = Object.values(conns);
  const manager = {
    get: (id: number) => all.find((c) => c.serverId === id),
    getBySlug: (slug: string) => all.find((c) => c.row.slug === slug),
  } as unknown as UpstreamManager;

  deps = { db, manager, version: "test", notifyAgent: vi.fn(), reconcile: async () => {}, probe: async () => "none" };
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("lean tools/list", () => {
  it("is the three meta-tools, the roster tool and the request tools — never upstream tools", async () => {
    const client = await connect("lean");
    expect(await toolNames(client)).toEqual([
      META_TOOL_SEARCH_TOOLS,
      META_TOOL_DESCRIBE_TOOLS,
      META_TOOL_CALL_TOOL,
      META_TOOL_LIST_SERVERS,
      META_TOOL_REQUEST_SERVER,
      META_TOOL_REQUEST_STATUS,
    ]);
  });

  it("drops the request tools when the admin switched them off", async () => {
    writeSetting(db, "allowServerRequests", "0");
    const client = await connect("lean");
    expect(await toolNames(client)).toEqual([
      META_TOOL_SEARCH_TOOLS,
      META_TOOL_DESCRIBE_TOOLS,
      META_TOOL_CALL_TOOL,
      META_TOOL_LIST_SERVERS,
    ]);
  });

  it("stays constant-size and small as the upstream catalog grows", async () => {
    const client = await connect("lean");
    fillTools(conns.gmail, 5);
    const small = (await client.listTools()).tools;

    fillTools(conns.gmail, 200);
    const big = (await client.listTools()).tools;

    expect(big).toHaveLength(small.length);
    expect(JSON.stringify(big).length).toBeLessThan(4096);
  });
});

describe("full mode", () => {
  it("is untouched: namespaced upstream tools, then the roster tool, then the request tools", async () => {
    const client = await connect("fully");
    const tools = (await client.listTools()).tools;

    const expectedUpstream = [
      ...GMAIL_TOOLS.map((t) => ({ ...t, name: `gmail__${t.name}`, description: `(via gmail: ${GMAIL_NOTE}) ${t.description}` })),
      ...GITHUB_TOOLS.map((t) => ({ ...t, name: `github__${t.name}` })),
    ];
    expect(tools.slice(0, expectedUpstream.length)).toEqual(expectedUpstream);
    expect(tools.slice(expectedUpstream.length).map((t) => t.name)).toEqual([
      META_TOOL_LIST_SERVERS,
      META_TOOL_REQUEST_SERVER,
      META_TOOL_REQUEST_STATUS,
    ]);
    expect(tools.map((t) => t.name)).not.toContain(META_TOOL_SEARCH_TOOLS);
  });

  it("refuses the lean meta-tools by name", async () => {
    const client = await connect("fully");
    for (const name of [META_TOOL_SEARCH_TOOLS, META_TOOL_DESCRIBE_TOOLS, META_TOOL_CALL_TOOL]) {
      await expect(client.callTool({ name, arguments: {} })).rejects.toThrow(/full tool exposure/);
    }
  });
});

describe(META_TOOL_SEARCH_TOOLS, () => {
  it("never returns tools from a server the agent has switched off", async () => {
    const client = await connect("lean");
    const res = await search(client, { query: "send email", limit: 25 });
    expect(res.items.map((i: any) => i.name)).toContain("gmail__send_email");
    expect(res.items.map((i: any) => i.server)).not.toContain("secret");
  });

  it("ranks an exact tool name first", async () => {
    const client = await connect("lean");
    const res = await search(client, { query: "create_issue" });
    expect(res.items[0].name).toBe("github__create_issue");
    expect(res.items[0].score).toBeGreaterThan(0);
  });

  it("refuses an empty search rather than dumping the catalog", async () => {
    const client = await connect("lean");
    const res = await callRaw(client, META_TOOL_SEARCH_TOOLS, { query: "   " });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      'Provide a query (e.g. "send email"), or a server slug to enumerate one server\'s tools.',
    );
  });

  it("enumerates one server, sorted by name, when the query is empty", async () => {
    const client = await connect("lean");
    const res = await search(client, { server: "gmail" });
    expect(res.items.map((i: any) => i.name)).toEqual([
      "gmail__archive_thread",
      "gmail__search_messages",
      "gmail__send_email",
    ]);
    expect(res.items.every((i: any) => i.score === 0)).toBe(true);
    expect(res.total).toBe(3);
  });

  it("names this agent's valid slugs when the server filter is unknown", async () => {
    const client = await connect("lean");
    const res = await callRaw(client, META_TOOL_SEARCH_TOOLS, { server: "secret" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Unknown server "secret"');
    expect(res.content[0].text).toContain("gmail");
    expect(res.content[0].text).not.toContain("secret,");
  });

  it("clamps the limit and round-trips nextOffset", async () => {
    fillTools(conns.gmail, 200);
    const client = await connect("lean");

    const first = await search(client, { server: "gmail", limit: 100 });
    expect(first.items).toHaveLength(25);
    expect(first.total).toBe(200);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(25);

    const second = await search(client, { server: "gmail", limit: 100, offset: first.nextOffset });
    expect(second.items[0].name).toBe("gmail__bulk_tool_025");

    const last = await search(client, { server: "gmail", limit: 25, offset: 175 });
    expect(last.hasMore).toBe(false);
    expect(last.nextOffset).toBeNull();
  });

  it("truncates long descriptions in results but scores on the full text", async () => {
    const client = await connect("lean");
    const res = await search(client, { query: "search the mailbox for messages" });
    const hit = res.items.find((i: any) => i.name === "gmail__search_messages");
    expect(hit.description).toHaveLength(161);
    expect(hit.description.endsWith("…")).toBe(true);
  });
});

describe(META_TOOL_DESCRIBE_TOOLS, () => {
  it("renders input and output shapes as compact TypeScript", async () => {
    const client = await connect("lean");
    const [send] = await describe_(client, ["gmail__send_email"]);
    expect(send).toEqual({
      name: "gmail__send_email",
      server: "gmail",
      description: `(via gmail: ${GMAIL_NOTE}) Send an email message to one or more recipients.`,
      inputType: "{ to: string; subject?: string }",
    });
  });

  it("emits outputType and definitions only when the tool has them", async () => {
    const client = await connect("lean");
    const [create, list] = await describe_(client, ["github__create_issue", "github__list_issues"]);
    expect(create.inputType).toBe("{ owner: string; labels?: Label[] }");
    expect(create.outputType).toBe("{ number: number }");
    expect(create.definitions).toEqual({ Label: "{ name: string }" });
    expect(create.outputDefinitions).toBeUndefined();
    expect(list.outputType).toBeUndefined();
    expect(list.definitions).toBeUndefined();
  });

  it("never lets an output def overwrite the input def of the same name", async () => {
    const client = await connect("lean");
    const [setting, labels] = await describe_(client, ["github__get_setting", "github__list_labels"]);

    expect(setting.inputType).toBe("{ value: Value }");
    expect(setting.outputType).toBe("{ value: Value }");
    expect(setting.definitions).toEqual({ Value: "string" });
    expect(setting.outputDefinitions).toEqual({ Value: "{ raw: string }" });

    // Identical bodies are the same contract, so they merge instead of splitting.
    expect(labels.definitions).toEqual({ Label: "{ name: string }" });
    expect(labels.outputDefinitions).toBeUndefined();
  });

  it("falls back to the raw JSON Schema when the schema cannot be rendered", async () => {
    const client = await connect("lean");
    const [weird] = await describe_(client, ["quirky__weird_thing"]);
    expect(weird.inputType).toBeUndefined();
    expect(weird.inputSchema).toBe("garbage");
    expect(weird.name).toBe("quirky__weird_thing");
  });

  it("keeps request order and reports failures inline", async () => {
    const client = await connect("lean");
    const tools = await describe_(client, ["gmail__send_email", "gmail__nope", "github__list_issues"]);
    expect(tools.map((t) => t.name)).toEqual(["gmail__send_email", "gmail__nope", "github__list_issues"]);
    expect(tools[1].error).toBe("tool_not_found");
    expect(tools[0].error).toBeUndefined();
    expect(tools[2].error).toBeUndefined();
  });

  it("makes a real tool on a switched-off server indistinguishable from a nonexistent one", async () => {
    const client = await connect("lean");
    const [real, fake] = await describe_(client, ["secret__send_email", "secret__does_not_exist"]);
    expect(real).toEqual({ name: "secret__send_email", error: "tool_not_found", suggestions: expect.any(Array) });
    expect(fake.error).toBe("tool_not_found");
    // The switched-off server's tools must not leak through the suggestions either.
    for (const entry of [real, fake]) {
      expect(entry.suggestions.some((s: string) => s.startsWith("secret__"))).toBe(false);
    }
  });

  it("suggests the right tool for a typo", async () => {
    const client = await connect("lean");
    const [miss] = await describe_(client, ["gmail__sned_email"]);
    expect(miss.error).toBe("tool_not_found");
    expect(miss.suggestions).toContain("gmail__send_email");
  });

  it("tells the model to batch when it asks for too many at once", async () => {
    const client = await connect("lean");
    const res = await callRaw(client, META_TOOL_DESCRIBE_TOOLS, {
      names: Array.from({ length: 9 }, (_, i) => `gmail__tool_${i}`),
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/at most 8 per call/);
  });

  it("rejects a missing or malformed names argument", async () => {
    const client = await connect("lean");
    await expect(client.callTool({ name: META_TOOL_DESCRIBE_TOOLS, arguments: {} })).rejects.toThrow(/"names"/);
    await expect(
      client.callTool({ name: META_TOOL_DESCRIBE_TOOLS, arguments: { names: [1, 2] } }),
    ).rejects.toThrow(/"names"/);
  });
});

describe(META_TOOL_CALL_TOOL, () => {
  it("routes to the upstream connection with the bare name and arguments", async () => {
    const client = await connect("lean");
    const res = await callRaw(client, META_TOOL_CALL_TOOL, {
      name: "gmail__send_email",
      arguments: { to: "a@b.test" },
    });

    expect(conns.gmail.callTool).toHaveBeenCalledWith(
      "send_email",
      { to: "a@b.test" },
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(res.content[0].text).toBe("ok");
  });

  it("enforces the matrix for a server the agent does not have", async () => {
    const client = await connect("lean");
    await expect(
      client.callTool({ name: META_TOOL_CALL_TOOL, arguments: { name: "secret__send_email" } }),
    ).rejects.toThrow(/Unknown server "secret"/);
    expect(conns.secret.callTool).not.toHaveBeenCalled();
  });

  it("reports a real server the agent lacks exactly like a nonexistent one", async () => {
    const client = await connect("lean");
    const message = (name: string, via: "wrapped" | "direct") =>
      client
        .callTool(via === "wrapped" ? { name: META_TOOL_CALL_TOOL, arguments: { name } } : { name, arguments: {} })
        .then(
          () => "unexpectedly succeeded",
          (err: Error) => err.message,
        );

    for (const via of ["wrapped", "direct"] as const) {
      const forbidden = await message("secret__send_email", via);
      const nonexistent = await message("ghost__send_email", via);
      // Identical but for the slug the agent supplied itself: nothing here says which slugs exist.
      expect(forbidden.replace("secret", "SLUG")).toBe(nonexistent.replace("ghost", "SLUG"));
      expect(forbidden).toContain('Unknown server "secret"');
    }
    expect(conns.secret.callTool).not.toHaveBeenCalled();
  });

  it("refuses to wrap a switchboard meta-tool", async () => {
    const client = await connect("lean");
    for (const inner of [META_TOOL_SEARCH_TOOLS, "switchboard__add_server"]) {
      const res = await callRaw(client, META_TOOL_CALL_TOOL, { name: inner });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(`Meta-tools are called directly, not through ${META_TOOL_CALL_TOOL}.`);
    }
  });

  it("passes an upstream tool error through untouched", async () => {
    conns.gmail.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "mailbox full" }],
      isError: true,
    });
    const client = await connect("lean");
    const res = await callRaw(client, META_TOOL_CALL_TOOL, { name: "gmail__send_email", arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("mailbox full");
  });
});

describe("mode changes mid-session", () => {
  it("flips the surface and the meta-tool guard on the next request", async () => {
    // quirky's unrenderable schema is fine for lean (never listed) but not for a full tools/list.
    db.update(agentServers)
      .set({ enabled: false })
      .where(and(eq(agentServers.agentId, agentId("lean")), eq(agentServers.serverId, 4)))
      .run();
    const client = await connect("lean");
    expect(await toolNames(client)).toContain(META_TOOL_SEARCH_TOOLS);

    db.update(agents).set({ toolMode: "full" }).where(eq(agents.id, agentId("lean"))).run();
    const full = await toolNames(client);
    expect(full).not.toContain(META_TOOL_SEARCH_TOOLS);
    expect(full).toContain("gmail__send_email");
    await expect(client.callTool({ name: META_TOOL_SEARCH_TOOLS, arguments: { query: "x" } })).rejects.toThrow(
      /full tool exposure/,
    );

    db.update(agents).set({ toolMode: "lean" }).where(eq(agents.id, agentId("lean"))).run();
    expect(await toolNames(client)).toContain(META_TOOL_SEARCH_TOOLS);
    expect(await search(client, { query: "send email" })).toMatchObject({ total: expect.any(Number) });
  });
});

describe("direct calls in lean mode", () => {
  it("still work for an agent that already knows the namespaced name", async () => {
    const client = await connect("lean");
    const res = await callRaw(client, "gmail__send_email", { to: "a@b.test" });
    expect(conns.gmail.callTool).toHaveBeenCalledWith("send_email", { to: "a@b.test" }, expect.anything());
    expect(res.content[0].text).toBe("ok");
  });
});

describe("lean instructions", () => {
  it("teach the search → describe → call loop without growing with the catalog", async () => {
    const client = await connect("lean");
    const instructions = client.getInstructions()!;

    for (const name of [META_TOOL_SEARCH_TOOLS, META_TOOL_DESCRIBE_TOOLS, META_TOOL_CALL_TOOL, META_TOOL_LIST_SERVERS]) {
      expect(instructions).toContain(name);
    }
    const preamble = instructions.slice(0, instructions.indexOf("Servers:"));
    expect(preamble.split("\n").filter((l) => l.trim() !== "")).toHaveLength(7);
    expect(instructions).toContain("- gmail__* — gmail");
  });

  it("are the full-mode text for a full-mode agent", async () => {
    const client = await connect("fully");
    const instructions = client.getInstructions()!;
    expect(instructions).toContain("MCP Switchboard: aggregates multiple MCP servers.");
    expect(instructions).not.toContain(META_TOOL_SEARCH_TOOLS);
  });
});
