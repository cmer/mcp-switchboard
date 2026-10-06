import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { auth, refreshAuthorization, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agentOAuthGrants, agents } from "../src/db/schema.js";
import { encrypt, loadOrCreateKey } from "../src/lib/crypto.js";
import { createMcpApp } from "../src/http/app.js";
import { agentRoutes } from "../src/http/routes/agents.js";
import { isAcceptableRedirectUri, redirectUriMatches, slugFromResource } from "../src/http/agentOAuthRoutes.js";
import type { AppContext } from "../src/http/context.js";
import { ACCESS_TTL_MS, AgentOAuthStore, REFRESH_GRACE_MS } from "../src/oauth/agentOAuth.js";

const BASE = "https://sb.example.com";
const MCP_URL = `${BASE}/mcp/claude`;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

let db: Db;
let app: Hono;
let store: AgentOAuthStore;
let tmp: string;
let dropAgentSessions: ReturnType<typeof vi.fn>;
let claudeId: number;
let codexId: number;

/** Route the SDK client's HTTP straight into the Hono app. */
const fetchFn = ((url: string | URL, init?: RequestInit) => app.request(url.toString(), init)) as typeof fetch;

/** The minimum a spec-following client (this is what Claude's connector does) keeps between steps. */
class MemoryProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authUrl?: URL;
  constructor(private redirect = CALLBACK) {}
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata() {
    return {
      client_name: "Claude",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

function initialize(token?: string) {
  return app.request(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
}

/** Submit the consent form the way a browser would: every authorize param echoed, plus the code. */
async function approve(authUrl: URL, pairingCode: string, decision = "approve") {
  const form = new URLSearchParams(authUrl.searchParams);
  form.set("pairing_code", pairingCode);
  form.set("decision", decision);
  return app.request(`${BASE}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

/** Discovery → registration → consent → code exchange, as Claude runs it after a 401. */
async function connect(provider = new MemoryProvider(), agentId = claudeId) {
  const challenge = (await initialize()).headers.get("WWW-Authenticate")!;
  const resourceMetadataUrl = new URL(/resource_metadata="([^"]+)"/.exec(challenge)![1]);

  expect(await auth(provider, { serverUrl: MCP_URL, resourceMetadataUrl, fetchFn })).toBe("REDIRECT");
  const consent = await app.request(provider.authUrl!.toString());
  expect(consent.status).toBe(200);

  const res = await approve(provider.authUrl!, store.createPairingCode(agentId).code);
  expect(res.status).toBe(303);
  const back = new URL(res.headers.get("Location")!);
  expect(back.origin + back.pathname).toBe(CALLBACK);
  expect(back.searchParams.get("iss")).toBe(BASE);

  const code = back.searchParams.get("code")!;
  expect(await auth(provider, { serverUrl: MCP_URL, resourceMetadataUrl, authorizationCode: code, fetchFn })).toBe(
    "AUTHORIZED",
  );
  return { provider, code, resourceMetadataUrl };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-agent-oauth-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  claudeId = db.insert(agents).values({ slug: "claude", name: "Claude", tokenEnc: encrypt("static-claude"), createdAt: 1 }).returning().get().id;
  codexId = db.insert(agents).values({ slug: "codex", name: "Codex", tokenEnc: encrypt("static-codex"), createdAt: 1 }).returning().get().id;
  store = new AgentOAuthStore(db);
  dropAgentSessions = vi.fn(async () => {});
  const hub = {
    handleRequest: async (agent: { slug: string }) => new Response(JSON.stringify({ agent: agent.slug }), { status: 200 }),
    dropAgentSessions,
  };
  app = createMcpApp({ db, hub, agentOAuth: store } as unknown as AppContext);
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("discovery", () => {
  it("points an unauthenticated request at the protected-resource metadata", async () => {
    const res = await initialize();
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/claude"`,
    );
    // Browser clients must be able to read the challenge cross-origin.
    expect((await app.request(MCP_URL, { headers: { Origin: "https://inspector.local" } })).headers.get("Access-Control-Expose-Headers")).toContain(
      "WWW-Authenticate",
    );
  });

  it("names the exact resource URL the client used, honouring proxy headers", async () => {
    const res = await app.request("http://10.0.0.5:8788/.well-known/oauth-protected-resource/mcp/claude", {
      headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "sb.example.com" },
    });
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(MCP_URL);
    expect(body.authorization_servers).toEqual([BASE]);
  });

  it("404s the metadata of an agent that doesn't exist", async () => {
    expect((await app.request(`${BASE}/.well-known/oauth-protected-resource/mcp/nope`)).status).toBe(404);
  });

  it("advertises no scopes and S256-only PKCE", async () => {
    const meta = (await (await app.request(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(BASE);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta).not.toHaveProperty("scopes_supported");
  });
});

describe("full flow", () => {
  it("connects with a pairing code and reaches the agent with the access token", async () => {
    const { provider } = await connect();
    const res = await initialize(provider.saved!.access_token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agent: "claude" });
    expect(db.select().from(agentOAuthGrants).all()).toHaveLength(1);
  });

  it("keeps static bearer tokens working alongside OAuth", async () => {
    expect((await initialize("static-claude")).status).toBe(200);
    expect((await initialize("static-codex")).status).toBe(401);
  });

  it("rejects an access token on another agent's endpoint", async () => {
    const { provider } = await connect();
    const res = await app.request(`${BASE}/mcp/codex`, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.saved!.access_token}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("refuses a pairing code minted for a different agent than the resource names", async () => {
    const provider = new MemoryProvider();
    const challenge = (await initialize()).headers.get("WWW-Authenticate")!;
    const resourceMetadataUrl = new URL(/resource_metadata="([^"]+)"/.exec(challenge)![1]);
    await auth(provider, { serverUrl: MCP_URL, resourceMetadataUrl, fetchFn });
    const codexCode = store.createPairingCode(codexId).code;

    const res = await approve(provider.authUrl!, codexCode);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("different agent");
    // The code wasn't spent on the mistake.
    expect(store.peekPairingCode(codexCode)).toBe(codexId);
  });

  it("sends access_denied back to the client on Deny", async () => {
    const provider = new MemoryProvider();
    const challenge = (await initialize()).headers.get("WWW-Authenticate")!;
    await auth(provider, { serverUrl: MCP_URL, resourceMetadataUrl: new URL(/resource_metadata="([^"]+)"/.exec(challenge)![1]), fetchFn });
    const res = await approve(provider.authUrl!, "", "deny");
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("revokes the grant when an authorization code is replayed", async () => {
    const { provider, code } = await connect();
    const replay = await app.request(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: provider.verifier,
        redirect_uri: CALLBACK,
        client_id: provider.info!.client_id,
        client_secret: provider.info!.client_secret!,
      }).toString(),
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
    expect((await initialize(provider.saved!.access_token)).status).toBe(401);
  });
});

describe("refresh", () => {
  async function doRefresh(provider: MemoryProvider, refreshToken: string) {
    const metadata = await (await app.request(`${BASE}/.well-known/oauth-authorization-server`)).json();
    return refreshAuthorization(BASE, { metadata: metadata as never, clientInformation: provider.info!, refreshToken, fetchFn });
  }

  it("rotates, replays the same answer to a racing refresh, then refuses the old token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { provider } = await connect();
    const first = provider.saved!;

    const rotated = await doRefresh(provider, first.refresh_token!);
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    // A second worker refreshing with the same old token inside the grace window gets identical tokens.
    expect(await doRefresh(provider, first.refresh_token!)).toEqual(rotated);
    // The old access token isn't cut off mid-request; it simply expires.
    expect((await initialize(first.access_token)).status).toBe(200);
    expect((await initialize(rotated.access_token)).status).toBe(200);

    vi.setSystemTime(Date.now() + REFRESH_GRACE_MS + 1000);
    await expect(doRefresh(provider, first.refresh_token!)).rejects.toThrow();
    // The new refresh token still works.
    expect((await doRefresh(provider, rotated.refresh_token!)).access_token).toBeTruthy();
  });

  it("expires access tokens after their lifetime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { provider } = await connect();
    vi.setSystemTime(Date.now() + ACCESS_TTL_MS + 1000);
    expect((await initialize(provider.saved!.access_token)).status).toBe(401);
  });

  it("answers an unknown client with 401 invalid_client so it re-registers", async () => {
    const res = await app.request(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=x&client_id=gone",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });
});

describe("token endpoint errors", () => {
  it("stay JSON even when the body is rejected before the handler runs", async () => {
    const res = await app.request(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "x=" + "a".repeat(70 * 1024),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("treat malformed Basic credentials as an unknown client", async () => {
    const res = await app.request(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from("%E0%A4%A:x").toString("base64")}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });
});

describe("revocation", () => {
  it("revokes via RFC 7009 and drops the agent's open sessions", async () => {
    const { provider } = await connect();
    const res = await app.request(`${BASE}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: provider.saved!.refresh_token!,
        client_id: provider.info!.client_id,
        client_secret: provider.info!.client_secret!,
      }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await initialize(provider.saved!.access_token)).status).toBe(401);
    expect(dropAgentSessions).toHaveBeenCalledWith(claudeId);
  });
});

describe("client lifetime", () => {
  it("keeps an authorized client registered after its grant is revoked, so it can re-authorize", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { provider } = await connect();
    db.delete(agentOAuthGrants).run();
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    store.prune();
    expect(store.getClient(provider.info!.client_id)).toBeDefined();
  });

  it("drops a registration that never completed a flow after a day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { client } = store.registerClient({ clientName: "drive-by", redirectUris: [CALLBACK], authMethod: "none" });
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    store.prune();
    expect(store.getClient(client.clientId)).toBeUndefined();
  });
});

describe("pairing codes", () => {
  it("are single use and forgiving about case and dashes", () => {
    const { code } = store.createPairingCode(claudeId);
    expect(store.consumePairingCode(code.toLowerCase().replace("-", " "))).toBe(claudeId);
    expect(store.consumePairingCode(code)).toBeNull();
  });

  it("all burn after repeated wrong guesses", () => {
    const { code } = store.createPairingCode(claudeId);
    for (let i = 0; i < 10; i++) store.consumePairingCode("AAAA-AAAA");
    expect(store.consumePairingCode(code)).toBeNull();
  });

  it("expire", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { code } = store.createPairingCode(claudeId);
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(store.consumePairingCode(code)).toBeNull();
  });
});

describe("authorize request validation", () => {
  it("never redirects to a URI the client didn't register", async () => {
    const provider = new MemoryProvider();
    const challenge = (await initialize()).headers.get("WWW-Authenticate")!;
    await auth(provider, { serverUrl: MCP_URL, resourceMetadataUrl: new URL(/resource_metadata="([^"]+)"/.exec(challenge)![1]), fetchFn });
    const url = new URL(provider.authUrl!);
    url.searchParams.set("redirect_uri", "https://evil.example/cb");
    const res = await app.request(url.toString());
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("accepts a loopback callback on any port (RFC 8252)", () => {
    expect(redirectUriMatches("http://localhost/callback", "http://localhost:3118/callback")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1:5000/cb", "http://127.0.0.1:6000/cb")).toBe(true);
    expect(redirectUriMatches("http://localhost/callback", "http://localhost:3118/other")).toBe(false);
    expect(redirectUriMatches("https://claude.ai/cb", "https://claude.ai:444/cb")).toBe(false);
  });

  it("allows https, loopback http and app schemes as redirect URIs", () => {
    expect(isAcceptableRedirectUri(CALLBACK)).toBe(true);
    expect(isAcceptableRedirectUri("http://localhost:3118/callback")).toBe(true);
    expect(isAcceptableRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://192.168.1.10/cb")).toBe(false);
    expect(isAcceptableRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAcceptableRedirectUri("https://claude.ai/cb#frag")).toBe(false);
  });

  it("reads the agent slug from the resource URL path", () => {
    expect(slugFromResource(MCP_URL)).toBe("claude");
    expect(slugFromResource("http://internal:8788/mcp/claude/")).toBe("claude");
    expect(slugFromResource(`${BASE}/mcp/claude/extra`)).toBeNull();
  });
});

describe("admin routes", () => {
  function adminApi() {
    const hub = { sessionCount: () => 0, dropAgentSessions, notifyAgent: () => {} };
    return agentRoutes({ db, hub, agentOAuth: store } as unknown as AppContext);
  }

  it("mints a pairing code for an agent and lists then revokes its grants", async () => {
    const api = adminApi();
    const minted = (await (await api.request(`/${claudeId}/oauth-pairing-code`, { method: "POST" })).json()) as { code: string };
    expect(minted.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(store.peekPairingCode(minted.code)).toBe(claudeId);
    expect((await api.request("/999/oauth-pairing-code", { method: "POST" })).status).toBe(404);

    const { provider } = await connect();
    const listed = (await (await api.request("/")).json()) as { slug: string; oauthGrants: { id: number; clientName: string; redirectHost: string }[] }[];
    const grant = listed.find((a) => a.slug === "claude")!.oauthGrants[0];
    expect(grant).toMatchObject({ clientName: "Claude", redirectHost: "claude.ai" });

    // Another agent's id can't reach this grant.
    expect((await api.request(`/${codexId}/oauth-grants/${grant.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await api.request(`/${claudeId}/oauth-grants/${grant.id}`, { method: "DELETE" })).status).toBe(200);
    expect(dropAgentSessions).toHaveBeenCalledWith(claudeId);
    expect((await initialize(provider.saved!.access_token)).status).toBe(401);
  });
});
