import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { missingEnvVar, testConnection, type TestDeps } from "../src/core/connectionTest.js";
import type { ServerRow } from "../src/db/schema.js";
import { encrypt, loadOrCreateKey } from "../src/lib/crypto.js";
import { OAuthDraftStore } from "../src/oauth/oauthDrafts.js";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-conntest-"));
  loadOrCreateKey(tmp);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function row(over: Partial<ServerRow>): ServerRow {
  return {
    id: 0,
    userId: 1,
    slug: "t",
    name: "t",
    description: null,
    type: "http",
    enabled: true,
    command: null,
    argsJson: null,
    envJsonEnc: null,
    cwd: null,
    unsandboxed: false,
    hostPathsJson: null,
    url: null,
    authType: "none",
    bearerTokenEnc: null,
    headersJsonEnc: null,
    createdByAgentSlug: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const deps: TestDeps = {
  wrapStdio: (_row, spawn) => ({ spawn, note: "running without a sandbox: test" }),
};

let http: Server | undefined;
afterEach(async () => {
  await new Promise((r) => (http ? http.close(r) : r(undefined)));
  http = undefined;
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  http = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
}

async function mcp(req: IncomingMessage, res: ServerResponse) {
  const server = new McpServer({ name: "fake", version: "9.9.9" });
  server.registerTool("ping", { description: "pong" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  server.registerTool("echo", { description: "echo" }, async () => ({ content: [] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => void transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

describe("testConnection: remote", () => {
  it("passes every step against a working server and lists its tools", async () => {
    const url = await serve((req, res) => {
      if (req.headers.authorization !== "Bearer good") return void res.writeHead(401).end();
      return mcp(req, res);
    });
    const report = await testConnection(row({ url, authType: "bearer", bearerTokenEnc: encrypt("good") }), deps);
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => [s.key, s.status])).toEqual([
      ["reach", "ok"],
      ["auth", "ok"],
      ["handshake", "ok"],
      ["list", "ok"],
    ]);
    expect(report.server?.name).toBe("fake");
    expect(report.counts?.tools).toBe(2);
    expect(report.tools).toEqual(["ping", "echo"]);
  });

  it("stops at auth and offers OAuth when a refused token meets resource metadata", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Bearer resource_metadata="http://x/.well-known/oauth-protected-resource"' }).end();
    });
    const report = await testConnection(row({ url, authType: "bearer", bearerTokenEnc: encrypt("nope") }), deps);
    expect(report.ok).toBe(false);
    expect(report.steps.find((s) => s.key === "auth")?.status).toBe("fail");
    expect(report.steps.find((s) => s.key === "handshake")?.status).toBe("skip");
    expect(report.fix).toEqual({ kind: "use_oauth" });
  });

  it("suggests a token when a no-auth server says 401 without OAuth metadata", async () => {
    const url = await serve((_req, res) => void res.writeHead(401).end());
    const report = await testConnection(row({ url }), deps);
    expect(report.fix).toEqual({ kind: "set_token" });
  });

  it("explains a 404 instead of attempting the handshake", async () => {
    const url = await serve((_req, res) => void res.writeHead(404).end());
    const report = await testConnection(row({ url }), deps);
    expect(report.headline).toMatch(/Nothing answers/);
    expect(report.hint).toMatch(/\/mcp/);
  });

  it("offers Streamable HTTP when a legacy SSE URL is gone", async () => {
    const url = await serve((_req, res) => void res.writeHead(410).end());
    const report = await testConnection(row({ url, type: "sse" }), deps);
    expect(report.fix).toEqual({ kind: "use_http" });
  });

  it("tells a legacy SSE endpoint from a web page when POST gets 405", async () => {
    let type = "text/event-stream";
    const url = await serve((req, res) => {
      if (req.method === "POST") return void res.writeHead(405).end();
      res.writeHead(200, { "Content-Type": type }).end();
    });
    expect((await testConnection(row({ url }), deps)).fix).toEqual({ kind: "use_sse" });
    type = "text/html; charset=utf-8";
    const page = await testConnection(row({ url }), deps);
    expect(page.headline).toMatch(/web page/);
    expect(page.fix).toBeUndefined();
  });

  it("fails the reach step when nothing listens", async () => {
    const url = await serve(() => {});
    await new Promise((r) => http!.close(r));
    http = undefined;
    const report = await testConnection(row({ url }), deps);
    expect(report.steps[0]).toMatchObject({ key: "reach", status: "fail" });
    expect(report.steps[0].detail).toMatch(/refused/i);
  });

  it("stops at the browser step for OAuth without tokens, with the consent URL", async () => {
    let base = "";
    const url = await serve((req, res) => {
      const p = req.url ?? "";
      const json = (body: unknown) => void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      if (p.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (p.startsWith("/.well-known/oauth-authorization-server"))
        return json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      if (p === "/register") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => json({ ...JSON.parse(raw), client_id: "abc" }));
        return;
      }
      res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }).end();
    });
    base = url.replace(/\/mcp$/, "");
    const drafts = new OAuthDraftStore("http://localhost:8787");
    const draft = drafts.open(1, url);
    const report = await testConnection(row({ url, authType: "oauth" }), {
      ...deps,
      oauthProvider: drafts.provider(draft),
      oauthSource: "draft",
    });
    expect(report.steps.map((s) => [s.key, s.status])).toEqual([
      ["reach", "ok"],
      ["oauth", "ok"],
      ["authorize", "waiting"],
      ["handshake", "skip"],
      ["list", "skip"],
    ]);
    expect(report.authorizeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
    expect(draft.clientInfo).toMatchObject({ client_id: "abc" });
    expect(draft.pendingState).toBeTruthy();
  });
});

describe("testConnection: stdio", () => {
  const sdkRoot = path.resolve(import.meta.dirname, "..");

  it("connects to a local server and lists its tools", async () => {
    const script = `
      const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
      const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
      const s = new McpServer({ name: "local", version: "1.0.0" });
      s.registerTool("hello", { description: "hi" }, async () => ({ content: [] }));
      s.connect(new StdioServerTransport());`;
    const report = await testConnection(
      row({ type: "stdio", command: process.execPath, argsJson: JSON.stringify(["-e", script]), cwd: sdkRoot }),
      deps,
    );
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.key)).toEqual(["start", "handshake", "list"]);
    expect(report.tools).toEqual(["hello"]);
  }, 20_000);

  it("shows stderr and offers the missing env var when the process dies", async () => {
    const script = `console.error("Error: GITHUB_PERSONAL_ACCESS_TOKEN environment variable is required"); process.exit(1);`;
    const report = await testConnection(
      row({ type: "stdio", command: process.execPath, argsJson: JSON.stringify(["-e", script]) }),
      deps,
    );
    expect(report.ok).toBe(false);
    expect(report.headline).toMatch(/exited/);
    expect(report.stderr?.join("\n")).toMatch(/GITHUB_PERSONAL_ACCESS_TOKEN/);
    expect(report.fix).toEqual({ kind: "add_env", name: "GITHUB_PERSONAL_ACCESS_TOKEN" });
  });

  it("fails the start step for a command that doesn't exist", async () => {
    const report = await testConnection(row({ type: "stdio", command: "definitely-not-a-command-xyz" }), deps);
    expect(report.steps[0]).toMatchObject({ key: "start", status: "fail" });
    expect(report.hint).toMatch(/wasn't found/);
  });

  it("reports a sandbox refusal as a start failure", async () => {
    const report = await testConnection(row({ type: "stdio", command: "node" }), {
      wrapStdio: () => {
        throw new Error("Local servers run in a sandbox, and it isn't available");
      },
    });
    expect(report.steps[0]).toMatchObject({ key: "start", status: "fail" });
    expect(report.steps[0].detail).toMatch(/sandbox/);
  });
});

describe("missingEnvVar", () => {
  it("ignores names the config already sets", () => {
    const r = row({ type: "stdio", envJsonEnc: encrypt(JSON.stringify({ API_KEY_X: "1" })) });
    expect(missingEnvVar(["API_KEY_X is required"], r)).toBeNull();
    expect(missingEnvVar(["Missing env OTHER_TOKEN"], r)).toBe("OTHER_TOKEN");
    expect(missingEnvVar(["Listening on PORT_NUMBER"], r)).toBeNull();
  });
});

describe("OAuthDraftStore", () => {
  it("keeps drafts per user and URL, and ages tokens on claim", () => {
    let now = 1_000_000;
    const store = new OAuthDraftStore("http://x", () => now);
    const d = store.open(1, "https://a/mcp");
    expect(store.get(2, d.id)).toBeUndefined();
    expect(store.open(1, "https://a/mcp", d.id)).toBe(d);
    expect(store.open(1, "https://b/mcp", d.id)).not.toBe(d);
    expect(store.claim(1, d.id, "https://a/mcp")).toBeUndefined(); // not authorized yet

    const p = store.provider(d);
    p.saveTokens({ access_token: "t", token_type: "bearer", expires_in: 3600 });
    now += 600_000;
    expect(store.claim(2, d.id, "https://a/mcp")).toBeUndefined();
    expect(store.claim(1, d.id, "https://other/mcp")).toBeUndefined();
    expect(store.claim(1, d.id, "https://a/mcp")?.tokens.expires_in).toBe(3000);
    expect(store.get(1, d.id)).toBeUndefined(); // claimed once
  });

  it("forgets drafts after 30 minutes", () => {
    let now = 0;
    const store = new OAuthDraftStore("http://x", () => now);
    const d = store.open(1, "https://a/mcp");
    now += 31 * 60_000;
    expect(store.get(1, d.id)).toBeUndefined();
  });
});
