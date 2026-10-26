import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agentServers, requestLogs, type UserRow } from "../src/db/schema.js";
import { createUser, defaultUserId, getUser } from "../src/core/users.js";
import { userScope, type UserScope } from "../src/core/userScope.js";
import { decrypt, loadOrCreateKey } from "../src/lib/crypto.js";

let tmp: string;
let db: Db;
let alice: UserScope;
let bob: UserScope;

/** Each user gets the same slugs, so any leak would show up as a name collision. */
function seed(scope: UserScope) {
  const server = scope.servers.create({ name: "GitHub", slug: "github", type: "http", url: "https://gh.example/mcp" });
  const agent = scope.agents.create({ name: "Claude", slug: "claude" });
  if (!("row" in server) || !("row" in agent)) throw new Error("seed failed");
  scope.matrix.set(agent.row.id, server.row.id, true);
  const request = scope.requests.file({ agentId: agent.row.id, agentSlug: "claude", kind: "freeform", reason: "linear" });
  const log = db
    .insert(requestLogs)
    .values({
      ts: Date.now(),
      agentId: agent.row.id,
      agentSlug: "claude",
      agentName: "Claude",
      userId: scope.user.id,
      method: "tools/list",
      status: "ok",
      durationMs: 5,
    })
    .returning()
    .get();
  return { server: server.row, agent: agent.row, requestId: request.id, logId: log.id };
}

let a: ReturnType<typeof seed>;
let b: ReturnType<typeof seed>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-scope-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  alice = userScope(db, defaultUserId(db));
  bob = userScope(db, createUser(db, { username: "bob" }));
  a = seed(alice);
  b = seed(bob);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("user scope: servers", () => {
  it("lists and reads only your own", () => {
    expect(alice.servers.list().map((s) => s.id)).toEqual([a.server.id]);
    expect(alice.servers.get(b.server.id)).toBeUndefined();
    expect(alice.servers.bySlug("github")?.id).toBe(a.server.id);
    expect(bob.servers.bySlug("github")?.id).toBe(b.server.id);
  });

  it("allows the same slug across users and rejects it within one", () => {
    expect(a.server.slug).toBe(b.server.slug);
    expect(alice.servers.create({ name: "GitHub 2", slug: "github", type: "http", url: "https://x/mcp" })).toEqual({
      error: 'Slug "github" is already in use',
      status: 409,
    });
    const other = alice.servers.create({ name: "Other", type: "http", url: "https://y/mcp" }) as { row: { id: number } };
    expect(alice.servers.update(other.row.id, { slug: "github" })).toMatchObject({ status: 409 });
    expect(alice.servers.create({ name: "x", slug: "switchboard", type: "http", url: "https://z/mcp" })).toMatchObject({
      status: 400,
    });
  });

  it("can't update or delete another user's server, which reads as not found", () => {
    expect(alice.servers.update(b.server.id, { name: "pwned" })).toEqual({ error: "Not found", status: 404 });
    expect(alice.servers.remove(b.server.id)).toBeUndefined();
    expect(bob.servers.get(b.server.id)?.name).toBe("GitHub");
  });

  it("keeps a stored secret given as null, replaces the rest, drops what's left out, and clears on null", () => {
    const created = alice.servers.create({
      name: "Studio",
      slug: "studio",
      type: "stdio",
      command: "npx",
      env: { EMAIL: "me@x", LICENSE_KEY: "old", STALE: "gone" },
    }) as { row: { id: number } };
    const envOf = (row: { envJsonEnc: string | null }) => (row.envJsonEnc ? JSON.parse(decrypt(row.envJsonEnc)) : null);

    const kept = alice.servers.update(created.row.id, { env: { EMAIL: null, LICENSE_KEY: "new", ADDED: "1" } });
    expect("row" in kept && envOf(kept.row)).toEqual({ EMAIL: "me@x", LICENSE_KEY: "new", ADDED: "1" });

    expect(alice.servers.update(created.row.id, { env: { NOPE: null } })).toEqual({
      error: 'Env var "NOPE" has no stored value to keep',
      status: 400,
    });
    expect(envOf(alice.servers.get(created.row.id)!)).toEqual({ EMAIL: "me@x", LICENSE_KEY: "new", ADDED: "1" });

    const cleared = alice.servers.update(created.row.id, { env: null });
    expect("row" in cleared && cleared.row.envJsonEnc).toBeNull();
  });

  it("reports the agents to notify before a delete removes their switches", () => {
    expect(alice.servers.remove(a.server.id)).toEqual({ affectedAgentIds: [a.agent.id] });
    expect(alice.servers.list()).toEqual([]);
    expect(bob.servers.list()).toHaveLength(1);
  });
});

describe("user scope: agents", () => {
  it("lists and reads only your own; the same slug is fine across users", () => {
    expect(alice.agents.list().map((x) => x.id)).toEqual([a.agent.id]);
    expect(alice.agents.get(b.agent.id)).toBeUndefined();
    expect(alice.agents.bySlug("claude")?.id).toBe(a.agent.id);
    expect(alice.agents.create({ name: "Claude" })).toMatchObject({ status: 409 });
  });

  it("can't update, rotate or delete another user's agent", () => {
    expect(alice.agents.update(b.agent.id, { name: "pwned" })).toMatchObject({ status: 404 });
    expect(alice.agents.rotateToken(b.agent.id)).toBeUndefined();
    expect(alice.agents.remove(b.agent.id)).toBe(false);
    expect(bob.agents.get(b.agent.id)?.tokenEnc).toBe(b.agent.tokenEnc);
  });
});

describe("user scope: matrix", () => {
  it("only offers your own servers to your own agents", () => {
    expect(alice.matrix.forAgent(a.agent.id)).toEqual([{ serverId: a.server.id, enabled: true }]);
    expect(alice.matrix.forAgent(b.agent.id)).toEqual([]);
  });

  it("can't link your agent to another user's server, or their agent to yours", () => {
    const before = db.select().from(agentServers).all();
    expect(alice.matrix.set(a.agent.id, b.server.id, true)).toBe(false);
    expect(alice.matrix.set(b.agent.id, a.server.id, true)).toBe(false);
    expect(alice.matrix.set(b.agent.id, b.server.id, false)).toBe(false);
    expect(db.select().from(agentServers).all()).toEqual(before);
  });
});

describe("user scope: requests", () => {
  it("lists, reads and resolves only your own", () => {
    expect(alice.requests.list().map((r) => r.id)).toEqual([a.requestId]);
    expect(alice.requests.get(b.requestId)).toBeUndefined();
    expect(alice.requests.resolve(b.requestId, { status: "denied" })).toBe(false);
    expect(bob.requests.get(b.requestId)?.status).toBe("pending");
  });

  it("the agent-slug fallback never crosses users", () => {
    // Same slug "claude" on both sides: each sees its own request only.
    expect(alice.requests.forAgent({ id: -1, slug: "claude" }).map((r) => r.id)).toEqual([a.requestId]);
    expect(bob.requests.forAgent({ id: -1, slug: "claude" }).map((r) => r.id)).toEqual([b.requestId]);
  });

  it("escalates a local command only when the owner can't run one", () => {
    const stdio = { name: "pw", slug: "pw", type: "stdio" as const, command: "npx", authType: "none" as const };
    expect(bob.requests.file({ agentId: null, agentSlug: "", kind: "add_server", payload: stdio })).toMatchObject({
      escalated: true,
    });
    expect(alice.requests.file({ agentId: null, agentSlug: "", kind: "add_server", payload: stdio })).toMatchObject({
      escalated: false,
    });
    const remote = { name: "r", slug: "r", type: "http" as const, url: "https://r/mcp", authType: "none" as const };
    expect(bob.requests.file({ agentId: null, agentSlug: "", kind: "add_server", payload: remote })).toMatchObject({
      escalated: false,
    });

    db.$client.prepare("UPDATE users SET can_run_local_commands = 1 WHERE id = ?").run(bob.user.id);
    const trusted = userScope(db, getUser(db, bob.user.id) as UserRow);
    expect(trusted.requests.file({ agentId: null, agentSlug: "", kind: "add_server", payload: stdio })).toMatchObject({
      escalated: false,
    });
  });
});

describe("user scope: logs", () => {
  it("lists, reads, counts and clears only your own rows", () => {
    expect(alice.logs.list({}, 100).map((r) => r.id)).toEqual([a.logId]);
    expect(alice.logs.get(b.logId)).toBeUndefined();
    expect(alice.logs.stats(0)).toMatchObject({ total: 1 });
    expect(alice.logs.clear()).toBe(1);
    expect(bob.logs.list({}, 100).map((r) => r.id)).toEqual([b.logId]);
  });
});

describe("user scope: settings", () => {
  it("reads defaults, and writes never touch another user", () => {
    expect(alice.settings.get("allowServerRequests")).toBe(true);
    bob.settings.set("allowServerRequests", false);
    expect(bob.settings.get("allowServerRequests")).toBe(false);
    expect(alice.settings.get("allowServerRequests")).toBe(true);
  });
});
