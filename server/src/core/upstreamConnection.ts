import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  PromptListChangedNotificationSchema,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type Prompt,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Stream } from "node:stream";
import { decrypt } from "../lib/crypto.js";
import { RingBuffer } from "../lib/ringBuffer.js";
import type { ServerRow } from "../db/schema.js";

export type UpstreamState = "disabled" | "connecting" | "connected" | "backoff" | "needs_auth" | "stopped";
export type ChangedKind = "tools" | "prompts" | "resources";

export interface UpstreamEvents {
  /** A cache (tools/prompts/resources) changed — hub should fan out list_changed. */
  onCachesChanged: (serverId: number, kind: ChangedKind) => void;
  /** Connection state changed (for status UI + hub fanout when tools appear/disappear). */
  onStateChanged: (serverId: number, state: UpstreamState) => void;
  /** Build an OAuthClientProvider for a server (injected to avoid a core→oauth dependency). */
  makeOAuthProvider: (serverId: number) => OAuthClientProvider;
}

const CALL_TIMEOUT_MS = 120_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const HEALTHY_RESET_MS = 30_000;

interface RequestOpts {
  onprogress?: (progress: { progress: number; total?: number; message?: string }) => void;
  signal?: AbortSignal;
}

export class UpstreamConnection {
  readonly stderrLog = new RingBuffer(500);
  state: UpstreamState = "disabled";
  lastError: string | null = null;

  toolsCache: Tool[] = [];
  promptsCache: Prompt[] = [];
  resourcesCache: Resource[] = [];

  private client: Client | null = null;
  private transport: Transport | null = null;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthyTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private connecting = false;

  constructor(
    public row: ServerRow,
    private events: UpstreamEvents,
  ) {}

  get serverId(): number {
    return this.row.id;
  }

  /** Replace config (after a PATCH) — caller should restart() afterwards. */
  updateRow(row: ServerRow): void {
    this.row = row;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    await this.teardown();
    this.setState("stopped");
  }

  async restart(): Promise<void> {
    this.clearTimers();
    await this.teardown();
    this.attempts = 0;
    this.stopped = false;
    void this.connect();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.reconnectTimer = null;
    this.healthyTimer = null;
  }

  private async teardown(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // already dead
      }
    }
  }

  private setState(state: UpstreamState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChanged(this.serverId, state);
  }

  private buildTransport(): Transport {
    const row = this.row;
    if (row.type === "stdio") {
      const args: string[] = row.argsJson ? JSON.parse(row.argsJson) : [];
      const userEnv: Record<string, string> = row.envJsonEnc ? JSON.parse(decrypt(row.envJsonEnc)) : {};
      const transport = new StdioClientTransport({
        command: row.command ?? "",
        args,
        env: { ...getDefaultEnvironment(), ...userEnv },
        cwd: row.cwd ?? undefined,
        stderr: "pipe",
      });
      const stderr = transport.stderr as Stream | null;
      stderr?.on("data", (chunk: Buffer) => this.stderrLog.pushChunk(chunk.toString("utf8")));
      return transport;
    }

    if (!row.url) throw new Error("Remote server has no URL");
    const url = new URL(row.url);
    const headers = this.buildHeaders();
    const authProvider = row.authType === "oauth" ? this.events.makeOAuthProvider(row.id) : undefined;

    if (row.type === "http") {
      return new StreamableHTTPClientTransport(url, {
        authProvider,
        requestInit: headers ? { headers } : undefined,
      });
    }

    // SSE: setting eventSourceInit suppresses the auto Authorization header, so we
    // inject headers through a custom fetch that applies to every request instead.
    const fetchWithHeaders: typeof fetch | undefined = headers
      ? (input, init) => {
          const merged = new Headers(init?.headers);
          for (const [k, v] of Object.entries(headers)) if (!merged.has(k)) merged.set(k, v);
          return fetch(input, { ...init, headers: merged });
        }
      : undefined;
    return new SSEClientTransport(url, {
      authProvider,
      fetch: fetchWithHeaders,
    });
  }

  private buildHeaders(): Record<string, string> | null {
    const row = this.row;
    if (row.authType === "bearer" && row.bearerTokenEnc) {
      return { Authorization: `Bearer ${decrypt(row.bearerTokenEnc)}` };
    }
    if (row.authType === "headers" && row.headersJsonEnc) {
      return JSON.parse(decrypt(row.headersJsonEnc)) as Record<string, string>;
    }
    return null;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.setState("connecting");
    try {
      const transport = this.buildTransport();
      const client = new Client({ name: "mcp-switchboard", version: "1.0.0" }, { capabilities: {} });
      client.onclose = () => {
        if (!this.stopped && this.client === client) {
          this.lastError = this.lastError ?? "connection closed";
          void this.scheduleReconnect();
        }
      };
      client.onerror = (err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      };
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      this.lastError = null;

      this.registerNotificationHandlers(client);
      await this.refreshCaches();

      this.setState("connected");
      this.healthyTimer = setTimeout(() => {
        this.attempts = 0;
      }, HEALTHY_RESET_MS);
      this.events.onCachesChanged(this.serverId, "tools");
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err);
      if (/\b401\b|invalid_token|unauthorized/i.test(msg) && this.row.authType !== "oauth") {
        msg += "\n→ This server likely requires OAuth. Edit it, set Authentication to OAuth, then click Authorize.";
      }
      this.lastError = msg;
      await this.teardown();
      if (err instanceof UnauthorizedError) {
        this.setState("needs_auth");
      } else {
        void this.scheduleReconnect();
      }
    } finally {
      this.connecting = false;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    await this.teardown();
    this.clearCaches();
    this.events.onCachesChanged(this.serverId, "tools");
    if (this.stopped) return;
    this.setState("backoff");
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.attempts, BACKOFF_CAP_MS);
    this.attempts += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  get nextRetryMs(): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, this.attempts - 1), BACKOFF_CAP_MS);
  }

  private clearCaches(): void {
    this.toolsCache = [];
    this.promptsCache = [];
    this.resourcesCache = [];
  }

  private registerNotificationHandlers(client: Client): void {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.refreshTools();
      this.events.onCachesChanged(this.serverId, "tools");
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      await this.refreshPrompts();
      this.events.onCachesChanged(this.serverId, "prompts");
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      await this.refreshResources();
      this.events.onCachesChanged(this.serverId, "resources");
    });
  }

  private async refreshCaches(): Promise<void> {
    await this.refreshTools();
    await this.refreshPrompts();
    await this.refreshResources();
  }

  private async refreshTools(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const caps = client.getServerCapabilities();
    if (!caps?.tools) {
      this.toolsCache = [];
      return;
    }
    const all: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.request(
        { method: "tools/list", params: cursor ? { cursor } : {} },
        ListToolsResultSchema,
      );
      all.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    this.toolsCache = all;
  }

  private async refreshPrompts(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const caps = client.getServerCapabilities();
    if (!caps?.prompts) {
      this.promptsCache = [];
      return;
    }
    const all: Prompt[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.request(
        { method: "prompts/list", params: cursor ? { cursor } : {} },
        ListPromptsResultSchema,
      );
      all.push(...page.prompts);
      cursor = page.nextCursor;
    } while (cursor);
    this.promptsCache = all;
  }

  private async refreshResources(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const caps = client.getServerCapabilities();
    if (!caps?.resources) {
      this.resourcesCache = [];
      return;
    }
    const all: Resource[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.request(
        { method: "resources/list", params: cursor ? { cursor } : {} },
        ListResourcesResultSchema,
      );
      all.push(...page.resources);
      cursor = page.nextCursor;
    } while (cursor);
    this.resourcesCache = all;
  }

  /** Forward a request; on 401 (OAuth) try one silent refresh + reconnect + retry. */
  private async forward<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.client || this.state !== "connected") {
      throw new Error(`Server "${this.row.slug}" is not connected (${this.state})`);
    }
    try {
      return await fn();
    } catch (err) {
      if (err instanceof UnauthorizedError && this.row.authType === "oauth") {
        const provider = this.events.makeOAuthProvider(this.serverId);
        const result = await auth(provider, { serverUrl: this.row.url! }).catch(() => "REDIRECT" as const);
        if (result === "AUTHORIZED") {
          await this.restart();
          await this.waitForConnected(10_000);
          return await fn();
        }
        this.setState("needs_auth");
        throw new Error(`Server "${this.row.slug}" needs re-authorization in the switchboard UI`);
      }
      throw err;
    }
  }

  private async waitForConnected(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.state === "connected") return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Server "${this.row.slug}" did not reconnect in time`);
  }

  async callTool(name: string, args: Record<string, unknown> | undefined, opts: RequestOpts) {
    return this.forward(() =>
      this.client!.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema, {
        onprogress: opts.onprogress,
        signal: opts.signal,
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
      }),
    );
  }

  async getPrompt(name: string, args: Record<string, string> | undefined, opts: RequestOpts) {
    return this.forward(() =>
      this.client!.request({ method: "prompts/get", params: { name, arguments: args } }, GetPromptResultSchema, {
        signal: opts.signal,
        timeout: CALL_TIMEOUT_MS,
      }),
    );
  }

  async readResource(uri: string, opts: RequestOpts) {
    return this.forward(() =>
      this.client!.request({ method: "resources/read", params: { uri } }, ReadResourceResultSchema, {
        signal: opts.signal,
        timeout: CALL_TIMEOUT_MS,
      }),
    );
  }
}
