import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

// A connection that serves one tool and records calls instead of dialling anything.
const calls = vi.hoisted(() => [] as string[]);
vi.mock("../src/core/upstreamConnection.js", () => ({
  UpstreamConnection: class {
    state = "connected";
    lastError = "401 from https://owner-only.example/secret-path";
    stderrLog = { toArray: () => ["owner's private stderr line"] };
    toolsCache = [{ name: "read_note", inputSchema: { type: "object" } }];
    promptsCache = [];
    resourcesCache = [];
    serverId: number;
    constructor(public row: { id: number }) {
      this.serverId = row.id;
    }
    start() {}
    async stop() {}
    async restart() {}
    updateRow(row: { id: number }) {
      this.row = row;
    }
    async callTool(name: string) {
      calls.push(`${this.row.id}:${name}`);
      return { content: [{ type: "text", text: `ok ${name}` }] };
    }
  },
}));

import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agentServers, shares } from "../src/db/schema.js";
import { RequestLogger } from "../src/core/requestLogger.js";
import { SwitchboardHub } from "../src/core/switchboardHub.js";
import { UpstreamManager } from "../src/core/upstreamManager.js";
import type { AgentServerDeps } from "../src/core/agentServerFactory.js";
import { loadOrCreateKey } from "../src/lib/crypto.js";
import { AgentOAuthStore } from "../src/oauth/agentOAuth.js";
import { AdminSessionStore } from "../src/http/adminAuth.js";
import { createApp } from "../src/http/app.js";
import type { AppContext } from "../src/http/context.js";

const BASE = "https://sb.example.com";

let tmp: string;
let db: Db;
let app: Hono;
let hub: SwitchboardHub;
let manager: UpstreamManager;
let notify: ReturnType<typeof vi.spyOn>;
const clients: Client[] = [];

interface Person {
  name: string;
  id: number;
  cookie: string;
}
let admin: Person;
let bob: Person;
let eve: Person;

const fetchFn = ((url: string | URL, init?: RequestInit) => app.request(url.toString(), init)) as typeof fetch;

async function call(method: string, url: string, who: Person | string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: { "Content-Type": "application/json", Cookie: typeof who === "string" ? who : who.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: set?.match(/sb_session=[^;]+/)?.[0] };
}

async function newUser(name: string): Promise<Person> {
  const created = await call("POST", "/api/users", admin, { username: name });
  expect(created.status).toBe(201);
  const login = await call("POST", "/api/auth/setup-code", "", { username: name, code: created.body.setupCode.code, password: `${name}-pass` });
  return { name, id: created.body.user.id, cookie: login.cookie! };
}

async function newServer(who: Person, slug: string, extra: Record<string, unknown> = {}) {
  const res = await call("POST", "/api/servers", who, {
    name: `${slug} server`,
    slug,
    description: `About ${slug}`,
    type: "http",
    url: `https://${slug}.example/mcp`,
    authType: "bearer",
    bearerToken: "super-secret-token",
    headers: { "X-Secret": "header-secret" },
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

async function newAgent(who: Person, name = "Claude") {
  const res = await call("POST", "/api/agents", who, { name });
  expect(res.status).toBe(201);
  return { id: res.body.id as number, slug: res.body.slug as string, token: res.body.token as string };
}

/** Offer `serverId` to `to` and accept it as `alias`; returns the share id. */
async function shareWith(owner: Person, serverId: number, to: Person, alias: string): Promise<number> {
  expect((await call("POST", `/api/servers/${serverId}/shares`, owner, { username: to.name })).status).toBe(201);
  const offer = (await call("GET", "/api/shares", to)).body.offers.find((o: any) => o.ownerUsername === owner.name);
  const accepted = await call("POST", `/api/shares/${offer.id}/accept`, to, { alias });
  expect(accepted.status).toBe(200);
  return offer.id;
}

async function connect(who: Person, agent: { slug: string; token: string }, onListChanged?: () => void): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  if (onListChanged) client.setNotificationHandler(ToolListChangedNotificationSchema, onListChanged);
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${who.name}/${agent.slug}`), {
    fetch: fetchFn,
    requestInit: { headers: { Authorization: `Bearer ${agent.token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name).filter((n) => !n.startsWith("switchboard__"));
}

const matrixOf = async (who: Person, agentId: number) =>
  (await call("GET", "/api/agents", who)).body.find((a: any) => a.id === agentId).servers as { serverId: number; enabled: boolean }[];

const rowsFor = (agentId: number, serverId: number) =>
  db
    .select()
    .from(agentServers)
    .where(and(eq(agentServers.agentId, agentId), eq(agentServers.serverId, serverId)))
    .all();

beforeEach(async () => {
  calls.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-sharing-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);

  manager = new UpstreamManager(db, () => undefined as never);
  const deps: AgentServerDeps = {
    db,
    manager,
    version: "test",
    logger: new RequestLogger(db),
    reconcile: () => manager.reconcile(),
    probe: async () => "none",
  };
  hub = new SwitchboardHub(deps);
  deps.notifyAgent = (agentId, kind) => hub.notifyAgent(agentId, kind);
  manager.onCachesChanged = (serverId, kind) => hub.notifyChanged(serverId, kind);
  notify = vi.spyOn(hub, "notifyAgent");

  const ctx = {
    db,
    logger: deps.logger,
    hub,
    manager,
    refresher: { cancel: vi.fn(), schedule: vi.fn() },
    adminSessions: new AdminSessionStore(db),
    agentOAuth: new AgentOAuthStore(db),
    makeOAuthProvider: vi.fn(),
    version: "test",
  };
  app = createApp(ctx as unknown as AppContext, path.join(tmp, "no-web"));

  const setup = await call("POST", "/api/auth/setup", "", { password: "admin-pass" });
  admin = { name: "admin", id: (await call("GET", "/api/auth/me", setup.cookie!)).body.user.id, cookie: setup.cookie! };
  bob = await newUser("bob");
  eve = await newUser("eve");
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await hub.stopAll();
  await manager.stopAll();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("sharing: the whole lifecycle", () => {
  it("offer, accept, switch per agent, hide, rename, count, revoke", async () => {
    const notesId = await newServer(admin, "notes");
    const adminAgent = await newAgent(admin, "Owner agent");
    const bobAgent = await newAgent(bob);
    expect((await call("PUT", `/api/agents/${adminAgent.id}/servers/${notesId}`, admin, { enabled: true })).status).toBe(200);

    // Offer
    const offered = await call("POST", `/api/servers/${notesId}/shares`, admin, { username: "bob" });
    expect(offered.status).toBe(201);
    expect(offered.body).toMatchObject({ username: "bob", status: "offered", callCount: 0, lastUsedAt: null });
    const listed = (await call("GET", "/api/servers", admin)).body.find((s: any) => s.id === notesId);
    expect(listed.sharedWith).toMatchObject([{ username: "bob", status: "offered" }]);

    // The recipient sees the offer, with the default alias, and nothing about how it is reached.
    const received = await call("GET", "/api/shares", bob);
    expect(received.body.accepted).toEqual([]);
    expect(received.body.offers).toMatchObject([
      { ownerUsername: "admin", serverName: "notes server", description: "About notes", proposedAlias: "admin-notes" },
    ]);
    const shareId = received.body.offers[0].id as number;
    const text = JSON.stringify(received.body);
    for (const leak of ["notes.example", "super-secret-token", "header-secret", "bearer", "stderr", "secret-path", "command"]) {
      expect(text).not.toContain(leak);
    }

    // Accept: it starts off for every agent.
    const accepted = await call("POST", `/api/shares/${shareId}/accept`, bob, { alias: "carl-notes" });
    expect(accepted.body).toMatchObject({
      id: shareId,
      alias: "carl-notes",
      ownerUsername: "admin",
      enabled: true,
      status: "connected",
      toolCount: 1,
    });
    expect(Object.keys(accepted.body).sort()).toEqual(
      ["alias", "createdAt", "description", "enabled", "id", "ownerUsername", "serverId", "serverName", "status", "toolCount"].sort(),
    );
    expect(await matrixOf(bob, bobAgent.id)).toEqual([{ serverId: notesId, enabled: false }]);
    expect((await call("GET", "/api/servers", admin)).body.find((s: any) => s.id === notesId).sharedWith[0].status).toBe("accepted");

    // A live session sees tools appear when the recipient switches the share on for the agent.
    const listChanged = vi.fn();
    const session = await connect(bob, bobAgent, listChanged);
    expect(await toolNames(session)).toEqual([]);
    await call("PUT", `/api/agents/${bobAgent.id}/servers/${notesId}`, bob, { enabled: true });
    expect(await toolNames(session)).toEqual(["carl-notes__read_note"]);
    await vi.waitFor(() => expect(listChanged).toHaveBeenCalled());

    // The recipient's own switch hides it without touching the per-agent row, and back on restores it.
    notify.mockClear();
    expect((await call("PATCH", `/api/shares/${shareId}`, bob, { enabled: false })).body).toMatchObject({ enabled: false });
    expect(notify).toHaveBeenCalledWith(bobAgent.id);
    expect(await toolNames(session)).toEqual([]);
    expect(await matrixOf(bob, bobAgent.id)).toEqual([{ serverId: notesId, enabled: true }]);
    await call("PATCH", `/api/shares/${shareId}`, bob, { enabled: true });
    expect(await toolNames(session)).toEqual(["carl-notes__read_note"]);

    // Renaming the alias renames the tools and tells the agents that have it on.
    notify.mockClear();
    expect((await call("PATCH", `/api/shares/${shareId}`, bob, { alias: "notes-from-admin" })).body.alias).toBe("notes-from-admin");
    expect(notify).toHaveBeenCalledWith(bobAgent.id);
    expect(await toolNames(session)).toEqual(["notes-from-admin__read_note"]);

    // A call through the share counts for the owner.
    const result = (await session.callTool({ name: "notes-from-admin__read_note", arguments: {} })) as any;
    expect(result.content[0].text).toBe("ok read_note");
    expect(calls).toEqual([`${notesId}:read_note`]);
    const usage = (await call("GET", `/api/servers/${notesId}/shares`, admin)).body;
    expect(usage).toMatchObject([{ username: "bob", status: "accepted", callCount: 1 }]);
    expect(usage[0].lastUsedAt).toBeGreaterThan(0);
    expect((await call("GET", "/api/servers", admin)).body.find((s: any) => s.id === notesId).sharedWith[0].callCount).toBe(1);

    // Revoke: the recipient's rows go, their live session is told, the owner's own switches stay.
    notify.mockClear();
    listChanged.mockClear();
    expect((await call("DELETE", `/api/servers/${notesId}/shares/${shareId}`, admin)).status).toBe(200);
    expect(notify).toHaveBeenCalledWith(bobAgent.id);
    expect(rowsFor(bobAgent.id, notesId)).toEqual([]);
    expect(rowsFor(adminAgent.id, notesId)).toHaveLength(1);
    await vi.waitFor(() => expect(listChanged).toHaveBeenCalled());
    expect(await toolNames(session)).toEqual([]);
    expect((await call("GET", "/api/shares", bob)).body).toEqual({ offers: [], accepted: [] });
    expect((await call("GET", `/api/servers/${notesId}/shares`, admin)).body).toEqual([]);
    expect(db.select().from(shares).all()).toEqual([]);
  });

  it("removing an accepted share drops the recipient's rows and notifies; the owner is untouched", async () => {
    const notesId = await newServer(admin, "notes");
    const adminAgent = await newAgent(admin);
    const bobAgent = await newAgent(bob);
    await call("PUT", `/api/agents/${adminAgent.id}/servers/${notesId}`, admin, { enabled: true });
    const shareId = await shareWith(admin, notesId, bob, "carl-notes");
    await call("PUT", `/api/agents/${bobAgent.id}/servers/${notesId}`, bob, { enabled: true });

    notify.mockClear();
    expect((await call("DELETE", `/api/shares/${shareId}`, bob)).status).toBe(200);
    expect(notify).toHaveBeenCalledWith(bobAgent.id);
    expect(rowsFor(bobAgent.id, notesId)).toEqual([]);
    expect(rowsFor(adminAgent.id, notesId)).toHaveLength(1);
    expect((await call("GET", "/api/shares", bob)).body.accepted).toEqual([]);
    expect((await call("GET", `/api/servers/${notesId}`, admin)).body.sharedWith).toEqual([]);
    // The recipient can't switch the server any more: it is no longer theirs to link.
    expect((await call("PUT", `/api/agents/${bobAgent.id}/servers/${notesId}`, bob, { enabled: true })).status).toBe(404);
  });

  it("starts a share on for all the recipient's agents when autoEnableNewServers is on", async () => {
    const notesId = await newServer(admin, "notes");
    const one = await newAgent(bob, "One");
    const two = await newAgent(bob, "Two");
    expect((await call("POST", "/api/auth/settings", bob, { autoEnableNewServers: true })).status).toBeLessThan(300);
    notify.mockClear();
    await shareWith(admin, notesId, bob, "carl-notes");
    expect(await matrixOf(bob, one.id)).toEqual([{ serverId: notesId, enabled: true }]);
    expect(await matrixOf(bob, two.id)).toEqual([{ serverId: notesId, enabled: true }]);
    expect(notify.mock.calls.map(([id]) => id).sort()).toEqual([one.id, two.id].sort());
  });

  it("declines an offer by deleting it, but not an accepted share", async () => {
    const notesId = await newServer(admin, "notes");
    const wikiId = await newServer(admin, "wiki");
    await call("POST", `/api/servers/${notesId}/shares`, admin, { username: "bob" });
    const offerId = (await call("GET", "/api/shares", bob)).body.offers[0].id;
    expect((await call("POST", `/api/shares/${offerId}/decline`, bob)).status).toBe(200);
    expect((await call("GET", "/api/shares", bob)).body).toEqual({ offers: [], accepted: [] });
    expect((await call("GET", `/api/servers/${notesId}/shares`, admin)).body).toEqual([]);
    expect((await call("POST", `/api/shares/${offerId}/decline`, bob)).status).toBe(404);
    // It can be offered again once declined.
    expect((await call("POST", `/api/servers/${notesId}/shares`, admin, { username: "bob" })).status).toBe(201);

    const acceptedId = await shareWith(admin, wikiId, bob, "carl-wiki");
    expect((await call("POST", `/api/shares/${acceptedId}/decline`, bob)).status).toBe(404);
    expect((await call("GET", "/api/shares", bob)).body.accepted).toHaveLength(1);
  });
});

describe("sharing: offers", () => {
  it("refuses sharing with yourself, an unknown or disabled user, or twice", async () => {
    const notesId = await newServer(admin, "notes");
    const offer = (username: string) => call("POST", `/api/servers/${notesId}/shares`, admin, { username });
    expect((await offer("admin")).status).toBe(400);
    expect((await offer("nobody")).status).toBe(404);
    expect((await call("POST", `/api/users/${eve.id}/disable`, admin)).status).toBe(200);
    expect((await offer("eve")).status).toBe(400);
    expect((await offer("bob")).status).toBe(201);
    expect((await offer("bob")).status).toBe(409);
    expect((await call("POST", `/api/servers/${notesId}/shares`, admin, {})).status).toBe(400);
  });

  it("keeps other users away from a server's shares: list, offer and revoke are all 404", async () => {
    const notesId = await newServer(admin, "notes");
    const shareId = await shareWith(admin, notesId, bob, "carl-notes");
    for (const who of [eve, bob]) {
      expect((await call("GET", `/api/servers/${notesId}/shares`, who)).status).toBe(404);
      expect((await call("POST", `/api/servers/${notesId}/shares`, who, { username: "eve" })).status).toBe(404);
      expect((await call("DELETE", `/api/servers/${notesId}/shares/${shareId}`, who)).status).toBe(404);
    }
    // And a share is only the recipient's to act on.
    expect((await call("PATCH", `/api/shares/${shareId}`, eve, { enabled: false })).status).toBe(404);
    expect((await call("PATCH", `/api/shares/${shareId}`, admin, { enabled: false })).status).toBe(404);
    expect((await call("DELETE", `/api/shares/${shareId}`, eve)).status).toBe(404);
    expect((await call("POST", `/api/shares/${shareId}/accept`, eve, { alias: "x" })).status).toBe(404);
    expect((await call("GET", "/api/shares", eve)).body).toEqual({ offers: [], accepted: [] });
    expect(db.select().from(shares).all()).toHaveLength(1);
  });

  it("revoking an offer that was never accepted removes it without any notifications", async () => {
    const notesId = await newServer(admin, "notes");
    await newAgent(bob);
    await call("POST", `/api/servers/${notesId}/shares`, admin, { username: "bob" });
    const shareId = (await call("GET", `/api/servers/${notesId}/shares`, admin)).body[0].id;
    notify.mockClear();
    expect((await call("DELETE", `/api/servers/${notesId}/shares/${shareId}`, admin)).status).toBe(200);
    expect(notify).not.toHaveBeenCalled();
    expect((await call("GET", "/api/shares", bob)).body.offers).toEqual([]);
  });
});

describe("sharing: aliases and the slug namespace", () => {
  it("rejects aliases that clash with an own slug, another alias, switchboard or the slug rule", async () => {
    const notesId = await newServer(admin, "notes");
    const wikiId = await newServer(admin, "wiki");
    await newServer(bob, "mine");
    await call("POST", `/api/servers/${notesId}/shares`, admin, { username: "bob" });
    await call("POST", `/api/servers/${wikiId}/shares`, admin, { username: "bob" });
    const [first, second] = (await call("GET", "/api/shares", bob)).body.offers.map((o: any) => o.id);
    const accept = (id: number, alias: string) => call("POST", `/api/shares/${id}/accept`, bob, { alias });

    expect((await accept(first, "mine")).status).toBe(409);
    expect((await accept(first, "switchboard")).status).toBe(400);
    expect((await accept(first, "Bad_Alias")).status).toBe(400);
    expect((await accept(first, "x".repeat(65))).status).toBe(400);
    expect((await accept(first, "carl-notes")).status).toBe(200);
    expect((await accept(second, "carl-notes")).status).toBe(409);
    expect((await accept(first, "carl-notes")).status).toBe(409); // already accepted
    expect((await accept(second, "carl-wiki")).status).toBe(200);

    // Renaming obeys the same rules, but keeping your own alias is fine.
    const rename = (id: number, alias: string) => call("PATCH", `/api/shares/${id}`, bob, { alias });
    expect((await rename(second, "carl-notes")).status).toBe(409);
    expect((await rename(second, "mine")).status).toBe(409);
    expect((await rename(second, "switchboard")).status).toBe(400);
    expect((await rename(second, "carl-wiki")).status).toBe(200);
    expect((await call("PATCH", `/api/shares/${second}`, bob, {})).status).toBe(400);
  });

  it("defaults the alias to <owner>-<slug> and truncates it to the slug rule", async () => {
    const long = "s".repeat(64);
    const longId = await newServer(admin, long);
    const notesId = await newServer(admin, "notes");
    await call("POST", `/api/servers/${longId}/shares`, admin, { username: "bob" });
    await call("POST", `/api/servers/${notesId}/shares`, admin, { username: "bob" });
    const offers = (await call("GET", "/api/shares", bob)).body.offers;
    expect(offers.map((o: any) => o.proposedAlias)).toEqual([`admin-${"s".repeat(58)}`, "admin-notes"]);

    // Accepting without an alias takes the proposal.
    const accepted = await call("POST", `/api/shares/${offers[1].id}/accept`, bob, {});
    expect(accepted.body.alias).toBe("admin-notes");
  });

  it("rejects creating or renaming an own server to a slug equal to an accepted alias", async () => {
    const notesId = await newServer(admin, "notes");
    await shareWith(admin, notesId, bob, "carl-notes");
    const mineId = await newServer(bob, "mine");

    const created = await call("POST", "/api/servers", bob, { name: "Clash", slug: "carl-notes", type: "http", url: "https://c.example/mcp" });
    expect(created.status).toBe(409);
    expect(created.body.error).toContain("carl-notes");
    expect((await call("PATCH", `/api/servers/${mineId}`, bob, { slug: "carl-notes" })).status).toBe(409);
    expect((await call("PATCH", `/api/servers/${mineId}`, bob, { slug: "mine", name: "Renamed" })).status).toBe(200);

    // A pending offer holds no name yet; after it goes away the slug is free again.
    const wikiId = await newServer(admin, "wiki");
    await call("POST", `/api/servers/${wikiId}/shares`, admin, { username: "bob" });
    expect((await call("POST", "/api/servers", bob, { name: "W", slug: "admin-wiki", type: "http", url: "https://w.example/mcp" })).status).toBe(201);
    const dry = await call("POST", "/api/servers/import", bob, {
      text: JSON.stringify({ mcpServers: { "carl-notes": { url: "https://x/mcp" } } }),
      dryRun: true,
    });
    expect(dry.body.servers[0].slugTaken).toBe(true);
  });

  it("lets the recipient and the owner pick the same name without a clash", async () => {
    const notesId = await newServer(admin, "notes");
    await newServer(bob, "notes");
    await shareWith(admin, notesId, bob, "admin-notes");
    expect((await call("GET", "/api/shares", bob)).body.accepted[0].alias).toBe("admin-notes");
  });
});

describe("sharing: what the recipient sees", () => {
  it("never exposes config, credentials, stderr or errors of the owner's server", async () => {
    const notesId = await newServer(admin, "notes");
    const bobAgent = await newAgent(bob);
    await shareWith(admin, notesId, bob, "carl-notes");
    const body = (await call("GET", "/api/shares", bob)).body;
    expect(Object.keys(body.accepted[0]).sort()).toEqual(
      ["alias", "createdAt", "description", "enabled", "id", "ownerUsername", "serverId", "serverName", "status", "toolCount"].sort(),
    );
    expect(JSON.stringify(body)).not.toMatch(/notes\.example|super-secret|header-secret|secret-path|private stderr/);

    // The owner's server routes stay the owner's.
    for (const p of ["", "/logs", "/tools"]) expect((await call("GET", `/api/servers/${notesId}${p}`, bob)).status).toBe(404);
    expect((await call("PATCH", `/api/servers/${notesId}`, bob, { name: "mine now" })).status).toBe(404);
    expect((await call("DELETE", `/api/servers/${notesId}`, bob)).status).toBe(404);
    expect((await call("POST", `/api/servers/${notesId}/restart`, bob)).status).toBe(404);
    expect((await call("POST", `/api/servers/${notesId}/oauth/start`, bob)).status).toBe(404);
    expect((await call("GET", "/api/servers", bob)).body).toEqual([]);
    expect(bobAgent.id).toBeGreaterThan(0);
  });

  it("maps the owner's connection to connected / waiting_for_owner / unavailable", async () => {
    const notesId = await newServer(admin, "notes");
    const bobAgent = await newAgent(bob);
    await shareWith(admin, notesId, bob, "carl-notes");
    await call("PUT", `/api/agents/${bobAgent.id}/servers/${notesId}`, bob, { enabled: true });
    const status = async () => (await call("GET", "/api/shares", bob)).body.accepted[0].status;
    const conn = () => manager.get(notesId) as unknown as { state: string };

    expect(await status()).toBe("connected");
    conn().state = "needs_auth";
    expect(await status()).toBe("waiting_for_owner");
    for (const state of ["connecting", "backoff", "stopped"]) {
      conn().state = state;
      expect(await status()).toBe("unavailable");
    }
    conn().state = "connected";

    // The owner switches the server off: unavailable, and the recipient's agents hear about it.
    notify.mockClear();
    expect((await call("PATCH", `/api/servers/${notesId}`, admin, { enabled: false })).status).toBe(200);
    expect(notify).toHaveBeenCalledWith(bobAgent.id);
    const share = (await call("GET", "/api/shares", bob)).body.accepted[0];
    expect(share).toMatchObject({ status: "unavailable", toolCount: 0 });
    expect((await call("PATCH", `/api/servers/${notesId}`, admin, { enabled: true })).status).toBe(200);
    expect(await status()).toBe("connected");
  });

  it("is unavailable, and the recipient's agents hear about it, when the owner is disabled", async () => {
    const wikiId = await newServer(eve, "wiki");
    const bobAgent = await newAgent(bob);
    await shareWith(eve, wikiId, bob, "eve-wiki");
    await call("PUT", `/api/agents/${bobAgent.id}/servers/${wikiId}`, bob, { enabled: true });
    const session = await connect(bob, bobAgent);
    expect(await toolNames(session)).toEqual(["eve-wiki__read_note"]);

    notify.mockClear();
    expect((await call("POST", `/api/users/${eve.id}/disable`, admin)).status).toBe(200);
    expect(notify).toHaveBeenCalledWith(bobAgent.id, "tools");
    expect((await call("GET", "/api/shares", bob)).body.accepted[0]).toMatchObject({ status: "unavailable", toolCount: 0 });
    expect(await toolNames(session)).toEqual([]);

    await call("POST", `/api/users/${eve.id}/enable`, admin);
    expect((await call("GET", "/api/shares", bob)).body.accepted[0].status).toBe("connected");
    expect(await toolNames(session)).toEqual(["eve-wiki__read_note"]);
  });

  it("notifies the recipient's agents when the owner deletes the server, and the share goes with it", async () => {
    const notesId = await newServer(admin, "notes");
    const bobAgent = await newAgent(bob);
    await shareWith(admin, notesId, bob, "carl-notes");
    await call("PUT", `/api/agents/${bobAgent.id}/servers/${notesId}`, bob, { enabled: true });
    const session = await connect(bob, bobAgent);
    expect(await toolNames(session)).toEqual(["carl-notes__read_note"]);

    notify.mockClear();
    expect((await call("DELETE", `/api/servers/${notesId}`, admin)).status).toBe(200);
    expect(notify).toHaveBeenCalledWith(bobAgent.id);
    expect((await call("GET", "/api/shares", bob)).body).toEqual({ offers: [], accepted: [] });
    expect(await toolNames(session)).toEqual([]);
    expect(db.select().from(shares).all()).toEqual([]);
  });
});

describe("user directory", () => {
  it("lists the other active users' names, and nothing else, to any signed-in user", async () => {
    await call("POST", `/api/users/${eve.id}/disable`, admin);
    const frank = await newUser("frank");
    const asBob = await call("GET", "/api/directory/users", bob);
    expect(asBob.status).toBe(200);
    expect(asBob.body).toEqual([{ username: "admin" }, { username: "frank" }]);
    expect((await call("GET", "/api/directory/users", frank)).body).toEqual([{ username: "admin" }, { username: "bob" }]);
    expect((await call("GET", "/api/directory/users", admin)).body).toEqual([{ username: "bob" }, { username: "frank" }]);
    expect((await call("GET", "/api/directory/users", "")).status).toBe(401);
  });
});

describe("agent OAuth discovery", () => {
  it("serves the same metadata shape for any well-formed path, resolvable or not", async () => {
    const agent = await newAgent(bob, "Secret Agent Name");
    await newAgent(eve);
    await call("POST", `/api/users/${eve.id}/disable`, admin);

    const meta = async (p: string) => {
      const res = await app.request(`${BASE}/.well-known/oauth-protected-resource/mcp/${p}`);
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const real = await meta(`bob/${agent.slug}`);
    const unknownUser = await meta(`nobody/${agent.slug}`);
    const unknownAgent = await meta("bob/nope");
    const disabledUser = await meta("eve/claude");
    const legacyReal = await meta(agent.slug);
    const legacyUnknown = await meta("nope");

    for (const r of [real, unknownUser, unknownAgent, disabledUser, legacyReal, legacyUnknown]) {
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["authorization_servers", "bearer_methods_supported", "resource", "resource_name"]);
      expect(r.body.authorization_servers).toEqual([BASE]);
      expect(r.body.resource_name).toBe(real.body.resource_name);
    }
    expect(JSON.stringify([real, legacyReal])).not.toContain("Secret Agent Name");
    // The resource echoes the form that was asked for.
    expect(real.body.resource).toBe(`${BASE}/mcp/bob/${agent.slug}`);
    expect(unknownUser.body.resource).toBe(`${BASE}/mcp/nobody/${agent.slug}`);
    expect(legacyUnknown.body.resource).toBe(`${BASE}/mcp/nope`);

    // Malformed paths (not a username/agent shape) are still plain 404s.
    expect((await meta("Bad_Name")).status).toBe(404);
    expect((await meta("a/b/c")).status).toBe(404);
  });
});
