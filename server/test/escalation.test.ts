import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { buildAgentServer, META_TOOL_REQUEST_SERVER, type AgentServerDeps } from "../src/core/agentServerFactory.js";
import { userScope } from "../src/core/userScope.js";
import { setCanRunLocalCommands } from "../src/core/users.js";
import { loadOrCreateKey } from "../src/lib/crypto.js";
import { AdminSessionStore } from "../src/http/adminAuth.js";
import { createApp } from "../src/http/app.js";
import type { AppContext } from "../src/http/context.js";
import type { UpstreamManager } from "../src/core/upstreamManager.js";

const SECRET = "bobs-very-secret-api-key";

let tmp: string;
let db: Db;
let app: Hono;
let notifyAgent: ReturnType<typeof vi.fn>;
let admin: string;
let bob: string;
let bobId: number;

async function call(method: string, url: string, cookie: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: set?.match(/sb_session=[^;]+/)?.[0] };
}

const LOCAL = {
  name: "Playwright",
  slug: "playwright",
  type: "stdio",
  command: "npx",
  args: ["-y", "@playwright/mcp"],
  env: { API_KEY: SECRET },
  cwd: "/home/bob",
};

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-escalate-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  notifyAgent = vi.fn();
  const ctx = {
    db,
    hub: { notifyAgent, dropAgentSessions: vi.fn(async () => {}), sessionCount: () => 0 },
    refresher: { cancel: vi.fn(), schedule: vi.fn() },
    manager: { reconcile: vi.fn(async () => {}), get: () => undefined },
    adminSessions: new AdminSessionStore(db),
    version: "test",
  };
  app = createApp(ctx as unknown as AppContext, path.join(tmp, "no-web"), { serveMcp: false });
  admin = (await call("POST", "/api/auth/setup", "", { password: "admin-pass" })).cookie!;
  const created = await call("POST", "/api/users", admin, { username: "bob" });
  bobId = created.body.user.id;
  bob = (await call("POST", "/api/auth/setup-code", "", { username: "bob", code: created.body.setupCode.code, password: "bob-pass" }))
    .cookie!;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("local commands via REST", () => {
  it("files a user's stdio server for the Admin instead of creating it", async () => {
    const res = await call("POST", "/api/servers", bob, LOCAL);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ requested: true, escalated: true, requestId: expect.any(Number) });
    expect(res.body.message).toMatch(/waiting for the Admin/);
    expect((await call("GET", "/api/servers", bob)).body).toEqual([]);

    const mine = await call("GET", "/api/requests", bob);
    expect(mine.body).toEqual([
      expect.objectContaining({ id: res.body.requestId, escalated: true, status: "pending", requestedByAgentSlug: null }),
    ]);
  });

  it("creates it directly for the Admin, and for a user with the flag", async () => {
    expect((await call("POST", "/api/servers", admin, LOCAL)).status).toBe(201);
    setCanRunLocalCommands(db, bobId, true);
    expect((await call("POST", "/api/servers", bob, LOCAL)).status).toBe(201);
  });

  it("splits a paste-import: remote servers are created, local ones filed", async () => {
    const text = JSON.stringify({
      mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp"] }, linear: { url: "https://linear.example/mcp" } },
    });
    const dry = await call("POST", "/api/servers/import", bob, { text, dryRun: true });
    expect(dry.body.servers.map((s: any) => [s.slug, s.needsApproval])).toEqual([
      ["playwright", true],
      ["linear", false],
    ]);

    const res = await call("POST", "/api/servers/import", bob, { text });
    expect(res.status).toBe(201);
    expect(res.body.created.map((s: any) => s.slug)).toEqual(["linear"]);
    expect(res.body.requested).toEqual([{ name: "playwright", slug: "playwright", requestId: expect.any(Number) }]);
  });

  it("won't let a user without the flag turn a server into a local command or change one", async () => {
    const remote = await call("POST", "/api/servers", bob, { name: "R", type: "http", url: "https://r.example/mcp" });
    expect((await call("PATCH", `/api/servers/${remote.body.id}`, bob, { type: "stdio", command: "sh" })).status).toBe(403);
    expect((await call("PATCH", `/api/servers/${remote.body.id}`, bob, { name: "Renamed" })).status).toBe(200);
  });
});

describe("the escalated queue", () => {
  async function fileFromBob(): Promise<number> {
    return (await call("POST", "/api/servers", bob, LOCAL)).body.requestId;
  }

  it("shows the Admin who asked and the command, with env names but never values", async () => {
    const id = await fileFromBob();
    const queue = await call("GET", "/api/requests", admin);
    expect(queue.body).toEqual([
      expect.objectContaining({
        id,
        requestedByUsername: "bob",
        escalated: true,
        reason: "Added in the web UI by bob",
        server: expect.objectContaining({
          command: "npx",
          args: ["-y", "@playwright/mcp"],
          cwd: "/home/bob",
          envKeys: ["API_KEY"],
        }),
      }),
    ]);
    expect(JSON.stringify(queue.body)).not.toContain(SECRET);
  });

  it("the requester can't approve it themselves", async () => {
    const id = await fileFromBob();
    const res = await call("POST", `/api/requests/${id}/approve`, bob);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Waiting for the Admin/);
  });

  it("approving creates the server owned by the requester, with their values", async () => {
    const id = await fileFromBob();
    const res = await call("POST", `/api/requests/${id}/approve`, admin);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);

    expect((await call("GET", "/api/servers", admin)).body).toEqual([]);
    const bobs = userScope(db, bobId).servers.list();
    expect(bobs.map((s) => [s.slug, s.command, s.cwd])).toEqual([["playwright", "npx", "/home/bob"]]);
    expect(userScope(db, bobId).requests.get(id)?.status).toBe("approved");
  });

  it("approving switches it on for the requesting agent and notifies it", async () => {
    const agent = userScope(db, bobId).agents.create({ name: "Claude" });
    if (!("row" in agent)) throw new Error("agent");
    const deps: AgentServerDeps = { db, manager: { get: () => undefined } as unknown as UpstreamManager, version: "test" };
    const server = buildAgentServer(agent.row, deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const filed = (await client.callTool({
      name: META_TOOL_REQUEST_SERVER,
      arguments: { config: JSON.stringify({ mcpServers: { pw: { command: "npx", env: { API_KEY: SECRET } } } }), reason: "browser" },
    })) as { content: { text: string }[] };
    const [id] = JSON.parse(filed.content[0].text).requestIds;
    expect(userScope(db, bobId).requests.get(id)?.escalated).toBe(true);

    expect((await call("POST", `/api/requests/${id}/approve`, admin)).status).toBe(200);
    const created = userScope(db, bobId).servers.bySlug("pw")!;
    expect(userScope(db, bobId).matrix.forAgent(agent.row.id)).toEqual([{ serverId: created.id, enabled: true }]);
    expect(notifyAgent.mock.calls.map(([agentId]) => agentId)).toContain(agent.row.id);
  });

  it("the Admin can deny with a note", async () => {
    const id = await fileFromBob();
    expect((await call("POST", `/api/requests/${id}/deny`, admin, { note: "use the hosted one" })).status).toBe(200);
    expect(userScope(db, bobId).requests.get(id)).toMatchObject({ status: "denied", resolutionNote: "use the hosted one" });
  });

  it("the requester can cancel it, and then it's resolved for the Admin too", async () => {
    const id = await fileFromBob();
    expect((await call("POST", `/api/requests/${id}/cancel`, bob)).status).toBe(200);
    expect(userScope(db, bobId).requests.get(id)).toMatchObject({ status: "denied", resolutionNote: "Cancelled by bob" });
    expect((await call("POST", `/api/requests/${id}/approve`, admin)).status).toBe(409);
    expect((await call("POST", `/api/requests/${id}/cancel`, bob)).status).toBe(409);
  });

  it("a non-escalated request stays out of the Admin's queue", async () => {
    userScope(db, bobId).requests.file({ agentId: null, agentSlug: "x", kind: "freeform", reason: "Linear please" });
    expect((await call("GET", "/api/requests", admin)).body).toEqual([]);
  });
});
