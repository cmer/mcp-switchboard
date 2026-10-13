import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A connection that records its lifecycle instead of spawning anything.
const events: string[] = [];
vi.mock("../src/core/upstreamConnection.js", () => ({
  UpstreamConnection: class {
    state = "connected";
    constructor(public row: { id: number }) {}
    start() {
      events.push(`start:${this.row.id}`);
    }
    async stop() {
      events.push(`stop:${this.row.id}`);
    }
    async restart() {}
    updateRow(row: { id: number }) {
      this.row = row;
    }
  },
}));

import { closeDb, initDb, type Db } from "../src/db/index.js";
import { servers } from "../src/db/schema.js";
import { UpstreamManager } from "../src/core/upstreamManager.js";
import { createUser, defaultUserId, disableUser, enableUser } from "../src/core/users.js";
import { loadOrCreateKey } from "../src/lib/crypto.js";

let tmp: string;
let db: Db;

function addServer(userId: number, slug: string, enabled = true) {
  return db
    .insert(servers)
    .values({ userId, slug, name: slug, type: "stdio", command: "x", enabled, createdAt: 1, updatedAt: 1 })
    .returning()
    .get();
}

beforeEach(() => {
  events.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-reconcile-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("UpstreamManager.reconcile and disabled owners", () => {
  it("runs a server only if it is enabled and its owner is not disabled", async () => {
    const bob = createUser(db, { username: "bob" });
    const mine = addServer(defaultUserId(db), "mine");
    const off = addServer(defaultUserId(db), "off", false);
    const bobs = addServer(bob.id, "bobs");
    const changed: number[] = [];
    const manager = new UpstreamManager(db, () => undefined as never);
    manager.onCachesChanged = (id) => changed.push(id);

    await manager.reconcile();
    expect(manager.get(mine.id)).toBeDefined();
    expect(manager.get(bobs.id)).toBeDefined();
    expect(manager.get(off.id)).toBeUndefined();

    // Disabling the owner stops their servers (and notifies) but leaves everyone else's alone.
    disableUser(db, bob.id);
    await manager.reconcile();
    expect(manager.get(bobs.id)).toBeUndefined();
    expect(manager.get(mine.id)).toBeDefined();
    expect(events).toContain(`stop:${bobs.id}`);
    expect(events).not.toContain(`stop:${mine.id}`);
    expect(changed).toContain(bobs.id);

    // A server created for a disabled owner never starts.
    const later = addServer(bob.id, "later");
    await manager.reconcile();
    expect(manager.get(later.id)).toBeUndefined();
    expect(events).not.toContain(`start:${later.id}`);

    // Re-enabling brings them back, and a disabled owner's server can't be restarted back to life.
    enableUser(db, bob.id);
    await manager.reconcile();
    expect(manager.get(bobs.id)).toBeDefined();
    expect(manager.get(later.id)).toBeDefined();
    disableUser(db, bob.id);
    await manager.reconcile();
    expect(await manager.restart(bobs.id)).toBe(false);
    expect(manager.get(bobs.id)).toBeUndefined();
  });
});
