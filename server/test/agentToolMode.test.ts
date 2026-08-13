import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agents } from "../src/db/schema.js";
import { encrypt, loadOrCreateKey } from "../src/lib/crypto.js";
import { agentRoutes } from "../src/http/routes/agents.js";
import type { AppContext } from "../src/http/context.js";

let db: Db;
let api: Hono;
let notifyAgent: ReturnType<typeof vi.fn>;
let tmp: string;

/** Hono's in-memory dispatch — the routes are mounted behind admin auth in app.ts. */
async function apiCall(method: string, url: string, body?: unknown) {
  const res = await api.request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

function agentId(slug: string): string {
  return String(db.select().from(agents).all().find((a) => a.slug === slug)!.id);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-toolmode-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  db.insert(agents).values({ slug: "claude", name: "Claude", tokenEnc: encrypt("t"), createdAt: Date.now() }).run();

  notifyAgent = vi.fn();
  const hub = { notifyAgent, sessionCount: () => 0, dropAgentSessions: async () => {} };
  api = agentRoutes({ db, hub } as unknown as AppContext);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("agent toolMode", () => {
  it("defaults to full for new agents", async () => {
    const created = await apiCall("POST", "/", { name: "Codex" });
    expect(created.status).toBe(201);
    expect(created.body.toolMode).toBe("full");

    const { status, body } = await apiCall("GET", "/");
    expect(status).toBe(200);
    expect(body.map((a: any) => a.toolMode)).toEqual(["full", "full"]);
  });

  it("round-trips to lean and back, notifying live sessions on each change", async () => {
    const id = agentId("claude");

    const lean = await apiCall("PATCH", `/${id}`, { toolMode: "lean" });
    expect(lean.status).toBe(200);
    expect(lean.body.toolMode).toBe("lean");
    expect(db.select().from(agents).all()[0].toolMode).toBe("lean");
    expect(notifyAgent).toHaveBeenCalledWith(Number(id), "tools");

    notifyAgent.mockClear();
    const back = await apiCall("PATCH", `/${id}`, { toolMode: "full" });
    expect(back.body.toolMode).toBe("full");
    expect(notifyAgent).toHaveBeenCalledWith(Number(id), "tools");
  });

  it("stays quiet when a patch leaves the mode alone", async () => {
    const id = agentId("claude");

    expect((await apiCall("PATCH", `/${id}`, { toolMode: "full" })).status).toBe(200);
    expect(notifyAgent).not.toHaveBeenCalled();

    expect((await apiCall("PATCH", `/${id}`, { name: "Renamed" })).status).toBe(200);
    expect(notifyAgent).not.toHaveBeenCalled();
  });

  it("notifies once when a patch flips both the role and the mode", async () => {
    const id = agentId("claude");
    const { status } = await apiCall("PATCH", `/${id}`, { role: "manager", toolMode: "lean" });
    expect(status).toBe(200);
    expect(notifyAgent).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown mode", async () => {
    const { status } = await apiCall("PATCH", `/${agentId("claude")}`, { toolMode: "turbo" });
    expect(status).toBe(400);
    expect(db.select().from(agents).all()[0].toolMode).toBe("full");
  });
});

describe("tool_mode migration", () => {
  it("adds the column to a database created before it existed", () => {
    closeDb();
    const old = fs.mkdtempSync(path.join(os.tmpdir(), "sb-toolmode-old-"));
    const sq = new Database(path.join(old, "switchboard.db"));
    sq.exec(`CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      token_enc TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'standard',
      created_at INTEGER NOT NULL
    );`);
    sq.prepare("INSERT INTO agents (slug, name, token_enc, created_at) VALUES (?, ?, ?, ?)").run(
      "legacy",
      "Legacy",
      encrypt("t"),
      Date.now(),
    );
    sq.close();

    const migrated = initDb(old);
    const row = migrated.select().from(agents).all()[0];
    expect(row.slug).toBe("legacy");
    expect(row.toolMode).toBe("full");

    closeDb();
    fs.rmSync(old, { recursive: true, force: true });
  });
});
