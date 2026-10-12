import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { UpstreamConnection, type UpstreamEvents } from "../src/core/upstreamConnection.js";
import type { ServerRow } from "../src/db/schema.js";

/**
 * Mimics Cloudflare's MCP servers after they retired HTTP+SSE: the SSE GET is 410 Gone, while POSTs to
 * the same URL speak stateless Streamable HTTP (unless `streamable` is false).
 */
async function startUpstream(streamable: boolean): Promise<{ http: Server; url: string }> {
  const http = createServer(async (req, res) => {
    if (req.method !== "POST" || !streamable) {
      res.writeHead(410, { "content-type": "application/json" }).end('{"title":"Legacy SSE transport is no longer supported"}');
      return;
    }
    const mcp = new McpServer({ name: "fake-cloudflare", version: "1.0.0" });
    mcp.registerTool("ping", { description: "pong" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { http, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/sse` };
}

function sseRow(url: string): ServerRow {
  return {
    id: 1,
    slug: "cloudflare",
    name: "cloudflare",
    description: null,
    type: "sse",
    enabled: true,
    command: null,
    argsJson: null,
    envJsonEnc: null,
    cwd: null,
    url,
    authType: "none",
    bearerTokenEnc: null,
    headersJsonEnc: null,
    createdByAgentSlug: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("legacy SSE fallback", () => {
  let http: Server | undefined;
  let conn: UpstreamConnection | undefined;

  afterEach(async () => {
    await conn?.stop();
    await new Promise((r) => http?.close(r));
  });

  it("retries a 410'd SSE server over Streamable HTTP and switches it to http", async () => {
    const up = await startUpstream(true);
    http = up.http;
    const fallbacks: number[] = [];
    const events: UpstreamEvents = {
      onCachesChanged: () => {},
      onStateChanged: () => {},
      makeOAuthProvider: () => {
        throw new Error("no oauth");
      },
      onLegacySseFallback: (id) => {
        fallbacks.push(id);
        return { ...sseRow(up.url), type: "http", updatedAt: 1 };
      },
    };
    conn = new UpstreamConnection(sseRow(up.url), events);
    conn.start();
    await waitFor(() => conn!.state === "connected");

    expect(conn.toolsCache.map((t) => t.name)).toEqual(["ping"]);
    expect(fallbacks).toEqual([1]);
    expect(conn.row.type).toBe("http");
    expect(conn.stderrLog.toArray().join("\n")).toContain("switched from SSE to HTTP");
  });

  it("explains the fix when Streamable HTTP fails too", async () => {
    const up = await startUpstream(false);
    http = up.http;
    let fellBack = false;
    conn = new UpstreamConnection(sseRow(up.url), {
      onCachesChanged: () => {},
      onStateChanged: () => {},
      makeOAuthProvider: () => {
        throw new Error("no oauth");
      },
      onLegacySseFallback: () => {
        fellBack = true;
        return undefined;
      },
    });
    conn.start();
    await waitFor(() => conn!.state === "backoff");

    expect(conn.lastError).toContain("Non-200 status code (410)");
    expect(conn.lastError).toContain("refused the legacy SSE transport");
    expect(conn.lastError).toContain("set Transport to HTTP");
    expect(fellBack).toBe(false);
  });
});
