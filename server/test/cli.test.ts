import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { adminSessions, users } from "../src/db/schema.js";
import { runCli, resetPassword, setLoginMode, USAGE, type CliIo } from "../src/cli.js";
import { issueSetupCode } from "../src/core/setupCodes.js";
import { createUser, defaultUserId, getUserByUsername } from "../src/core/users.js";
import { hashPassword, loadOrCreateKey, verifyPassword } from "../src/lib/crypto.js";
import { readLoginMode, readSetting, writeSetting } from "../src/lib/settings.js";

let tmp: string;
let db: Db;
let out: string[];
let err: string[];
let closed: number;

function io(overrides: Partial<CliIo> = {}): CliIo {
  return {
    out: (m) => out.push(m),
    err: (m) => err.push(m),
    interactive: false,
    promptHidden: async () => {
      throw new Error("unexpected prompt");
    },
    readStdin: async () => "",
    openDb: () => db,
    closeDb: () => void closed++,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-cli-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  out = [];
  err = [];
  closed = 0;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedBob() {
  const bob = createUser(db, { username: "bob" });
  db.update(users).set({ passwordHash: hashPassword("old-pass") }).where(eq(users.id, bob.id)).run();
  issueSetupCode(db, bob.id);
  db.insert(adminSessions).values({ id: "s1", userId: bob.id, createdAt: Date.now() }).run();
  db.insert(adminSessions).values({ id: "s2", userId: defaultUserId(db), createdAt: Date.now() }).run();
  return bob;
}

describe("reset-password", () => {
  it("sets the password directly, voids a pending setup code and drops only that user's sessions", () => {
    const bob = seedBob();
    resetPassword(db, "bob", "fresh-pass");
    const row = getUserByUsername(db, "bob")!;
    expect(verifyPassword("fresh-pass", row.passwordHash!)).toBe(true);
    expect(verifyPassword("old-pass", row.passwordHash!)).toBe(false);
    expect(row).toMatchObject({ setupCodeHash: null, setupCodeExpiresAt: null });
    expect(db.select().from(adminSessions).where(eq(adminSessions.userId, bob.id)).all()).toEqual([]);
    expect(db.select().from(adminSessions).all().map((s) => s.id)).toEqual(["s2"]);
  });

  it("works for the Default user when it has no password yet", () => {
    resetPassword(db, "admin", "brand-new");
    expect(verifyPassword("brand-new", getUserByUsername(db, "admin")!.passwordHash!)).toBe(true);
  });

  it("rejects unknown users and short passwords", () => {
    expect(() => resetPassword(db, "ghost", "long-enough")).toThrow(/No user named "ghost"/);
    createUser(db, { username: "bob" });
    expect(() => resetPassword(db, "bob", "abc")).toThrow(/at least 4/);
  });

  it("reads the password from stdin without a terminal", async () => {
    seedBob();
    const code = await runCli(["reset-password", "bob", "--password-stdin"], io({ readStdin: async () => "piped-pass\n" }));
    expect(code).toBe(0);
    expect(verifyPassword("piped-pass", getUserByUsername(db, "bob")!.passwordHash!)).toBe(true);
    expect(out.join("\n")).toContain("bob");
    expect(closed).toBe(1);
  });

  it("prompts twice on a terminal and insists the two match", async () => {
    seedBob();
    const typed = ["first-pass", "other-pass"];
    const prompts: string[] = [];
    const terminal = io({
      interactive: true,
      promptHidden: async (q) => {
        prompts.push(q);
        return typed.shift()!;
      },
    });
    expect(await runCli(["reset-password", "bob"], terminal)).toBe(1);
    expect(err.join("\n")).toMatch(/don't match/);
    expect(prompts).toHaveLength(2);
    expect(verifyPassword("old-pass", getUserByUsername(db, "bob")!.passwordHash!)).toBe(true);

    typed.push("same-pass", "same-pass");
    expect(await runCli(["reset-password", "bob"], terminal)).toBe(0);
    expect(verifyPassword("same-pass", getUserByUsername(db, "bob")!.passwordHash!)).toBe(true);
  });

  it("refuses to prompt without a terminal, and checks the username before asking for a password", async () => {
    seedBob();
    expect(await runCli(["reset-password", "bob"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/--password-stdin/);

    err.length = 0;
    const terminal = io({ interactive: true });
    expect(await runCli(["reset-password", "ghost"], terminal)).toBe(1); // promptHidden would throw "unexpected prompt"
    expect(err.join("\n")).toMatch(/No user named "ghost"/);
    expect(closed).toBe(2);
  });

  it("needs exactly one username", async () => {
    expect(await runCli(["reset-password"], io())).toBe(1);
    expect(await runCli(["reset-password", "a", "b"], io())).toBe(1);
    expect(await runCli(["reset-password", "--bogus"], io())).toBe(1);
    expect(err.every((m) => m.includes("Usage:"))).toBe(true);
  });
});

describe("login-mode", () => {
  it("stores password mode", async () => {
    resetPassword(db, "admin", "admin-pass");
    writeSetting(db, "loginMode", "something-else");
    expect(await runCli(["login-mode", "password"], io())).toBe(0);
    expect(readSetting(db, "loginMode")).toBe("password");
    expect(readLoginMode(db)).toBe("password");
    expect(closed).toBe(1);
  });

  it("refuses password mode while the Default user has no password", async () => {
    writeSetting(db, "loginMode", "cloudflare");
    expect(await runCli(["login-mode", "password"], io())).toBe(1);
    expect(err.join("\n")).toMatch(/reset-password admin/);
    expect(readSetting(db, "loginMode")).toBe("cloudflare");
    expect(closed).toBe(1);
  });

  it("rejects other modes and missing arguments", async () => {
    expect(() => setLoginMode(db, "cloudflare")).toThrow(/Unknown login mode/);
    expect(await runCli(["login-mode", "cloudflare"], io())).toBe(1);
    expect(await runCli(["login-mode"], io())).toBe(1);
    expect(readSetting(db, "loginMode")).toBeNull();
  });
});

describe("dispatch", () => {
  it("prints usage for --help and exits 0", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      out.length = 0;
      expect(await runCli([flag], io())).toBe(0);
      expect(out).toEqual([USAGE]);
    }
  });

  it("prints usage and exits 1 for an unknown subcommand, without touching the database", async () => {
    let opened = false;
    const code = await runCli(["frobnicate"], io({ openDb: () => ((opened = true), db) }));
    expect(code).toBe(1);
    expect(err[0]).toContain('Unknown command "frobnicate"');
    expect(err[0]).toContain("Usage:");
    expect(opened).toBe(false);
  });
});
