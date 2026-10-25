import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agentServers, servers, shares, type AgentRow, type ServerRow } from "../src/db/schema.js";
import { agentReach, type ConnectionLookup } from "../src/core/agentReach.js";
import { createUser, defaultUserId, disableUser } from "../src/core/users.js";
import { userScope, type UserScope } from "../src/core/userScope.js";
import type { UpstreamConnection } from "../src/core/upstreamConnection.js";
import { loadOrCreateKey } from "../src/lib/crypto.js";

let tmp: string;
let db: Db;
let alice: UserScope;
let bob: UserScope;
let aliceClaude: AgentRow;
let aliceGithub: ServerRow;
let bobGithub: ServerRow;
let bobNotes: ServerRow;
let shareId: number;

/** Every server is "connected"; the reach decides which of them an agent gets to. */
const everyoneConnected: ConnectionLookup = {
  get: (serverId) => ({ serverId, state: "connected" }) as unknown as UpstreamConnection,
};

function server(scope: UserScope, slug: string): ServerRow {
  const r = scope.servers.create({ name: slug, slug, type: "http", url: `https://${slug}.example/mcp` });
  if (!("row" in r)) throw new Error(r.error);
  return r.row;
}

function share(serverId: number, recipient: number, values: Partial<typeof shares.$inferInsert> = {}): number {
  return db
    .insert(shares)
    .values({ serverId, recipientUserId: recipient, alias: "bob-notes", status: "accepted", createdAt: Date.now(), ...values })
    .returning()
    .get().id;
}

const reach = () => agentReach(db, aliceClaude, everyoneConnected);
const names = () => reach().list().map((s) => s.name);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-reach-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  alice = userScope(db, defaultUserId(db));
  bob = userScope(db, createUser(db, { username: "bob" }));
  // Same slugs on both sides, so a leak would show up as a name that resolves to the wrong server.
  aliceGithub = server(alice, "github");
  bobGithub = server(bob, "github");
  bobNotes = server(bob, "notes");
  const created = alice.agents.create({ name: "Claude", slug: "claude" });
  if (!("row" in created)) throw new Error(created.error);
  aliceClaude = created.row;
  shareId = share(bobNotes.id, alice.user.id);
  alice.matrix.set(aliceClaude.id, aliceGithub.id, true);
  expect(alice.matrix.set(aliceClaude.id, bobNotes.id, true)).toBe(true);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("agent reach", () => {
  it("lists own servers by slug, then accepted shares by alias with their owner", () => {
    expect(reach().list()).toMatchObject([
      { name: "github", serverId: aliceGithub.id },
      { name: "bob-notes", serverId: bobNotes.id, sharedBy: "bob", shareId },
    ]);
    expect(reach().list()[0].sharedBy).toBeUndefined();
  });

  it("resolves a share by its alias to the owner's server, never by the owner's slug", () => {
    expect(reach().resolve("bob-notes")?.conn.serverId).toBe(bobNotes.id);
    expect(reach().resolve("notes")).toBeUndefined();
    expect(reach().resolve("github")?.conn.serverId).toBe(aliceGithub.id);
    expect(reach().connected().map((t) => [t.server.name, t.conn.serverId])).toEqual([
      ["github", aliceGithub.id],
      ["bob-notes", bobNotes.id],
    ]);
  });

  it("hides a share the recipient switched off without deleting the agent's matrix rows", () => {
    db.update(shares).set({ enabled: false }).where(eq(shares.id, shareId)).run();
    expect(names()).toEqual(["github"]);
    expect(reach().resolve("bob-notes")).toBeUndefined();
    expect(alice.matrix.forAgent(aliceClaude.id)).toContainEqual({ serverId: bobNotes.id, enabled: true });

    db.update(shares).set({ enabled: true }).where(eq(shares.id, shareId)).run();
    expect(names()).toEqual(["github", "bob-notes"]);
  });

  it("hides a share whose owner is disabled, or whose owner switched the server off", () => {
    db.update(servers).set({ enabled: false }).where(eq(servers.id, bobNotes.id)).run();
    expect(names()).toEqual(["github"]);
    db.update(servers).set({ enabled: true }).where(eq(servers.id, bobNotes.id)).run();

    disableUser(db, bob.user.id);
    expect(names()).toEqual(["github"]);
    expect(reach().resolve("bob-notes")).toBeUndefined();
  });

  it("keeps a switched-off own server on the roster but never resolves it", () => {
    db.update(servers).set({ enabled: false }).where(eq(servers.id, aliceGithub.id)).run();
    expect(reach().list()[0]).toMatchObject({ name: "github", enabled: false });
    expect(reach().resolve("github")).toBeUndefined();
    expect(reach().connected().map((t) => t.server.name)).toEqual(["bob-notes"]);
  });

  it("never reaches another user's server through a forged matrix row", () => {
    db.insert(agentServers).values({ agentId: aliceClaude.id, serverId: bobGithub.id, enabled: true }).run();
    expect(names()).toEqual(["github", "bob-notes"]);
    expect(reach().resolve("github")?.conn.serverId).toBe(aliceGithub.id);
    expect(reach().list().some((s) => s.serverId === bobGithub.id)).toBe(false);
  });

  it("ignores an offer that hasn't been accepted, even with a matrix row", () => {
    const offered = share(bobGithub.id, alice.user.id, { alias: null, status: "offered" });
    expect(alice.matrix.set(aliceClaude.id, bobGithub.id, true)).toBe(false);
    db.insert(agentServers).values({ agentId: aliceClaude.id, serverId: bobGithub.id, enabled: true }).run();
    expect(names()).toEqual(["github", "bob-notes"]);
    expect(offered).toBeGreaterThan(0);
  });

  it("reaches nothing for an agent that isn't the scope user's", () => {
    const stranger = { ...aliceClaude, userId: bob.user.id };
    expect(agentReach(db, stranger, everyoneConnected).list()).toEqual([]);
  });

  it("counts use on the share only, and only from the recipient's side", () => {
    const [own, shared] = reach().list();
    reach().recordUse(own);
    reach().recordUse(shared);
    reach().recordUse(shared);
    bob.shares.recordUse(shareId); // the owner can't move the recipient's counter
    const row = db.select().from(shares).where(eq(shares.id, shareId)).get()!;
    expect(row.callCount).toBe(2);
    expect(row.lastUsedAt).not.toBeNull();
  });
});

describe("matrix with shares", () => {
  it("offers accepted shares as switches, including ones that are currently unavailable", () => {
    expect(alice.matrix.forAgent(aliceClaude.id).map((m) => m.serverId)).toEqual([aliceGithub.id, bobNotes.id]);
    disableUser(db, bob.user.id);
    expect(alice.matrix.switchable().map((s) => [s.name, s.available])).toEqual([
      ["github", true],
      ["bob-notes", false],
    ]);
  });

  it("never lets the owner switch the share on for the recipient's agents", () => {
    expect(bob.matrix.set(aliceClaude.id, bobNotes.id, false)).toBe(false);
    expect(alice.matrix.forAgent(aliceClaude.id)).toContainEqual({ serverId: bobNotes.id, enabled: true });
  });
});
