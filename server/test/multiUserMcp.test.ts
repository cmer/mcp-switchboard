import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agentServers, agents, requestLogs, shares, type AgentRow, type ServerRow } from "../src/db/schema.js";
import { createUser, defaultUserId, disableUser, renameUser } from "../src/core/users.js";
import { userScope, type UserScope } from "../src/core/userScope.js";
import { RequestLogger } from "../src/core/requestLogger.js";
import { SwitchboardHub } from "../src/core/switchboardHub.js";
import {
  META_TOOL_ADD_SERVER,
  META_TOOL_ASSIGN_SERVER,
  META_TOOL_LIST_AGENTS,
  META_TOOL_LIST_SERVERS,
  META_TOOL_REQUEST_SERVER,
  META_TOOL_REQUEST_STATUS,
  META_TOOL_SERVER_STATUS,
  type AgentServerDeps,
} from "../src/core/agentServerFactory.js";
import type { UpstreamConnection } from "../src/core/upstreamConnection.js";
import type { UpstreamManager } from "../src/core/upstreamManager.js";
import { createMcpApp } from "../src/http/app.js";
import type { AppContext } from "../src/http/context.js";
import { AgentOAuthStore, sha256 } from "../src/oauth/agentOAuth.js";
import { encrypt, loadOrCreateKey } from "../src/lib/crypto.js";

/**
 * The agent-facing side end to end, through the Hono app and a real hub: two users with the same
 * agent slug and the same server slug, one share between them, and the legacy one-segment route.
 */

const BASE = "https://sb.example.com";

let tmp: string;
let db: Db;
let app: Hono;
let hub: SwitchboardHub;
let store: AgentOAuthStore;
let admin: UserScope;
let bob: UserScope;
let adminClaude: AgentRow;
let bobClaude: AgentRow;
let adminGithub: ServerRow;
let bobGithub: ServerRow;
let bobNotes: ServerRow;
let shareId: number;
/** serverId → tool calls that reached that server's connection. */
let calls: Map<number, string[]>;
const clients: Client[] = [];

const fetchFn = ((url: string | URL, init?: RequestInit) => app.request(url.toString(), init)) as typeof fetch;

function fakeConn(row: ServerRow, tools: string[]): UpstreamConnection {
  return {
    serverId: row.id,
    state: "connected",
    row,
    lastError: "401 from https://owner-only.example/secret-path",
    stderrLog: { toArray: () => ["owner's private stderr line"] },
    toolsCache: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
    promptsCache: [{ name: "summary" }],
    resourcesCache: [{ uri: "note://1", name: "note" }],
    callTool: async (name: string) => {
      calls.get(row.id)!.push(name);
      return { content: [{ type: "text", text: `server ${row.id}: ${name}` }] };
    },
    getPrompt: async () => ({ messages: [{ role: "user", content: { type: "text", text: `prompt from ${row.id}` } }] }),
    readResource: async (uri: string) => ({ contents: [{ uri, text: `resource from ${row.id}` }] }),
  } as unknown as UpstreamConnection;
}

function makeServer(scope: UserScope, slug: string, type: "http" | "stdio" = "http"): ServerRow {
  const r = scope.servers.create(
    type === "stdio" ? { name: slug, slug, type, command: "notes-mcp" } : { name: slug, slug, type, url: `https://${slug}.example/mcp` },
  );
  if (!("row" in r)) throw new Error(r.error);
  return r.row;
}

function makeAgent(userId: number, slug: string, token: string, role: AgentRow["role"] = "standard"): AgentRow {
  return db
    .insert(agents)
    .values({ userId, slug, name: slug, role, tokenEnc: encrypt(token), createdAt: Date.now() })
    .returning()
    .get();
}

async function connect(urlPath: string, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}${urlPath}`), {
    fetch: fetchFn,
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function initialize(urlPath: string, token?: string) {
  return app.request(`${BASE}${urlPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  });
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name).filter((n) => !n.startsWith("switchboard__"));
}

async function callText(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
  return result.content[0].text;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return JSON.parse(await callText(client, name, args));
}

/** An access token for `agentId`, as the consent flow would have issued it through `resource`. */
function oauthAccessToken(agentId: number, resource: string): string {
  const { client } = store.registerClient({ clientName: "Claude", redirectUris: ["https://claude.ai/cb"], authMethod: "none" });
  const verifier = crypto.randomBytes(32).toString("base64url");
  const code = store.createCode({
    clientId: client.clientId,
    agentId,
    redirectUri: "https://claude.ai/cb",
    codeChallenge: sha256(verifier),
    scope: null,
    resource,
  });
  const result = store.exchangeCode({ code, client, redirectUri: undefined, codeVerifier: verifier, resource: undefined });
  if (!result.ok) throw new Error(result.error);
  return result.value.access_token;
}

function shareRow() {
  return db.select().from(shares).where(eq(shares.id, shareId)).get()!;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-multiuser-mcp-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  admin = userScope(db, defaultUserId(db));
  bob = userScope(db, createUser(db, { username: "bob" }));

  adminGithub = makeServer(admin, "github");
  bobGithub = makeServer(bob, "github");
  bobNotes = makeServer(bob, "notes", "stdio");
  adminClaude = makeAgent(admin.user.id, "claude", "admin-claude-token", "manager");
  bobClaude = makeAgent(bob.user.id, "claude", "bob-claude-token", "manager");
  makeAgent(admin.user.id, "codex", "admin-codex-token");

  shareId = db
    .insert(shares)
    .values({ serverId: bobNotes.id, recipientUserId: admin.user.id, alias: "bob-notes", status: "accepted", createdAt: Date.now() })
    .returning()
    .get().id;
  admin.matrix.set(adminClaude.id, adminGithub.id, true);
  admin.matrix.set(adminClaude.id, bobNotes.id, true);
  bob.matrix.set(bobClaude.id, bobGithub.id, true);
  bob.matrix.set(bobClaude.id, bobNotes.id, true);

  calls = new Map([adminGithub, bobGithub, bobNotes].map((s) => [s.id, []]));
  const conns = [fakeConn(adminGithub, ["whoami"]), fakeConn(bobGithub, ["whoami"]), fakeConn(bobNotes, ["read_note"])];
  const manager = { get: (id: number) => conns.find((c) => c.serverId === id) } as unknown as UpstreamManager;

  const deps: AgentServerDeps = {
    db,
    manager,
    version: "test",
    logger: new RequestLogger(db),
    reconcile: async () => {},
    probe: async () => "none",
  };
  hub = new SwitchboardHub(deps);
  deps.notifyAgent = (agentId, kind) => hub.notifyAgent(agentId, kind);
  store = new AgentOAuthStore(db);
  app = createMcpApp({ db, hub, agentOAuth: store } as unknown as AppContext);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await hub.stopAll();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("per-user endpoints", () => {
  it("routes two users' same-named agents to their own same-named servers", async () => {
    const a = await connect("/mcp/admin/claude", "admin-claude-token");
    const b = await connect("/mcp/bob/claude", "bob-claude-token");

    expect(await toolNames(a)).toEqual(["github__whoami", "bob-notes__read_note"]);
    expect(await toolNames(b)).toEqual(["github__whoami", "notes__read_note"]);

    expect(await callText(a, "github__whoami")).toBe(`server ${adminGithub.id}: whoami`);
    expect(await callText(b, "github__whoami")).toBe(`server ${bobGithub.id}: whoami`);
    expect(calls.get(adminGithub.id)).toEqual(["whoami"]);
    expect(calls.get(bobGithub.id)).toEqual(["whoami"]);
  });

  it("refuses one user's token on another user's same-named agent", async () => {
    expect((await initialize("/mcp/bob/claude", "admin-claude-token")).status).toBe(401);
    expect((await initialize("/mcp/admin/claude", "bob-claude-token")).status).toBe(401);
  });

  it("serves the legacy one-segment route as the Default user's agent, with the static and an OAuth token", async () => {
    expect((await initialize("/mcp/claude", "admin-claude-token")).status).toBe(200);
    expect((await initialize("/mcp/claude", "bob-claude-token")).status).toBe(401);

    // Issued through the legacy URL, accepted on both forms (tokens are bound to the agent, not the URL).
    const token = oauthAccessToken(adminClaude.id, `${BASE}/mcp/claude`);
    expect((await initialize("/mcp/claude", token)).status).toBe(200);
    expect((await initialize("/mcp/admin/claude", token)).status).toBe(200);
    expect((await initialize("/mcp/bob/claude", token)).status).toBe(401);
  });

  it("keeps the legacy route after the Default user is renamed; the old two-segment URL stops working", async () => {
    renameUser(db, admin.user.id, "carl");
    expect((await initialize("/mcp/claude", "admin-claude-token")).status).toBe(200);
    expect((await initialize("/mcp/carl/claude", "admin-claude-token")).status).toBe(200);
    expect((await initialize("/mcp/admin/claude", "admin-claude-token")).status).toBe(401);
  });

  it("answers unknown user, unknown agent, wrong token and disabled user with the same 401", async () => {
    disableUser(db, bob.user.id);
    const cases = [
      ["/mcp/nobody/claude", "bob-claude-token"],
      ["/mcp/bob/nope", "bob-claude-token"],
      ["/mcp/bob/claude", "wrong-token"],
      ["/mcp/bob/claude", "bob-claude-token"], // right token, disabled owner
    ] as const;
    for (const [urlPath, token] of cases) {
      const res = await initialize(urlPath, token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
      expect(res.headers.get("WWW-Authenticate")).toBe(
        `Bearer error="invalid_token", resource_metadata="${BASE}/.well-known/oauth-protected-resource${urlPath}"`,
      );
    }
    // The legacy form points at the legacy metadata URL.
    expect((await initialize("/mcp/claude")).headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/claude"`,
    );
  });

  it("names the two-segment form in the MCP port's 404", async () => {
    const res = await app.request(`${BASE}/somewhere-else`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("/mcp/<username>/<agent-slug>");
  });
});

describe("protected-resource metadata", () => {
  it("serves both forms and echoes the one requested", async () => {
    const two = await app.request(`${BASE}/.well-known/oauth-protected-resource/mcp/bob/claude`);
    expect(await two.json()).toMatchObject({ resource: `${BASE}/mcp/bob/claude`, authorization_servers: [BASE] });
    const one = await app.request(`${BASE}/.well-known/oauth-protected-resource/mcp/claude`);
    expect(await one.json()).toMatchObject({ resource: `${BASE}/mcp/claude` });
  });

  it("answers an unknown user, an unknown agent and a disabled user's agent like a real one", async () => {
    disableUser(db, bob.user.id);
    const bodies: unknown[] = [];
    for (const p of ["nobody/claude", "admin/nope", "bob/claude", "admin/claude"]) {
      const res = await app.request(`${BASE}/.well-known/oauth-protected-resource/mcp/${p}`);
      expect(res.status).toBe(200);
      bodies.push({ ...((await res.json()) as object), resource: undefined });
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("matches the consent page's pairing code against the agent the resource names, by user", async () => {
    const { client } = store.registerClient({ clientName: "Claude", redirectUris: ["https://claude.ai/cb"], authMethod: "none" });
    const form = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: "https://claude.ai/cb",
      code_challenge: sha256("v".repeat(43)),
      code_challenge_method: "S256",
      resource: `${BASE}/mcp/bob/claude`,
      decision: "approve",
    });
    const submit = (code: string) =>
      app.request(`${BASE}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...Object.fromEntries(form), pairing_code: code }).toString(),
      });

    // The admin's own "claude" has the same slug, but the resource names bob's.
    const wrong = await submit(store.createPairingCode(adminClaude.id).code);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("different agent");
    expect((await submit(store.createPairingCode(bobClaude.id).code)).status).toBe(303);
  });
});

describe("shares over MCP", () => {
  it("lists the share's tools, prompts and resources under the alias and calls through the owner's connection", async () => {
    const a = await connect("/mcp/admin/claude", "admin-claude-token");
    expect(await callText(a, "bob-notes__read_note")).toBe(`server ${bobNotes.id}: read_note`);
    expect(calls.get(bobNotes.id)).toEqual(["read_note"]);
    expect(shareRow().callCount).toBe(1);
    expect(shareRow().lastUsedAt).not.toBeNull();

    expect((await a.listPrompts()).prompts.map((p) => p.name)).toContain("bob-notes__summary");
    await a.getPrompt({ name: "bob-notes__summary" });
    const uri = (await a.listResources()).resources.find((r) => r.uri.startsWith("sb://bob-notes/"))!.uri;
    const read = await a.readResource({ uri });
    expect(read.contents[0].uri).toBe(uri);
    expect(shareRow().callCount).toBe(3);

    // The owner's own calls don't count as share usage.
    const b = await connect("/mcp/bob/claude", "bob-claude-token");
    await callText(b, "notes__read_note");
    expect(shareRow().callCount).toBe(3);
  });

  it("refuses the owner's slug on the recipient's side, like any unknown server", async () => {
    const a = await connect("/mcp/admin/claude", "admin-claude-token");
    await expect(a.callTool({ name: "notes__read_note", arguments: {} })).rejects.toThrow(/Unknown server "notes"/);
  });

  it("logs the call for the caller, with the alias used and the server reached", async () => {
    const a = await connect("/mcp/admin/claude", "admin-claude-token");
    await callText(a, "bob-notes__read_note");
    const row = db
      .select()
      .from(requestLogs)
      .where(and(eq(requestLogs.method, "tools/call"), eq(requestLogs.target, "bob-notes__read_note")))
      .get()!;
    expect(row).toMatchObject({ userId: admin.user.id, serverId: bobNotes.id, serverSlug: "bob-notes", agentId: adminClaude.id });
    expect(bob.logs.list({}, 100).some((r) => r.target === "bob-notes__read_note")).toBe(false);
  });

  it("drops the share from the recipient's tools when they switch it off, and back when they switch it on", async () => {
    const a = await connect("/mcp/admin/claude", "admin-claude-token");
    db.update(shares).set({ enabled: false }).where(eq(shares.id, shareId)).run();
    expect(await toolNames(a)).toEqual(["github__whoami"]);
    db.update(shares).set({ enabled: true }).where(eq(shares.id, shareId)).run();
    expect(await toolNames(a)).toEqual(["github__whoami", "bob-notes__read_note"]);
  });

  it("names the owner in list_servers and the instructions roster", async () => {
    const a = await connect("/mcp/admin/claude", "admin-claude-token");
    const roster = await callJson(a, META_TOOL_LIST_SERVERS);
    expect(roster).toEqual([
      expect.objectContaining({ slug: "github", type: "http" }),
      expect.objectContaining({ slug: "bob-notes", toolPrefix: "bob-notes__", sharedBy: "bob", status: "connected" }),
    ]);
    expect(roster[1].type).toBeUndefined();
    expect(a.getInstructions()).toContain("- bob-notes__* — notes (shared by bob)");
  });

  it("reaches the recipient's sessions when the shared server changes", () => {
    const notify = vi.spyOn(hub, "notifyAgent");
    hub.notifyChanged(bobNotes.id, "tools");
    expect(notify.mock.calls.map((c) => c[0]).sort()).toEqual([adminClaude.id, bobClaude.id].sort());
  });
});

describe("manager tools across users", () => {
  it("server_status on a share gives status and counts, never stderr or errors", async () => {
    const a = await connect("/mcp/admin/claude", "admin-claude-token");
    const status = await callJson(a, META_TOOL_SERVER_STATUS, { server_slug: "bob-notes" });
    expect(status).toEqual({
      slug: "bob-notes",
      name: "notes",
      sharedBy: "bob",
      state: "connected",
      toolCount: 1,
      promptCount: 1,
      resourceCount: 1,
    });

    // The owner still gets the diagnostics for their own server.
    const b = await connect("/mcp/bob/claude", "bob-claude-token");
    const own = await callJson(b, META_TOOL_SERVER_STATUS, { server_slug: "notes" });
    expect(own.stderr).toEqual(["owner's private stderr line"]);
  });

  it("server_status and assign_server never reach another user's server by its slug", async () => {
    const a = await connect("/mcp/admin/claude", "admin-claude-token");
    await expect(a.callTool({ name: META_TOOL_SERVER_STATUS, arguments: { server_slug: "notes" } })).rejects.toThrow(
      /Unknown server/,
    );
    await expect(
      a.callTool({ name: META_TOOL_ASSIGN_SERVER, arguments: { server_slug: "notes", agent_slug: "codex", enabled: true } }),
    ).rejects.toThrow(/Unknown server/);
  });

  it("assign_server switches a share on by alias in the recipient's own matrix", async () => {
    const a = await connect("/mcp/admin/claude", "admin-claude-token");
    const codexId = admin.agents.bySlug("codex")!.id;
    expect(await callJson(a, META_TOOL_ASSIGN_SERVER, { server_slug: "bob-notes", agent_slug: "codex", enabled: true })).toEqual({
      serverSlug: "bob-notes",
      agentSlug: "codex",
      enabled: true,
    });
    expect(admin.matrix.forAgent(codexId)).toContainEqual({ serverId: bobNotes.id, enabled: true });
    // The owner's matrix is untouched.
    expect(bob.matrix.forAgent(bobClaude.id)).toContainEqual({ serverId: bobNotes.id, enabled: true });
    expect(db.select().from(agentServers).where(eq(agentServers.serverId, bobNotes.id)).all()).toHaveLength(3);
  });

  it("list_agents shows the owner's agents only, with share aliases", async () => {
    const a = await connect("/mcp/admin/claude", "admin-claude-token");
    expect(await callJson(a, META_TOOL_LIST_AGENTS)).toEqual([
      { slug: "claude", name: "claude", role: "manager", servers: ["github", "bob-notes"] },
      { slug: "codex", name: "codex", role: "standard", servers: [] },
    ]);
  });

  it("add_server enable_for reaches the owner's same-named agent, never another user's", async () => {
    const b = await connect("/mcp/bob/claude", "bob-claude-token");
    await callJson(b, META_TOOL_ADD_SERVER, {
      config: JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://linear.example/mcp" } } }),
      enable_for: ["claude", "codex"],
    }).then((out) => expect(out.warnings).toEqual(['Unknown agent slug "codex" — not enabled for it']));
    const linear = bob.servers.bySlug("linear")!;
    expect(bob.matrix.forAgent(bobClaude.id)).toContainEqual({ serverId: linear.id, enabled: true });
    expect(admin.servers.bySlug("linear")).toBeUndefined();
    expect(admin.matrix.forAgent(adminClaude.id).some((m) => m.serverId === linear.id)).toBe(false);
  });

  it("request_status shows only the calling user's requests, even for a same-named agent", async () => {
    const b = await connect("/mcp/bob/claude", "bob-claude-token");
    await callJson(b, META_TOOL_REQUEST_SERVER, { reason: "bob needs linear" });
    const a = await connect("/mcp/admin/claude", "admin-claude-token");
    expect(await callJson(a, META_TOOL_REQUEST_STATUS)).toEqual([]);
    expect(await callJson(b, META_TOOL_REQUEST_STATUS)).toEqual([expect.objectContaining({ reason: "bob needs linear" })]);
  });
});
