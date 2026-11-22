import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { oauthCredentials } from "../src/db/schema.js";
import { loadOrCreateKey } from "../src/lib/crypto.js";
import { DbOAuthProvider } from "../src/oauth/dbOAuthProvider.js";
import { OAuthDraftStore } from "../src/oauth/oauthDrafts.js";
import { AgentOAuthStore } from "../src/oauth/agentOAuth.js";
import { AdminSessionStore } from "../src/http/adminAuth.js";
import { createApp } from "../src/http/app.js";
import type { AppContext } from "../src/http/context.js";

/** An MCP server behind its own OAuth authorization server, accepting one access token. */
async function startOAuthUpstream(): Promise<{ http: Server; url: string }> {
  let base = "";
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const p = req.url ?? "";
    const json = (body: unknown) => void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    const readBody = () =>
      new Promise<string>((r) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => r(raw));
      });
    if (p.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (p.startsWith("/.well-known/oauth-authorization-server")) {
      return json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (p === "/register") return void readBody().then((raw) => json({ ...JSON.parse(raw), client_id: "client-1" }));
    if (p === "/token") {
      return void readBody().then(() => json({ access_token: "tok", token_type: "Bearer", expires_in: 3600, refresh_token: "r" }));
    }
    if (req.headers.authorization !== "Bearer tok") {
      res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }).end();
      return;
    }
    const mcp = new McpServer({ name: "guarded", version: "1.0.0" });
    mcp.registerTool("secret", { description: "s" }, async () => ({ content: [] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close());
    void mcp.connect(transport).then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { http, url: `${base}/mcp` };
}

let tmp: string;
let db: Db;
let app: Hono;
let cookie: string;
let upstream: { http: Server; url: string };
const refresher = { cancel: vi.fn(), schedule: vi.fn() };

async function call(method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: res.headers.get("content-type")?.includes("json") ? null : await res.text(), body: res.headers.get("content-type")?.includes("json") ? ((await res.json()) as any) : null };
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-oauthtest-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  upstream = await startOAuthUpstream();
  const ctx = {
    db,
    hub: { notifyAgent: vi.fn(), dropAgentSessions: vi.fn(async () => {}), sessionCount: () => 0 },
    refresher,
    manager: { reconcile: vi.fn(async () => {}), get: () => undefined, restart: vi.fn(async () => true), statusSummary: () => ({}) },
    adminSessions: new AdminSessionStore(db),
    agentOAuth: new AgentOAuthStore(db),
    makeOAuthProvider: (id: number) =>
      new DbOAuthProvider(id, { db, publicUrl: "http://localhost:8787", onTokensSaved: (sid) => refresher.schedule(sid) }),
    oauthDrafts: new OAuthDraftStore("http://localhost:8787"),
    version: "test",
  };
  app = createApp(ctx as unknown as AppContext, path.join(tmp, "no-web"), { serveMcp: false });
  const res = await app.request("/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "admin-pass" }),
  });
  cookie = res.headers.get("set-cookie")!.match(/sb_session=[^;]+/)![0];
});

afterEach(async () => {
  closeDb();
  await new Promise((r) => upstream.http.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("connection test: OAuth before saving", () => {
  it("authorizes into a draft, tests with it, and hands the tokens to the new server", async () => {
    const server = { name: "Guarded", type: "http", url: upstream.url, authType: "oauth" };

    const first = await call("POST", "/api/servers/test", { server });
    expect(first.status).toBe(200);
    expect(first.body.steps.find((s: any) => s.key === "authorize").status).toBe("waiting");
    const draftId = first.body.oauthDraftId as string;
    const state = new URL(first.body.authorizeUrl).searchParams.get("state");
    expect((await call("GET", `/api/servers/test/oauth/${draftId}`)).body.status).toBe("pending");

    // The provider redirects the popup back with a code.
    const cb = await call("GET", `/oauth/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(200);
    expect(cb.text).toMatch(/Authorized/);
    expect((await call("GET", `/api/servers/test/oauth/${draftId}`)).body.status).toBe("authorized");

    const second = await call("POST", "/api/servers/test", { server, oauthDraftId: draftId });
    expect(second.body.ok).toBe(true);
    expect(second.body.tools).toEqual(["secret"]);

    const created = await call("POST", "/api/servers", { ...server, oauthDraftId: draftId });
    expect(created.status).toBe(201);
    expect(created.body.oauthStatus).toBe("ok");
    const cred = db.select().from(oauthCredentials).where(eq(oauthCredentials.serverId, created.body.id)).get();
    expect(cred?.tokensEnc).toBeTruthy();
    expect(refresher.schedule).toHaveBeenCalledWith(created.body.id);
    // Claimed once: the draft is gone.
    expect((await call("GET", `/api/servers/test/oauth/${draftId}`)).status).toBe(404);
  });

  it("an unclaimed draft doesn't authorize a server at another URL", async () => {
    const first = await call("POST", "/api/servers/test", { server: { name: "G", type: "http", url: upstream.url, authType: "oauth" } });
    const state = new URL(first.body.authorizeUrl).searchParams.get("state");
    await call("GET", `/oauth/callback?code=abc&state=${state}`);
    const other = await call("POST", "/api/servers", {
      name: "Other",
      type: "http",
      url: upstream.url.replace("/mcp", "/other"),
      authType: "oauth",
      oauthDraftId: first.body.oauthDraftId,
    });
    expect(other.body.oauthStatus).toBe("needs_auth");
  });

  it("marks the draft failed when the user denies consent", async () => {
    const first = await call("POST", "/api/servers/test", { server: { name: "G", type: "http", url: upstream.url, authType: "oauth" } });
    const state = new URL(first.body.authorizeUrl).searchParams.get("state");
    const cb = await call("GET", `/oauth/callback?error=access_denied&state=${state}`);
    expect(cb.text).toMatch(/access_denied/);
    const status = await call("GET", `/api/servers/test/oauth/${first.body.oauthDraftId}`);
    expect(status.body).toEqual({ status: "failed", error: "access_denied" });
  });
});
