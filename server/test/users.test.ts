import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { adminSessions, agents, servers } from "../src/db/schema.js";
import {
  createUser,
  defaultUserId,
  deleteUser,
  disableUser,
  enableUser,
  getPasswordHash,
  getUserByEmail,
  getUserByUsername,
  renameUser,
  setPasswordHash,
  setUserEmail,
  setUserRole,
  UserError,
} from "../src/core/users.js";
import { loadOrCreateKey } from "../src/lib/crypto.js";

let tmp: string;
let db: Db;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-users-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function status(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof UserError) return err.status;
    throw err;
  }
  return undefined;
}

describe("users", () => {
  it("creates plain users with the slug rule for usernames", () => {
    const bob = createUser(db, { username: "bob-2" });
    expect(bob).toMatchObject({ role: "user", canRunLocalCommands: false, passwordHash: null, disabledAt: null });
    for (const bad of ["Bob", "bob_smith", "", "a".repeat(65), "bob smith"]) {
      expect(status(() => createUser(db, { username: bad })), bad).toBe(400);
    }
    expect(status(() => createUser(db, { username: "bob-2" }))).toBe(409);
    expect(status(() => createUser(db, { username: "admin" }))).toBe(409);
  });

  it("keeps emails unique ignoring case, and finds them ignoring case", () => {
    const bob = createUser(db, { username: "bob", email: "Bob@Example.com" });
    expect(getUserByEmail(db, "bob@example.COM")?.id).toBe(bob.id);
    expect(status(() => createUser(db, { username: "eve", email: "BOB@example.com" }))).toBe(409);
    const eve = createUser(db, { username: "eve" });
    expect(status(() => setUserEmail(db, eve.id, " bob@EXAMPLE.com "))).toBe(409);
    // Re-saving your own address in another case is not a clash.
    expect(setUserEmail(db, bob.id, "bob@example.com").email).toBe("bob@example.com");
    expect(status(() => setUserEmail(db, eve.id, "not-an-email"))).toBe(400);
    // Any number of users may have no email.
    expect(setUserEmail(db, eve.id, "").email).toBeNull();
    expect(createUser(db, { username: "mallory", email: null }).email).toBeNull();
  });

  it("never disables, deletes or demotes the Default user", () => {
    const id = defaultUserId(db);
    expect(status(() => disableUser(db, id))).toBe(400);
    expect(status(() => deleteUser(db, id))).toBe(400);
    expect(status(() => setUserRole(db, id, "user"))).toBe(400);
  });

  it("finds the Default user by identity after a rename", () => {
    const id = defaultUserId(db);
    renameUser(db, id, "carl");
    expect(defaultUserId(db)).toBe(id);
    expect(getUserByUsername(db, "carl")?.id).toBe(id);
    expect(getUserByUsername(db, "admin")).toBeUndefined();
  });

  it("disabling signs the user out; enabling clears the flag", () => {
    const bob = createUser(db, { username: "bob" });
    db.insert(adminSessions).values({ id: "s1", userId: bob.id, createdAt: Date.now() }).run();
    expect(disableUser(db, bob.id).disabledAt).not.toBeNull();
    expect(db.select().from(adminSessions).where(eq(adminSessions.userId, bob.id)).all()).toEqual([]);
    expect(enableUser(db, bob.id).disabledAt).toBeNull();
  });

  it("deleting a user takes their servers and agents with them", () => {
    const bob = createUser(db, { username: "bob" });
    db.insert(servers)
      .values({ userId: bob.id, slug: "gh", name: "GH", type: "http", url: "https://g", createdAt: 1, updatedAt: 1 })
      .run();
    db.insert(agents).values({ userId: bob.id, slug: "claude", name: "Claude", tokenEnc: "x", createdAt: 1 }).run();
    deleteUser(db, bob.id);
    expect(db.select().from(servers).all()).toEqual([]);
    expect(db.select().from(agents).all()).toEqual([]);
    expect(status(() => deleteUser(db, bob.id))).toBe(404);
  });

  it("stores the password hash", () => {
    const bob = createUser(db, { username: "bob" });
    setPasswordHash(db, bob.id, "scrypt$abc");
    expect(getPasswordHash(db, bob.id)).toBe("scrypt$abc");
  });
});
