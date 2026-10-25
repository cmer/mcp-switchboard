import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import type { AgentRow } from "../src/db/schema.js";
import { RequestLogger } from "../src/core/requestLogger.js";
import { userScope } from "../src/core/userScope.js";
import { loadOrCreateKey } from "../src/lib/crypto.js";
import { AgentOAuthStore } from "../src/oauth/agentOAuth.js";
import { AdminSessionStore } from "../src/http/adminAuth.js";
import { createApp } from "../src/http/app.js";
import type { AppContext } from "../src/http/context.js";

let tmp: string;
let db: Db;
let app: Hono;
let logger: RequestLogger;
let admin: string;
let bob: string;
let bobId: number;
let adminId: number;

async function call(method: string, url: string, cookie: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: set?.match(/sb_session=[^;]+/)?.[0] };
}

/** Pushes one request/response pair through the logger, as a live MCP session would. */
async function logCall(agent: AgentRow) {
  const transport = { sessionId: `s-${agent.id}`, start: async () => {}, close: async () => {}, send: async () => {} } as unknown as Transport;
  logger.attach(agent, transport);
  transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/list" } as JSONRPCMessage);
  await transport.send({ jsonrpc: "2.0", id: 1, result: { tools: [] } } as JSONRPCMessage);
}

/** Both users create the same-named server and agent through the API, so ids are all that differ. */
async function seed(cookie: string) {
  const server = await call("POST", "/api/servers", cookie, { name: "GitHub", type: "http", url: "https://gh.example/mcp" });
  const agent = await call("POST", "/api/agents", cookie, { name: "Claude" });
  expect([server.status, agent.status]).toEqual([201, 201]);
  return { serverId: server.body.id as number, agentId: agent.body.id as number };
}

let a: Awaited<ReturnType<typeof seed>>;
let b: Awaited<ReturnType<typeof seed>>;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-restiso-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  logger = new RequestLogger(db);
  const ctx = {
    db,
    logger,
    hub: { notifyAgent: vi.fn(), dropAgentSessions: vi.fn(async () => {}), sessionCount: () => 0 },
    refresher: { cancel: vi.fn(), schedule: vi.fn() },
    manager: { reconcile: vi.fn(async () => {}), get: () => undefined, restart: vi.fn(async () => true), statusSummary: () => ({}) },
    adminSessions: new AdminSessionStore(db),
    agentOAuth: new AgentOAuthStore(db),
    version: "test",
  };
  app = createApp(ctx as unknown as AppContext, path.join(tmp, "no-web"), { serveMcp: false });

  admin = (await call("POST", "/api/auth/setup", "", { password: "admin-pass" })).cookie!;
  adminId = (await call("GET", "/api/auth/me", admin)).body.user.id;
  const created = await call("POST", "/api/users", admin, { username: "bob" });
  bobId = created.body.user.id;
  bob = (await call("POST", "/api/auth/setup-code", "", { username: "bob", code: created.body.setupCode.code, password: "bob-pass" }))
    .cookie!;
  a = await seed(admin);
  b = await seed(bob);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("REST isolation: servers", () => {
  it("lists only the caller's servers; the same slug lives on both sides", async () => {
    const mine = await call("GET", "/api/servers", admin);
    const theirs = await call("GET", "/api/servers", bob);
    expect(mine.body.map((s: any) => s.id)).toEqual([a.serverId]);
    expect(theirs.body.map((s: any) => s.id)).toEqual([b.serverId]);
    expect(mine.body[0].slug).toBe(theirs.body[0].slug);
    expect((await call("POST", "/api/servers", bob, { name: "GitHub", type: "http", url: "https://x/mcp" })).status).toBe(409);
  });

  it("404s on every route for another user's server id", async () => {
    const id = b.serverId;
    expect((await call("GET", `/api/servers/${id}`, admin)).status).toBe(404);
    expect((await call("PATCH", `/api/servers/${id}`, admin, { name: "pwned" })).status).toBe(404);
    expect((await call("POST", `/api/servers/${id}/restart`, admin)).status).toBe(404);
    expect((await call("GET", `/api/servers/${id}/logs`, admin)).status).toBe(404);
    expect((await call("GET", `/api/servers/${id}/tools`, admin)).status).toBe(404);
    expect((await call("POST", `/api/servers/${id}/oauth/start`, admin)).status).toBe(404);
    expect((await call("DELETE", `/api/servers/${id}`, admin)).status).toBe(404);
    expect((await call("GET", `/api/servers/${id}`, bob)).body.name).toBe("GitHub");
  });

  it("marks import slugs taken only within the caller's own servers", async () => {
    const text = JSON.stringify({ mcpServers: { github: { url: "https://gh.example/mcp" }, linear: { url: "https://l/mcp" } } });
    const dry = await call("POST", "/api/servers/import", bob, { text, dryRun: true });
    expect(dry.body.servers.map((s: any) => [s.slug, s.slugTaken])).toEqual([
      ["github", true],
      ["linear", false],
    ]);
  });
});

describe("REST isolation: agents and the matrix", () => {
  it("lists only the caller's agents, with switches for their own servers only", async () => {
    const mine = await call("GET", "/api/agents", admin);
    expect(mine.body.map((x: any) => x.id)).toEqual([a.agentId]);
    expect(mine.body[0].servers).toEqual([{ serverId: a.serverId, enabled: false }]);
  });

  it("404s on every route for another user's agent id", async () => {
    const id = b.agentId;
    expect((await call("PATCH", `/api/agents/${id}`, admin, { name: "pwned" })).status).toBe(404);
    expect((await call("POST", `/api/agents/${id}/token/rotate`, admin)).status).toBe(404);
    expect((await call("POST", `/api/agents/${id}/oauth-pairing-code`, admin)).status).toBe(404);
    expect((await call("DELETE", `/api/agents/${id}/oauth-grants/1`, admin)).status).toBe(404);
    expect((await call("PUT", `/api/agents/${id}/servers/${b.serverId}`, admin, { enabled: true })).status).toBe(404);
    expect((await call("DELETE", `/api/agents/${id}`, admin)).status).toBe(404);
    expect((await call("GET", "/api/agents", bob)).body).toHaveLength(1);
  });

  it("can't switch the caller's agent on for another user's server", async () => {
    const res = await call("PUT", `/api/agents/${a.agentId}/servers/${b.serverId}`, admin, { enabled: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Server not found");
    expect((await call("PUT", `/api/agents/${a.agentId}/servers/${a.serverId}`, admin, { enabled: true })).status).toBe(200);
  });
});

describe("REST isolation: logs", () => {
  const bobsAgent = () => userScope(db, bobId).agents.get(b.agentId)!;
  const adminsAgent = () => userScope(db, adminId).agents.get(a.agentId)!;

  beforeEach(async () => {
    await logCall(bobsAgent());
    await logCall(bobsAgent());
    await logCall(adminsAgent());
  });

  it("lists, counts and reads only the caller's rows", async () => {
    const mine = await call("GET", "/api/logs", admin);
    const theirs = await call("GET", "/api/logs", bob);
    expect(mine.body.rows.map((r: any) => r.agentId)).toEqual([a.agentId]);
    expect(theirs.body.rows.map((r: any) => r.agentId)).toEqual([b.agentId, b.agentId]);
    expect((await call("GET", "/api/logs/stats", admin)).body.total).toBe(1);
    expect((await call("GET", `/api/logs/${theirs.body.rows[0].id}`, admin)).status).toBe(404);
    expect((await call("GET", `/api/logs/${theirs.body.rows[0].id}`, bob)).status).toBe(200);
  });

  it("clears only the caller's rows", async () => {
    expect((await call("DELETE", "/api/logs", admin)).body).toEqual({ deleted: 1 });
    expect((await call("GET", "/api/logs", bob)).body.rows).toHaveLength(2);
  });

  it("streams only the caller's events", async () => {
    const abort = new AbortController();
    const res = await app.request("/api/logs/stream", { headers: { Cookie: admin }, signal: abort.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Bob's call first: if it leaked, it would arrive before the Admin's own.
    await logCall(bobsAgent());
    await logCall(adminsAgent());

    let text = "";
    while ((text.match(/^data: /gm) ?? []).length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    abort.abort();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    expect(events.map((e) => [e.type, e.row.agentId])).toEqual([
      ["insert", a.agentId],
      ["update", a.agentId],
    ]);
  });
});

describe("REST isolation: requests and status", () => {
  it("lists and resolves only the caller's requests", async () => {
    const filed = userScope(db, bobId).requests.file({ agentId: b.agentId, agentSlug: "claude", kind: "freeform", reason: "Linear" });
    expect((await call("GET", "/api/requests", admin)).body).toEqual([]);
    expect((await call("POST", `/api/requests/${filed.id}/approve`, admin)).status).toBe(404);
    expect((await call("POST", `/api/requests/${filed.id}/deny`, admin)).status).toBe(404);
    expect((await call("POST", `/api/requests/${filed.id}/cancel`, admin)).status).toBe(404);
    expect((await call("GET", "/api/requests", bob)).body.map((r: any) => r.id)).toEqual([filed.id]);
  });

  it("reports live status for the caller's servers only", async () => {
    const all = { [a.serverId]: { state: "connected" }, [b.serverId]: { state: "connected" } };
    const ctx = {
      db,
      logger,
      hub: { notifyAgent: vi.fn(), sessionCount: () => 0 },
      manager: { statusSummary: () => all },
      adminSessions: new AdminSessionStore(db),
      version: "test",
    };
    const withStatus = createApp(ctx as unknown as AppContext, path.join(tmp, "no-web"), { serveMcp: false });
    const res = await withStatus.request("/api/status", { headers: { Cookie: bob } });
    expect(Object.keys(((await res.json()) as any).servers)).toEqual([String(b.serverId)]);
  });
});
