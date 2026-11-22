import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerRow } from "../db/schema.js";
import { advertisesOAuth } from "../lib/authProbe.js";
import { decrypt } from "../lib/crypto.js";
import { RingBuffer } from "../lib/ringBuffer.js";
import { buildUpstreamTransport, upstreamHeaders, type UpstreamEvents } from "./upstreamConnection.js";

/*
 * "Test connection": run a server config once, end to end, without saving it — reach it, check its
 * credentials, do the MCP handshake and list what it offers — and report each step, so a broken
 * config is caught (with a likely fix) before it's added. Uses the same transport builder and
 * sandbox as live connections, so a pass means the real thing will connect too.
 */

export type StepKey = "start" | "reach" | "auth" | "oauth" | "authorize" | "handshake" | "list";
export type StepStatus = "ok" | "fail" | "skip" | "waiting";

export interface TestStep {
  key: StepKey;
  label: string;
  status: StepStatus;
  detail?: string;
  ms?: number;
}

/** A one-click change the UI can make to the form, then test again. */
export type TestFix =
  | { kind: "use_oauth" }
  | { kind: "use_http" }
  | { kind: "use_sse" }
  | { kind: "set_token" }
  | { kind: "add_env"; name: string };

export interface TestReport {
  ok: boolean;
  headline: string;
  ms: number;
  steps: TestStep[];
  server?: { name: string; version: string; protocolVersion?: string };
  counts?: { tools: number; prompts: number; resources: number };
  /** Tool names (un-namespaced), for the preview chips. */
  tools?: string[];
  /** The tail of a local server's stderr, when it failed. */
  stderr?: string[];
  hint?: string;
  fix?: TestFix;
  /** OAuth needs a person in a browser before the handshake can happen. */
  authorizeUrl?: string;
  /** Stored OAuth tokens were rejected or are missing: authorize again. */
  needsAuthorization?: boolean;
}

export interface TestDeps {
  wrapStdio: (row: ServerRow, spawn: Parameters<UpstreamEvents["wrapStdio"]>[1], homeName: string) => ReturnType<UpstreamEvents["wrapStdio"]>;
  /** Where sandbox homes live, so the test's throwaway one can be removed afterwards. */
  sandboxRoot?: string;
  /** For OAuth servers: the provider to authorize and connect with. */
  oauthProvider?: OAuthClientProvider & { capturedAuthorizationUrl?: URL | null };
  /** Says where tokens come from, for the authorize step's detail. */
  oauthSource?: "stored" | "draft";
  fetch?: typeof fetch;
  /** Handshake timeout. Local servers get longer: `npx -y` may have to download first. */
  timeoutMs?: number;
}

const REACH_TIMEOUT_MS = 10_000;
const REMOTE_TIMEOUT_MS = 20_000;
const STDIO_TIMEOUT_MS = 90_000;
const LIST_TIMEOUT_MS = 20_000;
const STDERR_TAIL = 30;
const TOOL_PREVIEW = 50;

/** At most this many local test processes at once, across all users. */
const STDIO_CONCURRENCY = 3;
let stdioRunning = 0;
const stdioQueue: (() => void)[] = [];

async function withStdioSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (stdioRunning >= STDIO_CONCURRENCY) await new Promise<void>((r) => stdioQueue.push(r));
  stdioRunning++;
  try {
    return await fn();
  } finally {
    stdioRunning--;
    stdioQueue.shift()?.();
  }
}

const AUTH_LABEL: Record<ServerRow["authType"], string> = {
  none: "No authentication",
  bearer: "Authenticated with bearer token",
  headers: "Authenticated with custom headers",
  oauth: "Authorized with OAuth",
};

export async function testConnection(row: ServerRow, deps: TestDeps): Promise<TestReport> {
  const t0 = Date.now();
  const report = row.type === "stdio" ? await withStdioSlot(() => testStdio(row, deps)) : await testRemote(row, deps);
  return { ...report, ms: Date.now() - t0 };
}

type Partial0 = Omit<TestReport, "ms">;

/* ---------------- stdio ---------------- */

async function testStdio(row: ServerRow, deps: TestDeps): Promise<Partial0> {
  const steps: TestStep[] = [];
  const stderr = new RingBuffer(200);
  const homeName = `test-${crypto.randomUUID()}`;
  let note = "";
  let startMs: number | undefined;
  try {
    let transport;
    try {
      transport = buildUpstreamTransport(row, "stdio", {
        wrapStdio: (r, spawn) => deps.wrapStdio(r, spawn, homeName),
        makeOAuthProvider: () => {
          throw new Error("Local servers don't use OAuth");
        },
        onNote: (line) => (note = line),
        onStderr: (chunk) => stderr.pushChunk(chunk),
      });
    } catch (err) {
      steps.push({ key: "start", label: "Started the command", status: "fail", detail: message(err) });
      steps.push(skipped("handshake"), skipped("list"));
      return { ok: false, headline: "Could not start the command", steps };
    }

    const origStart = transport.start.bind(transport);
    transport.start = async () => {
      const s = Date.now();
      await origStart();
      startMs = Date.now() - s;
    };

    const outcome = await handshake(transport, deps.timeoutMs ?? STDIO_TIMEOUT_MS);
    if (startMs === undefined && "error" in outcome) {
      // spawn itself failed (no such command, not executable)
      steps.push({ key: "start", label: "Started the command", status: "fail", detail: message(outcome.error) });
      steps.push(skipped("handshake"), skipped("list"));
      return {
        ok: false,
        headline: "Could not start the command",
        steps,
        hint: commandNotFound(outcome.error, row) ?? undefined,
      };
    }
    steps.push({ key: "start", label: "Started the command", status: "ok", detail: sandboxDetail(note), ms: startMs });

    if ("error" in outcome) {
      await outcome.client?.close().catch(() => {});
      const tail = await settledStderr(stderr);
      const exited = /connection closed/i.test(message(outcome.error));
      steps.push({
        key: "handshake",
        label: "MCP handshake",
        status: "fail",
        detail: exited ? "The process exited before answering" : message(outcome.error),
        ms: outcome.ms,
      });
      steps.push(skipped("list"));
      const missing = missingEnvVar(tail, row);
      const notFound = commandNotFound(tail.join("\n"), row);
      return {
        ok: false,
        headline: exited ? "Process exited before the handshake" : "Handshake failed",
        steps,
        stderr: tail.slice(-STDERR_TAIL),
        ...(missing
          ? { fix: { kind: "add_env", name: missing }, hint: `stderr mentions ${missing}, which isn't set.` }
          : notFound
            ? { hint: notFound }
            : {}),
      };
    }

    return await finish(outcome.client, steps, outcome.ms, async () => (await settledStderr(stderr)).slice(-STDERR_TAIL));
  } finally {
    if (deps.sandboxRoot) {
      fs.rm(path.join(deps.sandboxRoot, homeName), { recursive: true, force: true }, () => {});
    }
  }
}

function sandboxDetail(note: string): string | undefined {
  const m = note.match(/^running (.*)$/);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : note || undefined;
}

/** Give a dying process a beat to flush stderr before reading it. */
async function settledStderr(buf: RingBuffer): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 150));
  return buf.toArray().filter((l) => !/^\s*$/.test(l));
}

/** An env-var-looking name next to words like "required" / "missing" that the config doesn't set. */
export function missingEnvVar(lines: string[], row: ServerRow): string | null {
  const env: Record<string, string> = row.envJsonEnc ? JSON.parse(decrypt(row.envJsonEnc)) : {};
  for (const line of lines) {
    if (!/env|variable|required|missing|not set|must be set|undefined/i.test(line)) continue;
    for (const name of line.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b/g) ?? []) {
      if (!(name in env) && !(name in process.env)) return name;
    }
  }
  return null;
}

function commandNotFound(errOrText: unknown, row: ServerRow): string | null {
  const text = typeof errOrText === "string" ? errOrText : message(errOrText);
  if (/ENOENT|No such file or directory|command not found|execvp/i.test(text)) {
    return `"${row.command}" wasn't found. Check the spelling, or use a full path; it must be installed on the switchboard's machine.`;
  }
  return null;
}

/* ---------------- remote ---------------- */

interface Reached {
  status: number;
  contentType: string;
  /** After a 405 to POST: what a GET of the same URL serves. */
  getContentType?: string;
  wwwAuthenticate: string | null;
  ms: number;
}

async function testRemote(row: ServerRow, deps: TestDeps): Promise<Partial0> {
  const steps: TestStep[] = [];
  const fetchFn = deps.fetch ?? fetch;
  const url = row.url ?? "";
  const isOAuth = row.authType === "oauth";

  // 1. Reach it (with the configured credentials, so a 401 means they were refused).
  let reached: Reached;
  try {
    reached = await reach(row, isOAuth ? null : upstreamHeaders(row), fetchFn);
  } catch (err) {
    steps.push({ key: "reach", label: "Reached server", status: "fail", detail: networkError(err, url) });
    steps.push(...(row.authType !== "none" ? [skipped("auth", AUTH_LABEL[row.authType])] : []), skipped("handshake"), skipped("list"));
    return { ok: false, headline: "Could not reach the server", steps };
  }
  const denied = reached.status === 401 || reached.status === 403;
  steps.push({
    key: "reach",
    label: "Reached server",
    status: "ok",
    detail: `HTTP ${reached.status}${denied && isOAuth ? " · expected before sign-in" : ""}`,
    ms: reached.ms,
  });

  // 2. Credentials.
  if (!isOAuth && denied) {
    const oauth = await advertisesOAuth(url, reached.wwwAuthenticate, fetchFn);
    steps.push({
      key: "auth",
      label: AUTH_LABEL[row.authType],
      status: "fail",
      detail: `${reached.status} ${reached.status === 401 ? "Unauthorized" : "Forbidden"}${reached.wwwAuthenticate ? ` · WWW-Authenticate: ${reached.wwwAuthenticate}` : ""}`,
    });
    steps.push(skipped("handshake"), skipped("list"));
    return {
      ok: false,
      headline: row.authType === "none" ? "The server wants credentials" : "Authentication failed",
      steps,
      ...(oauth
        ? { fix: { kind: "use_oauth" }, hint: "This server uses OAuth. It advertises an authorization server, so a static token won't work." }
        : row.authType === "none"
          ? { fix: { kind: "set_token" }, hint: "Set Authentication to a bearer token or custom headers (usually an API key from the provider)." }
          : { hint: "The credentials were refused. Check the token is current and has the scopes this server needs." }),
    };
  }

  // A 405 to POST is either a legacy SSE endpoint or not an MCP URL at all: a GET tells which.
  if (row.type === "http" && reached.status === 405) {
    reached.getContentType = await fetchFn(url, {
      headers: { Accept: "text/event-stream, text/html;q=0.9" },
      signal: AbortSignal.timeout(REACH_TIMEOUT_MS),
    })
      .then(async (r) => {
        await r.body?.cancel().catch(() => {});
        return r.headers.get("content-type") ?? "";
      })
      .catch(() => "");
  }

  // Answers that mean "nothing speaks MCP here", before spending a handshake on them.
  const early = wrongEndpoint(row, reached);
  if (early) {
    if (!isOAuth && row.authType !== "none") steps.push({ key: "auth", label: AUTH_LABEL[row.authType], status: "skip" });
    steps.push({ key: "handshake", label: "MCP handshake", status: "fail", detail: early.detail });
    steps.push(skipped("list"));
    return { ok: false, headline: early.headline, steps, hint: early.hint, fix: early.fix };
  }

  // 2b. OAuth: authorize first when there are no tokens yet.
  if (isOAuth) {
    const provider = deps.oauthProvider;
    if (!provider) throw new Error("OAuth test needs a provider");
    if (!(await provider.tokens())) {
      const s = Date.now();
      try {
        const result = await auth(provider, { serverUrl: url, fetchFn });
        if (result === "REDIRECT") {
          const authorizeUrl = provider.capturedAuthorizationUrl?.toString();
          steps.push({ key: "oauth", label: "Discovered OAuth", status: "ok", detail: authHost(authorizeUrl), ms: Date.now() - s });
          steps.push({ key: "authorize", label: "Authorize in browser", status: "waiting" });
          steps.push(skipped("handshake"), skipped("list"));
          return { ok: false, headline: "Waiting for you to approve in the browser", steps, authorizeUrl };
        }
      } catch (err) {
        steps.push({ key: "oauth", label: "Discovered OAuth", status: "fail", detail: oauthError(err), ms: Date.now() - s });
        steps.push(skipped("handshake"), skipped("list"));
        return { ok: false, headline: "OAuth setup failed", steps };
      }
    }
    steps.push({
      key: "authorize",
      label: AUTH_LABEL.oauth,
      status: "ok",
      detail: deps.oauthSource === "stored" ? "using the stored tokens" : "approved in the browser",
    });
  } else if (row.authType !== "none") {
    steps.push({ key: "auth", label: AUTH_LABEL[row.authType], status: "ok" });
  }

  // 3. Handshake over the real transport.
  const transport = buildUpstreamTransport(row, row.type, {
    wrapStdio: () => {
      throw new Error("not a local server");
    },
    makeOAuthProvider: () => deps.oauthProvider!,
  });
  const outcome = await handshake(transport, deps.timeoutMs ?? REMOTE_TIMEOUT_MS);
  if ("error" in outcome) {
    await outcome.client?.close().catch(() => {});
    const unauthorized = outcome.error instanceof UnauthorizedError || /\b401\b/.test(message(outcome.error));
    steps.push({ key: "handshake", label: "MCP handshake", status: "fail", detail: message(outcome.error), ms: outcome.ms });
    steps.push(skipped("list"));
    if (isOAuth && unauthorized) {
      return { ok: false, headline: "The OAuth tokens were rejected", steps, needsAuthorization: true };
    }
    return { ok: false, headline: "Handshake failed", steps };
  }
  return finish(outcome.client, steps, outcome.ms);
}

/** One raw request, to see the HTTP status before the SDK hides it inside an error. */
async function reach(row: ServerRow, headers: Record<string, string> | null, fetchFn: typeof fetch): Promise<Reached> {
  const s = Date.now();
  const res =
    row.type === "sse"
      ? await fetchFn(row.url!, {
          method: "GET",
          headers: { Accept: "text/event-stream", ...headers },
          signal: AbortSignal.timeout(REACH_TIMEOUT_MS),
        })
      : await fetchFn(row.url!, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "mcp-switchboard-test", version: "1.0.0" },
            },
          }),
          signal: AbortSignal.timeout(REACH_TIMEOUT_MS),
        });
  const ms = Date.now() - s;
  await res.body?.cancel().catch(() => {});
  // Don't leave the probe's session open on the server.
  const sessionId = res.headers.get("mcp-session-id");
  if (sessionId && res.ok) {
    void fetchFn(row.url!, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId, ...headers },
      signal: AbortSignal.timeout(REACH_TIMEOUT_MS),
    }).catch(() => {});
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    wwwAuthenticate: res.headers.get("www-authenticate"),
    ms,
  };
}

function wrongEndpoint(
  row: ServerRow,
  r: Reached,
): { headline: string; detail: string; hint: string; fix?: TestFix } | null {
  if (row.type === "sse" && [404, 405, 410].includes(r.status)) {
    return {
      headline: "This URL doesn't speak legacy SSE",
      detail: `HTTP ${r.status} to the SSE stream`,
      hint: "The server refused the legacy SSE transport. Most servers now use Streamable HTTP, often at the same URL ending in /mcp.",
      fix: { kind: "use_http" },
    };
  }
  if (row.type === "http" && r.status === 405) {
    if (/text\/event-stream/i.test(r.getContentType ?? "")) {
      return {
        headline: "This is a legacy SSE endpoint",
        detail: "HTTP 405 to POST · GET opens an event stream",
        hint: "Set Transport to SSE, or use the provider's Streamable HTTP URL if it has one.",
        fix: { kind: "use_sse" },
      };
    }
    if (/text\/html/i.test(r.getContentType ?? "")) {
      return {
        headline: "This URL serves a web page, not MCP",
        detail: "HTTP 405 to POST · GET returns a web page",
        hint: "Use the server's MCP endpoint, not its homepage or docs page.",
      };
    }
    return {
      headline: "This URL doesn't accept MCP requests",
      detail: "HTTP 405 to POST",
      hint: "Check the URL against the provider's docs; MCP endpoints usually end in /mcp (or /sse for legacy ones).",
    };
  }
  if (r.status === 404) {
    return {
      headline: "Nothing answers at this URL",
      detail: "HTTP 404",
      hint: "Check the path; many servers live at /mcp (or /sse for legacy ones).",
    };
  }
  if (r.status >= 200 && r.status < 300 && /text\/html/i.test(r.contentType)) {
    return {
      headline: "This URL serves a web page, not MCP",
      detail: `HTTP ${r.status} · ${r.contentType.split(";")[0]}`,
      hint: "Use the server's MCP endpoint, not its homepage or docs page.",
    };
  }
  return null;
}

function networkError(err: unknown, url: string): string {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? "";
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep the raw URL
  }
  if ((err as Error)?.name === "TimeoutError") return `No response from ${host} within ${REACH_TIMEOUT_MS / 1000}s`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `DNS lookup failed for ${host}`;
  if (code === "ECONNREFUSED") return `Connection refused by ${host}`;
  if (code === "ECONNRESET") return `Connection reset by ${host}`;
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(code)) return `TLS certificate problem: ${cause?.message ?? code}`;
  return cause?.message ?? message(err);
}

function oauthError(err: unknown): string {
  let msg = message(err);
  if (/dynamic client registration/i.test(msg)) {
    msg += " — this provider needs a pre-registered OAuth app, which MCP clients can't do automatically. Use a bearer token / API key instead.";
  } else if (/invalid_redirect_uri|redirect[_ ]uri/i.test(msg)) {
    msg += " — most providers only accept an https or loopback redirect URI, so check PUBLIC_URL.";
  }
  return msg;
}

function authHost(authorizeUrl: string | undefined): string | undefined {
  if (!authorizeUrl) return undefined;
  try {
    return new URL(authorizeUrl).host;
  } catch {
    return undefined;
  }
}

/* ---------------- shared ---------------- */

async function handshake(
  transport: Parameters<Client["connect"]>[0],
  timeoutMs: number,
): Promise<{ client: Client; ms: number } | { error: unknown; client?: Client; ms: number }> {
  const client = new Client({ name: "mcp-switchboard-test", version: "1.0.0" }, { capabilities: {} });
  const s = Date.now();
  try {
    await client.connect(transport, { timeout: timeoutMs });
    return { client, ms: Date.now() - s };
  } catch (error) {
    return { error, client, ms: Date.now() - s };
  }
}

async function finish(
  client: Client,
  steps: TestStep[],
  handshakeMs: number,
  stderrOnFail?: () => Promise<string[]>,
): Promise<Partial0> {
  const info = client.getServerVersion();
  const protocolVersion = (client.transport as { protocolVersion?: string } | undefined)?.protocolVersion;
  steps.push({
    key: "handshake",
    label: "MCP handshake",
    status: "ok",
    detail: [info ? `${info.name} ${info.version}` : null, protocolVersion ? `protocol ${protocolVersion}` : null]
      .filter(Boolean)
      .join(" · ") || undefined,
    ms: handshakeMs,
  });
  const s = Date.now();
  try {
    const caps = client.getServerCapabilities() ?? {};
    const tools = caps.tools ? await listAll(client, "tools/list", ListToolsResultSchema, "tools") : [];
    const prompts = caps.prompts ? await listAll(client, "prompts/list", ListPromptsResultSchema, "prompts") : [];
    const resources = caps.resources ? await listAll(client, "resources/list", ListResourcesResultSchema, "resources") : [];
    const counts = { tools: tools.length, prompts: prompts.length, resources: resources.length };
    steps.push({
      key: "list",
      label: "Listed capabilities",
      status: "ok",
      detail: `${plural(counts.tools, "tool")} · ${plural(counts.resources, "resource")} · ${plural(counts.prompts, "prompt")}`,
      ms: Date.now() - s,
    });
    return {
      ok: true,
      headline: `Connected. ${plural(counts.tools, "tool")} ready`,
      steps,
      server: info ? { name: info.name, version: info.version, protocolVersion } : undefined,
      counts,
      tools: tools.slice(0, TOOL_PREVIEW).map((t) => t.name ?? ""),
    };
  } catch (err) {
    steps.push({ key: "list", label: "Listed capabilities", status: "fail", detail: message(err), ms: Date.now() - s });
    return { ok: false, headline: "Connected, but listing failed", steps, stderr: await stderrOnFail?.() };
  } finally {
    await client.close().catch(() => {});
  }
}

async function listAll(
  client: Client,
  method: "tools/list" | "prompts/list" | "resources/list",
  schema: Parameters<Client["request"]>[1],
  key: "tools" | "prompts" | "resources",
): Promise<{ name?: string }[]> {
  const all: { name?: string }[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = (await client.request({ method, params: cursor ? { cursor } : {} }, schema, {
        timeout: LIST_TIMEOUT_MS,
      })) as Record<string, unknown> & { nextCursor?: string };
      all.push(...((page[key] as { name?: string }[] | undefined) ?? []));
      cursor = page.nextCursor;
    } while (cursor && all.length < 10_000);
  } catch (err) {
    // Some servers advertise a capability but don't implement its list method.
    if (!(err instanceof McpError && err.code === ErrorCode.MethodNotFound)) throw err;
  }
  return all;
}

const LABELS: Record<StepKey, string> = {
  start: "Started the command",
  reach: "Reached server",
  auth: "Authenticated",
  oauth: "Discovered OAuth",
  authorize: "Authorize in browser",
  handshake: "MCP handshake",
  list: "Listed capabilities",
};

function skipped(key: StepKey, label = LABELS[key]): TestStep {
  return { key, label, status: "skip" };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
