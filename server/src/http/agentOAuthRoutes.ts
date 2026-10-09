import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { eq } from "drizzle-orm";
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Db } from "../db/index.js";
import { agents, type AgentOAuthClientRow, type AgentRow } from "../db/schema.js";
import { AgentOAuthStore, type TokenEndpointAuthMethod } from "../oauth/agentOAuth.js";
import { renderConsentPage, renderErrorPage } from "../oauth/consentPage.js";

/**
 * The switchboard as an OAuth 2.1 authorization server for its own agent endpoints, so clients that
 * can only do OAuth (Claude Desktop / claude.ai connectors) can reach `/mcp/<slug>`. Approval is a
 * one-time pairing code minted in the admin UI and typed on the consent page: it proves the admin
 * started the connection, names the agent, and keeps both the admin password and the agent's
 * long-lived token off a page that anyone can link to.
 *
 * Mounted next to `/mcp` — on the MCP listener when `MCP_PORT` splits them — because the token
 * endpoint is called from the client's servers and must be as reachable as the MCP endpoint is.
 */

export interface AgentOAuthDeps {
  db: Db;
  store: AgentOAuthStore;
  /** Explicit public origin (MCP_PUBLIC_URL); null = derive from each request. */
  publicUrl: string | null;
  /** PUBLIC_URL, consulted only to settle the scheme of a request for its host (see oauthBaseUrl). */
  uiPublicUrl?: string;
  /** A grant was revoked: its open SSE streams outlive per-request auth, so drop the agent's sessions. */
  onGrantRevoked?: (agentId: number) => void;
}

/** First value of a possibly comma-joined proxy header. */
function firstHeader(req: Request, name: string): string | undefined {
  return req.headers.get(name)?.split(",")[0]?.trim() || undefined;
}

/**
 * Origin the client reached us at. Behind a tunnel the request arrives as plain HTTP for an internal
 * host, so the forwarded headers are what match the URL the user pasted into their client.
 *
 * Chained proxies can still get the scheme wrong: Cloudflare → Caddy over plain HTTP reaches us as
 * `X-Forwarded-Proto: http`, because Caddy reports its own hop. An https PUBLIC_URL for the same host
 * settles it — the admin already told us that host is served over TLS.
 */
export function oauthBaseUrl(req: Request, publicUrl: string | null, uiPublicUrl?: string): string {
  if (publicUrl) return publicUrl;
  const url = new URL(req.url);
  const proto = firstHeader(req, "x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  const host = firstHeader(req, "x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  if (uiPublicUrl?.startsWith("https://") && sameHost(uiPublicUrl, host)) return uiPublicUrl;
  return `${proto}://${host}`;
}

function sameHost(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === new URL(`https://${host}`).host;
  } catch {
    return false;
  }
}

export function resourceMetadataUrl(base: string, slug: string): string {
  return `${base}/.well-known/oauth-protected-resource/mcp/${slug}`;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "ftp:", "ws:", "wss:"]);

/** https anywhere, http only on loopback, or an app's private-use scheme (cursor://…). No fragments. */
export function isAcceptableRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (raw.includes("#")) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return !FORBIDDEN_SCHEMES.has(url.protocol);
}

/**
 * Exact match, except that a loopback redirect may come back on any port (RFC 8252 §7.3): native
 * clients pick a free port each time they listen for the callback.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  try {
    const a = new URL(registered);
    const b = new URL(presented);
    if (a.protocol !== "http:" || !LOOPBACK_HOSTS.has(a.hostname)) return false;
    return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

/** `<anything>/mcp/<slug>` → slug. The origin isn't compared: behind a proxy it is ours to guess. */
export function slugFromResource(resource: string): string | null {
  try {
    const match = /^\/mcp\/([a-z0-9-]{1,64})\/?$/.exec(new URL(resource).pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function oauthError(c: Context, status: 400 | 401, error: string, description?: string): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (status === 401 && c.req.header("Authorization")?.startsWith("Basic ")) headers["WWW-Authenticate"] = "Basic";
  return c.json({ error, ...(description ? { error_description: description } : {}) }, status, headers);
}

/** Client credentials from HTTP Basic (RFC 6749 §2.3.1) or the request body. */
function clientCredentials(c: Context, body: Record<string, string>): { clientId?: string; secret?: string } {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep >= 0) {
      try {
        return {
          clientId: decodeURIComponent(decoded.slice(0, sep)),
          secret: decodeURIComponent(decoded.slice(sep + 1)),
        };
      } catch {
        return {}; // malformed percent-encoding → treated as no credentials → invalid_client
      }
    }
  }
  return { clientId: body.client_id, secret: body.client_secret };
}

/** Token and revocation requests are form-encoded by spec; accept JSON too for lenient clients. */
async function readParams(c: Context): Promise<Record<string, string>> {
  const type = c.req.header("Content-Type") ?? "";
  const raw: Record<string, unknown> = type.includes("application/json")
    ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    : await c.req.parseBody().catch(() => ({}));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

type AuthorizeCheck =
  /** Not safe to redirect: the client or its redirect URI couldn't be verified. */
  | { kind: "page"; message: string }
  /** Redirect the error back to the client. */
  | { kind: "redirect"; redirectUri: string; error: string; description: string; state?: string }
  | {
      kind: "ok";
      client: AgentOAuthClientRow;
      redirectUri: string;
      codeChallenge: string;
      state?: string;
      scope: string | null;
      resource: string | null;
      /** Agent named by `resource`, when the client sent one. */
      agent: AgentRow | null;
      params: Record<string, string>;
    };

export function agentOAuthRoutes(deps: AgentOAuthDeps): Hono {
  const { db, store } = deps;
  const app = new Hono();
  const base = (c: Context) => oauthBaseUrl(c.req.raw, deps.publicUrl, deps.uiPublicUrl);

  // Browser-based clients (MCP Inspector) call these cross-origin. No cookies are involved, so `*`.
  const publicCors = cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "MCP-Protocol-Version"] });
  app.use("/.well-known/*", publicCors);
  app.use("/oauth/register", publicCors);
  app.use("/oauth/token", publicCors);
  app.use("/oauth/revoke", publicCors);
  app.use(
    "/oauth/*",
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "invalid_request", error_description: "Request body too large" }, 413) }),
  );
  // A non-JSON error from the token endpoint makes SDK clients abandon refresh and start a whole new
  // authorization — i.e. ask the user to approve again. Nothing here should throw, but if it does,
  // fail in OAuth's format.
  app.onError((err, c) => {
    console.error("[agent-oauth]", err);
    return c.json({ error: "server_error", error_description: "Internal error" }, 500, { "Cache-Control": "no-store" });
  });

  /* ---------- discovery ---------- */

  // RFC 9728, path-suffixed form: the 401 from /mcp/<slug> points clients straight here.
  app.get("/.well-known/oauth-protected-resource/mcp/:slug", (c) => {
    const slug = c.req.param("slug");
    const agent = db.select().from(agents).where(eq(agents.slug, slug)).get();
    if (!agent) return c.json({ error: "Unknown agent" }, 404);
    const b = base(c);
    return c.json({
      resource: `${b}/mcp/${slug}`,
      authorization_servers: [b],
      bearer_methods_supported: ["header"],
      resource_name: `MCP Switchboard — ${agent.name}`,
    });
  });

  // RFC 8414. The issuer is the bare origin, so this root path is where every client looks.
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const b = base(c);
    return c.json({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      revocation_endpoint: `${b}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  /* ---------- dynamic client registration (RFC 7591) ---------- */

  app.post("/oauth/register", async (c) => {
    const parsed = OAuthClientMetadataSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_client_metadata", error_description: parsed.error.issues[0]?.message ?? "Invalid metadata" }, 400);
    }
    const meta = parsed.data;
    if (meta.redirect_uris.length === 0 || meta.redirect_uris.length > 10) {
      return c.json({ error: "invalid_redirect_uri", error_description: "Register between 1 and 10 redirect URIs" }, 400);
    }
    const badUri = meta.redirect_uris.find((u) => u.length > 2000 || !isAcceptableRedirectUri(u));
    if (badUri !== undefined) {
      return c.json(
        { error: "invalid_redirect_uri", error_description: `Redirect URIs must be https, loopback http, or an app scheme: ${badUri}` },
        400,
      );
    }
    // RFC 7591 §2: an omitted method means client_secret_basic.
    const method = (meta.token_endpoint_auth_method ?? "client_secret_basic") as TokenEndpointAuthMethod;
    if (!["none", "client_secret_basic", "client_secret_post"].includes(method)) {
      return c.json({ error: "invalid_client_metadata", error_description: `Unsupported token_endpoint_auth_method: ${method}` }, 400);
    }
    if (meta.response_types && meta.response_types.some((t) => t !== "code")) {
      return c.json({ error: "invalid_client_metadata", error_description: "Only response_type 'code' is supported" }, 400);
    }
    const clientName = meta.client_name ? meta.client_name.slice(0, 200) : null;
    const { client, clientSecret } = store.registerClient({ clientName, redirectUris: meta.redirect_uris, authMethod: method });
    return c.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
        client_name: clientName ?? undefined,
        redirect_uris: meta.redirect_uris,
        token_endpoint_auth_method: method,
        grant_types: meta.grant_types ?? ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(meta.scope ? { scope: meta.scope } : {}),
      },
      201,
      { "Cache-Control": "no-store" },
    );
  });

  /* ---------- authorization ---------- */

  function checkAuthorize(params: Record<string, string>): AuthorizeCheck {
    const client = params.client_id ? store.getClient(params.client_id) : undefined;
    if (!client) {
      return { kind: "page", message: "Unknown client. Remove the connector from your client and add it again." };
    }
    const registered = JSON.parse(client.redirectUrisJson) as string[];
    let redirectUri: string;
    if (params.redirect_uri) {
      if (!registered.some((r) => redirectUriMatches(r, params.redirect_uri))) {
        return { kind: "page", message: "The redirect URI does not match the one this client registered." };
      }
      redirectUri = params.redirect_uri;
    } else if (registered.length === 1) {
      redirectUri = registered[0];
    } else {
      return { kind: "page", message: "Missing redirect_uri." };
    }

    const state = params.state || undefined;
    const fail = (error: string, description: string): AuthorizeCheck => ({ kind: "redirect", redirectUri, error, description, state });
    if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
    if (!params.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge)) {
      return fail("invalid_request", "A PKCE code_challenge is required");
    }
    if (params.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256");

    let agent: AgentRow | null = null;
    if (params.resource) {
      const slug = slugFromResource(params.resource);
      agent = slug ? (db.select().from(agents).where(eq(agents.slug, slug)).get() ?? null) : null;
      if (!agent) return fail("invalid_target", "resource must be a switchboard agent endpoint (/mcp/<agent-slug>)");
    }

    const echoed: Record<string, string> = {};
    for (const key of AUTHORIZE_PARAMS) if (params[key]) echoed[key] = params[key];
    if (!echoed.redirect_uri) echoed.redirect_uri = redirectUri;

    return {
      kind: "ok",
      client,
      redirectUri,
      codeChallenge: params.code_challenge,
      state,
      scope: params.scope || null,
      resource: params.resource || null,
      agent,
      params: echoed,
    };
  }

  const redirectTo = (c: Context, redirectUri: string, query: Record<string, string | undefined>, status: 302 | 303) => {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set("iss", base(c));
    return c.redirect(url.toString(), status);
  };

  const htmlHeaders = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };

  const consent = (c: Context, check: Extract<AuthorizeCheck, { kind: "ok" }>, error?: string) =>
    c.html(
      renderConsentPage({
        clientName: check.client.clientName,
        redirectHost: new URL(check.redirectUri).host || check.redirectUri,
        redirectIsLoopback: LOOPBACK_HOSTS.has(new URL(check.redirectUri).hostname),
        agentSlug: check.agent?.slug ?? null,
        params: check.params,
        error,
      }),
      error ? 400 : 200,
      htmlHeaders,
    );

  app.get("/oauth/authorize", (c) => {
    const check = checkAuthorize(c.req.query());
    if (check.kind === "page") return c.html(renderErrorPage(check.message), 400, htmlHeaders);
    if (check.kind === "redirect") {
      return redirectTo(c, check.redirectUri, { error: check.error, error_description: check.description, state: check.state }, 302);
    }
    return consent(c, check);
  });

  app.post("/oauth/authorize", async (c) => {
    const body = await readParams(c);
    const check = checkAuthorize(body);
    if (check.kind === "page") return c.html(renderErrorPage(check.message), 400, htmlHeaders);
    if (check.kind === "redirect") {
      return redirectTo(c, check.redirectUri, { error: check.error, error_description: check.description, state: check.state }, 303);
    }
    if (body.decision !== "approve") {
      return redirectTo(c, check.redirectUri, { error: "access_denied", state: check.state }, 303);
    }

    const pairingCode = body.pairing_code ?? "";
    const pairedAgentId = store.peekPairingCode(pairingCode);
    if (pairedAgentId === null) {
      store.consumePairingCode(pairingCode); // counts the miss towards burning outstanding codes
      return consent(c, check, "That pairing code is wrong or has expired. Generate a new one on the Agents page.");
    }
    if (check.agent && check.agent.id !== pairedAgentId) {
      return consent(c, check, `That pairing code is for a different agent — this connection is for "${check.agent.slug}".`);
    }
    store.consumePairingCode(pairingCode);

    const code = store.createCode({
      clientId: check.client.clientId,
      agentId: pairedAgentId,
      redirectUri: check.redirectUri,
      codeChallenge: check.codeChallenge,
      scope: check.scope,
      resource: check.resource,
    });
    return redirectTo(c, check.redirectUri, { code, state: check.state }, 303);
  });

  /* ---------- token ---------- */

  app.post("/oauth/token", async (c) => {
    const body = await readParams(c);
    const { clientId, secret } = clientCredentials(c, body);
    // invalid_client makes clients like Claude drop their registration and register again.
    const client = clientId ? store.authenticateClient(clientId, secret) : null;
    if (!client) return oauthError(c, 401, "invalid_client", "Unknown client or bad client credentials");
    store.prune();

    if (body.grant_type === "authorization_code") {
      if (!body.code || !body.code_verifier) return oauthError(c, 400, "invalid_request", "code and code_verifier are required");
      const result = store.exchangeCode({
        code: body.code,
        client,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
        resource: body.resource,
      });
      if (!result.ok) {
        return oauthError(c, 400, result.error === "resource mismatch" ? "invalid_target" : "invalid_grant", result.error);
      }
      return c.json(result.value, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
    }

    if (body.grant_type === "refresh_token") {
      if (!body.refresh_token) return oauthError(c, 400, "invalid_request", "refresh_token is required");
      const result = store.refresh({ refreshToken: body.refresh_token, client });
      if (!result.ok) return oauthError(c, 400, "invalid_grant", result.error);
      return c.json(result.value, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
    }

    return oauthError(c, 400, "unsupported_grant_type", "Supported: authorization_code, refresh_token");
  });

  /* ---------- revocation (RFC 7009) ---------- */

  app.post("/oauth/revoke", async (c) => {
    const body = await readParams(c);
    const { clientId, secret } = clientCredentials(c, body);
    const client = clientId ? store.authenticateClient(clientId, secret) : null;
    if (!client) return oauthError(c, 401, "invalid_client");
    const revoked = body.token ? store.revoke(body.token, client) : null;
    if (revoked) deps.onGrantRevoked?.(revoked.agentId);
    // Unknown tokens get a 200 too, so revocation can't be used to probe for valid ones.
    return c.body(null, 200);
  });

  return app;
}
