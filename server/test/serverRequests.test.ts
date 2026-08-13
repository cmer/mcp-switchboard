import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agentServers, agents, serverRequests, servers } from "../src/db/schema.js";
import {
  buildAgentServer,
  META_TOOL_ADD_SERVER,
  META_TOOL_REQUEST_SERVER,
  META_TOOL_REQUEST_STATUS,
  type AgentServerDeps,
} from "../src/core/agentServerFactory.js";
import { encrypt, loadOrCreateKey } from "../src/lib/crypto.js";
import { writeSetting } from "../src/lib/settings.js";
import { requestRoutes } from "../src/http/routes/requests.js";
import { authRoutes } from "../src/http/routes/auth.js";
import type { AppContext } from "../src/http/context.js";
import type { UpstreamManager } from "../src/core/upstreamManager.js";

const SECRET_ENV_VALUE = "super-secret-api-key-value";

let db: Db;
let deps: AgentServerDeps;
let api: Hono;
let notifyAgent: ReturnType<typeof vi.fn>;
let tmp: string;

/** No connections and no reconcile: nothing in these tests dials a real upstream. */
const emptyManager = {
  get: () => undefined,
  getBySlug: () => undefined,
  reconcile: async () => {},
} as unknown as UpstreamManager;

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

/** Hono's in-memory dispatch — the routes are mounted behind admin auth in app.ts. */
async function apiCall(method: string, url: string, body?: unknown) {
  const res = await api.request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const STDIO_CONFIG = JSON.stringify({
  mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp"], env: { API_KEY: SECRET_ENV_VALUE } } },
});

/** File one stdio request as `helper` and return its id. */
async function fileStdioRequest(): Promise<number> {
  const client = await connect("helper");
  const res = await callJson(client, META_TOOL_REQUEST_SERVER, { config: STDIO_CONFIG, reason: "browser automation" });
  return res.requestIds[0];
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-requests-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  const now = Date.now();
  db.insert(agents)
    .values({ slug: "boss", name: "Boss", role: "manager", tokenEnc: encrypt("boss-token"), createdAt: now })
    .run();
  db.insert(agents)
    .values({ slug: "helper", name: "Helper", role: "standard", tokenEnc: encrypt("helper-token"), createdAt: now })
    .run();

  notifyAgent = vi.fn();
  deps = { db, manager: emptyManager, version: "test", notifyAgent, reconcile: async () => {}, probe: async () => "none" };
  // The hub is reached through adminDeps, which forwards an optional `kind` we don't assert on.
  const ctx = { db, manager: emptyManager, hub: { notifyAgent: (id: number) => notifyAgent(id) } };
  api = requestRoutes(ctx as unknown as AppContext);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe(META_TOOL_REQUEST_SERVER, () => {
  it("is offered to standard agents", async () => {
    const client = await connect("helper");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain(META_TOOL_REQUEST_SERVER);
    expect(names).toContain(META_TOOL_REQUEST_STATUS);
  });

  it("files a pending request and never stores the config in plaintext", async () => {
    const client = await connect("helper");
    const res = await callJson(client, META_TOOL_REQUEST_SERVER, { config: STDIO_CONFIG, reason: "browser automation" });

    expect(res.requestIds).toHaveLength(1);
    expect(res.message).toBe(
      `Request #${res.requestIds[0]} pending — the admin will review it. Your tools will update automatically if approved.`,
    );

    const row = db.select().from(serverRequests).where(eq(serverRequests.id, res.requestIds[0])).get()!;
    expect(row).toMatchObject({
      kind: "add_server",
      status: "pending",
      requestedByAgentId: agentId("helper"),
      requestedByAgentSlug: "helper",
      reason: "browser automation",
      resolvedAt: null,
    });
    expect(row.payloadJsonEnc).toBeTruthy();
    expect(row.payloadJsonEnc).not.toContain(SECRET_ENV_VALUE);
    expect(row.payloadJsonEnc).not.toContain("playwright");
    expect(db.select().from(servers).all()).toHaveLength(0);
  });

  it("records a freeform ask when no config is given", async () => {
    const client = await connect("helper");
    const res = await callJson(client, META_TOOL_REQUEST_SERVER, { reason: "I need Linear access" });

    const row = db.select().from(serverRequests).where(eq(serverRequests.id, res.requestIds[0])).get()!;
    expect(row).toMatchObject({ kind: "freeform", status: "pending", reason: "I need Linear access" });
    expect(row.payloadJsonEnc).toBeNull();
  });

  it("rejects a config it cannot parse so the agent can fix it", async () => {
    const client = await connect("helper");
    await expect(
      client.callTool({ name: META_TOOL_REQUEST_SERVER, arguments: { config: "nonsense", reason: "why not" } }),
    ).rejects.toThrow(/Could not parse config/);
    expect(db.select().from(serverRequests).all()).toHaveLength(0);
  });

  it("requires a reason", async () => {
    const client = await connect("helper");
    await expect(client.callTool({ name: META_TOOL_REQUEST_SERVER, arguments: {} })).rejects.toThrow(/"reason"/);
  });

  it("is hidden and refused when the admin disables requests", async () => {
    writeSetting(db, "allowServerRequests", "0");
    const client = await connect("helper");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain(META_TOOL_REQUEST_SERVER);
    expect(names).not.toContain(META_TOOL_REQUEST_STATUS);

    await expect(
      client.callTool({ name: META_TOOL_REQUEST_SERVER, arguments: { reason: "please" } }),
    ).rejects.toThrow(/disabled on this switchboard/);
    expect(db.select().from(serverRequests).all()).toHaveLength(0);
  });
});

describe(META_TOOL_ADD_SERVER, () => {
  it("files a manager's stdio config for approval instead of creating it", async () => {
    const client = await connect("boss");
    const res = await callJson(client, META_TOOL_ADD_SERVER, { config: STDIO_CONFIG });

    expect(res.servers[0]).toMatchObject({ slug: "playwright", status: "pending_approval", requestId: expect.any(Number) });
    expect(db.select().from(servers).all()).toHaveLength(0);

    const row = db.select().from(serverRequests).where(eq(serverRequests.id, res.servers[0].requestId)).get()!;
    expect(row).toMatchObject({ kind: "add_server", status: "pending", requestedByAgentSlug: "boss" });
    expect(row.payloadJsonEnc).not.toContain(SECRET_ENV_VALUE);
  });
});

describe(META_TOOL_REQUEST_STATUS, () => {
  it("returns only the calling agent's requests", async () => {
    const helper = await connect("helper");
    const boss = await connect("boss");
    await callJson(helper, META_TOOL_REQUEST_SERVER, { reason: "helper wants Linear" });
    await callJson(boss, META_TOOL_REQUEST_SERVER, { reason: "boss wants Notion" });

    expect(await callJson(helper, META_TOOL_REQUEST_STATUS)).toEqual([
      expect.objectContaining({ reason: "helper wants Linear", status: "pending", server: null }),
    ]);
    expect(await callJson(boss, META_TOOL_REQUEST_STATUS)).toEqual([
      expect.objectContaining({ reason: "boss wants Notion" }),
    ]);
  });

  it("summarises a stored config without leaking env values", async () => {
    const id = await fileStdioRequest();
    const helper = await connect("helper");
    const [entry] = await callJson(helper, META_TOOL_REQUEST_STATUS, { id });

    expect(entry.server).toEqual({
      name: "playwright",
      slug: "playwright",
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp"],
      url: null,
      authType: "none",
      envKeys: ["API_KEY"],
    });
    expect(JSON.stringify(entry)).not.toContain(SECRET_ENV_VALUE);
  });
});

describe("GET /api/requests", () => {
  it("lists requests newest first with a decrypted, secret-free summary", async () => {
    await fileStdioRequest();
    const helper = await connect("helper");
    await callJson(helper, META_TOOL_REQUEST_SERVER, { reason: "and Linear too" });

    const { status, body } = await apiCall("GET", "/");
    expect(status).toBe(200);
    expect(body.map((r: any) => r.kind)).toEqual(["freeform", "add_server"]);
    expect(body[1]).toMatchObject({
      requestedByAgentSlug: "helper",
      kind: "add_server",
      status: "pending",
      reason: "browser automation",
      resolutionNote: null,
      resolvedAt: null,
      server: { slug: "playwright", command: "npx", envKeys: ["API_KEY"] },
    });
    expect(body[0].server).toBeNull();
    expect(JSON.stringify(body)).not.toContain(SECRET_ENV_VALUE);
  });
});

describe("POST /api/requests/:id/approve", () => {
  it("creates the server, enables it for the requester and notifies its live sessions", async () => {
    const id = await fileStdioRequest();
    const { status, body } = await apiCall("POST", `/${id}/approve`);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.server).toMatchObject({
      slug: "playwright",
      type: "stdio",
      command: "npx",
      envKeys: ["API_KEY"],
      hasEnv: true,
      createdByAgentSlug: "helper",
    });
    expect(JSON.stringify(body)).not.toContain(SECRET_ENV_VALUE);

    expect(matrixRow("helper", "playwright")?.enabled).toBe(true);
    expect(notifyAgent).toHaveBeenCalledWith(agentId("helper"));

    const row = db.select().from(serverRequests).where(eq(serverRequests.id, id)).get()!;
    expect(row.status).toBe("approved");
    expect(row.resolvedAt).toBeGreaterThan(0);
  });

  it("leaves the request pending when the slug was taken in the meantime", async () => {
    const id = await fileStdioRequest();
    const now = Date.now();
    db.insert(servers)
      .values({ slug: "playwright", name: "Playwright", type: "stdio", command: "npx", createdAt: now, updatedAt: now })
      .run();

    const { status, body } = await apiCall("POST", `/${id}/approve`);
    expect(status).toBe(409);
    expect(body.error).toMatch(/already in use/);
    expect(db.select().from(serverRequests).where(eq(serverRequests.id, id)).get()?.status).toBe("pending");
  });

  it("refuses freeform requests, which have nothing to execute", async () => {
    const helper = await connect("helper");
    const res = await callJson(helper, META_TOOL_REQUEST_SERVER, { reason: "I need Linear access" });

    const { status, body } = await apiCall("POST", `/${res.requestIds[0]}/approve`);
    expect(status).toBe(400);
    expect(body.error).toBe("Freeform requests can't be auto-executed — deny with a note, or add the server manually");
    expect(db.select().from(servers).all()).toHaveLength(0);
  });

  it("404s on an unknown id and 409s once resolved", async () => {
    expect((await apiCall("POST", "/999/approve")).status).toBe(404);

    const id = await fileStdioRequest();
    expect((await apiCall("POST", `/${id}/approve`)).status).toBe(200);
    const second = await apiCall("POST", `/${id}/approve`);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("Request already resolved");
  });
});

describe("allowServerRequests setting", () => {
  /** The toggle the UI reads from /api/auth/me and writes to /api/auth/settings. */
  function authApi(): Hono {
    const adminSessions = { has: () => true, create: () => "sid", delete: () => {}, deleteAll: () => {} };
    return authRoutes({ db, manager: emptyManager, adminSessions } as unknown as AppContext);
  }

  it("round-trips through /api/auth and gates the tools", async () => {
    const app = authApi();
    const me = async () => (await (await app.request("/me")).json()) as any;
    expect((await me()).allowServerRequests).toBe(true);

    const off = await app.request("/settings", {
      method: "POST",
      body: JSON.stringify({ allowServerRequests: false }),
      headers: { "Content-Type": "application/json" },
    });
    expect(off.status).toBe(200);
    expect((await me()).allowServerRequests).toBe(false);
    const hidden = (await (await connect("helper")).listTools()).tools.map((t) => t.name);
    expect(hidden).not.toContain(META_TOOL_REQUEST_SERVER);

    await app.request("/settings", {
      method: "POST",
      body: JSON.stringify({ allowServerRequests: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect((await me()).allowServerRequests).toBe(true);
    const names = (await (await connect("helper")).listTools()).tools.map((t) => t.name);
    expect(names).toContain(META_TOOL_REQUEST_SERVER);
  });
});

describe("POST /api/requests/:id/deny", () => {
  it("stores the note where the requesting agent can read it back", async () => {
    const id = await fileStdioRequest();
    const { status, body } = await apiCall("POST", `/${id}/deny`, { note: "use the hosted version instead" });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });

    const helper = await connect("helper");
    const [entry] = await callJson(helper, META_TOOL_REQUEST_STATUS, { id });
    expect(entry).toMatchObject({ id, status: "denied", resolutionNote: "use the hosted version instead" });
    expect(entry.resolvedAt).toBeGreaterThan(0);
    expect(db.select().from(servers).all()).toHaveLength(0);
  });

  it("accepts an empty body and refuses to re-resolve", async () => {
    const id = await fileStdioRequest();
    expect((await apiCall("POST", `/${id}/deny`)).status).toBe(200);
    expect(db.select().from(serverRequests).where(eq(serverRequests.id, id)).get()?.resolutionNote).toBeNull();

    const second = await apiCall("POST", `/${id}/deny`, { note: "again" });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("Request already resolved");
  });
});
