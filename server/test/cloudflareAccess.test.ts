import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import {
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb, type Db } from "../src/db/index.js";
import { agents } from "../src/db/schema.js";
import { RequestLogger } from "../src/core/requestLogger.js";
import { SwitchboardHub } from "../src/core/switchboardHub.js";
import type { AgentServerDeps } from "../src/core/agentServerFactory.js";
import type { UpstreamManager } from "../src/core/upstreamManager.js";
import { createUser, defaultUserId, disableUser, getUserByUsername, setPasswordHash, setUserEmail } from "../src/core/users.js";
import { runCli, type CliIo } from "../src/cli.js";
import { AccessVerifier, normalizeAudTags, normalizeTeamDomain } from "../src/lib/cloudflareAccess.js";
import { encrypt, hashPassword, loadOrCreateKey } from "../src/lib/crypto.js";
import { readLoginMode, writeSetting } from "../src/lib/settings.js";
import { AgentOAuthStore } from "../src/oauth/agentOAuth.js";
import { AdminSessionStore } from "../src/http/adminAuth.js";
import { createApp } from "../src/http/app.js";
import type { AppContext } from "../src/http/context.js";

const TEAM = "https://acme.cloudflareaccess.com";
const AUD = "aud-tag-1";
const ADMIN_EMAIL = "admin@example.com";

let tmp: string;
let db: Db;
let app: Hono;
let hub: SwitchboardHub;
let privateKey: CryptoKey;
let jwk: JWK;

interface TokenOptions {
  email?: string | null;
  aud?: string;
  iss?: string;
  exp?: string | number | null;
  claims?: Record<string, unknown>;
}

/** An Access-shaped application token, signed by the test key unless overridden. */
async function accessToken(opts: TokenOptions = {}, key: CryptoKey = privateKey): Promise<string> {
  const jwt = new SignJWT({
    ...(opts.email === null ? {} : { email: opts.email ?? ADMIN_EMAIL }),
    type: "app",
    ...opts.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setAudience(opts.aud ?? AUD)
    .setIssuer(opts.iss ?? TEAM)
    .setIssuedAt();
  if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? "1h");
  return jwt.sign(key);
}

interface Reply {
  status: number;
  body: any;
  cookie?: string;
  setCookie: string | null;
}

async function call(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const res = await app.request(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    cookie: set?.match(/sb_session=[^;]+/)?.[0],
    setCookie: set,
  };
}

const withToken = (token: string) => ({ "Cf-Access-Jwt-Assertion": token });

/** Puts the instance into Access mode directly, as if the Admin's switch had been accepted. */
function enterCloudflareMode() {
  writeSetting(db, "loginMode", "cloudflare");
  writeSetting(db, "accessTeamDomain", TEAM);
  writeSetting(db, "accessAudTags", JSON.stringify([AUD]));
}

async function setUpAdminSession(): Promise<string> {
  const res = await call("POST", "/api/auth/setup", { password: "admin-pass" });
  expect(res.status).toBe(200);
  return res.cookie!;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-access-"));
  loadOrCreateKey(tmp);
  db = initDb(tmp);
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  setUserEmail(db, defaultUserId(db), ADMIN_EMAIL);

  const deps: AgentServerDeps = {
    db,
    manager: { get: () => undefined } as unknown as UpstreamManager,
    version: "test",
    logger: new RequestLogger(db),
    reconcile: async () => {},
    probe: async () => "none",
  };
  hub = new SwitchboardHub(deps);
  deps.notifyAgent = (agentId, kind) => hub.notifyAgent(agentId, kind);
  app = createApp(
    {
      db,
      hub,
      adminSessions: new AdminSessionStore(db),
      agentOAuth: new AgentOAuthStore(db),
      access: new AccessVerifier({ keysFor: () => createLocalJWKSet({ keys: [jwk] }) }),
    } as unknown as AppContext,
    path.join(tmp, "no-web"),
  );
});

afterEach(async () => {
  await hub.stopAll();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("config normalisation", () => {
  it("accepts a bare team, a hostname or a URL and rejects other hosts", () => {
    for (const input of ["acme", "ACME.cloudflareaccess.com", "https://acme.cloudflareaccess.com/", "http://acme.cloudflareaccess.com/x"]) {
      expect(normalizeTeamDomain(input)).toBe(TEAM);
    }
    for (const input of ["", "https://evil.example.com", "acme.cloudflareaccess.com.evil.com", "ftp://acme.cloudflareaccess.com"]) {
      expect(normalizeTeamDomain(input)).toBeNull();
    }
    expect(normalizeAudTags([" a ", "a", "", "b"])).toEqual(["a", "b"]);
  });
});

describe("verification in Access mode", () => {
  beforeEach(() => enterCloudflareMode());

  it("signs in the user whose email matches, case-insensitively, and creates no session", async () => {
    const token = await accessToken({ email: "ADMIN@Example.com" });
    const me = await call("GET", "/api/auth/me", undefined, withToken(token));
    expect(me.body).toMatchObject({
      authenticated: true,
      loginMode: "cloudflare",
      needsSetup: false,
      user: { username: "admin", role: "admin" },
      access: { teamDomain: TEAM, audTags: [AUD] },
    });
    expect(me.setCookie).toBeNull();
    expect((await call("GET", "/api/servers", undefined, withToken(token))).status).toBe(200);
    expect((await call("GET", "/api/servers")).status).toBe(401);
  });

  it("falls back to the CF_Authorization cookie, preferring the header", async () => {
    const token = await accessToken();
    expect((await call("GET", "/api/servers", undefined, { Cookie: `CF_Authorization=${token}` })).status).toBe(200);
    const bad = await accessToken({ aud: "other" });
    expect((await call("GET", "/api/servers", undefined, { ...withToken(bad), Cookie: `CF_Authorization=${token}` })).status).toBe(401);
  });

  it("does not honour a switchboard session cookie", async () => {
    writeSetting(db, "loginMode", "password");
    const cookie = await setUpAdminSession();
    expect((await call("GET", "/api/servers", undefined, { Cookie: cookie })).status).toBe(200);
    writeSetting(db, "loginMode", "cloudflare");
    expect((await call("GET", "/api/servers", undefined, { Cookie: cookie })).status).toBe(401);
    const me = await call("GET", "/api/auth/me", undefined, { Cookie: cookie });
    expect(me.body).toMatchObject({ authenticated: false, accessError: "no_token" });
  });

  it("refuses tokens for the wrong audience, issuer, expiry, algorithm or identity type", async () => {
    const bad: Record<string, string> = {
      "wrong aud": await accessToken({ aud: "someone-elses-app" }),
      "wrong iss": await accessToken({ iss: "https://other.cloudflareaccess.com" }),
      "no exp": await accessToken({ exp: null }),
      expired: await accessToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
      "signed by another key": await accessToken({}, (await generateKeyPair("RS256")).privateKey),
      HS256: await new SignJWT({ email: ADMIN_EMAIL })
        .setProtectedHeader({ alg: "HS256", kid: "k1" })
        .setAudience(AUD)
        .setIssuer(TEAM)
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode("a-shared-secret-of-sufficient-length")),
      none: new UnsecuredJWT({ email: ADMIN_EMAIL }).setAudience(AUD).setIssuer(TEAM).setExpirationTime("1h").encode(),
      "service token": await accessToken({ email: null, claims: { sub: "", common_name: "abc.access" } }),
      "empty email": await accessToken({ email: "" }),
      garbage: "not-a-jwt",
    };
    for (const [name, token] of Object.entries(bad)) {
      const servers = await call("GET", "/api/servers", undefined, withToken(token));
      expect(servers.status, name).toBe(401);
      const me = await call("GET", "/api/auth/me", undefined, withToken(token));
      expect(me.body, name).toMatchObject({ authenticated: false, accessEmail: null, accessError: "invalid_token" });
    }
  });

  it("accepts a token whose audience is any of the configured tags", async () => {
    writeSetting(db, "accessAudTags", JSON.stringify(["first", AUD]));
    expect((await call("GET", "/api/servers", undefined, withToken(await accessToken()))).status).toBe(200);
  });

  it("ignores a spoofed Cf-Access-Authenticated-User-Email header", async () => {
    const headers = { "Cf-Access-Authenticated-User-Email": ADMIN_EMAIL };
    expect((await call("GET", "/api/servers", undefined, headers)).status).toBe(401);
    const me = await call("GET", "/api/auth/me", undefined, headers);
    expect(me.body).toMatchObject({ authenticated: false, accessEmail: null, accessError: "no_token" });
    // Nor does it override a verified token's email.
    createUser(db, { username: "bob", email: "bob@example.com" });
    const asAdmin = await call("GET", "/api/auth/me", undefined, {
      ...withToken(await accessToken()),
      "Cf-Access-Authenticated-User-Email": "bob@example.com",
    });
    expect(asAdmin.body.user.username).toBe("admin");
  });

  it("reports an unknown email with the email, and a disabled user as disabled", async () => {
    const stranger = await call("GET", "/api/auth/me", undefined, withToken(await accessToken({ email: "who@example.com" })));
    expect(stranger.body).toMatchObject({
      authenticated: false,
      loginMode: "cloudflare",
      accessEmail: "who@example.com",
      accessError: "unknown_email",
      user: null,
    });
    expect((await call("GET", "/api/servers", undefined, withToken(await accessToken({ email: "who@example.com" })))).status).toBe(401);

    const bob = createUser(db, { username: "bob", email: "bob@example.com" });
    const bobToken = await accessToken({ email: "bob@example.com" });
    expect((await call("GET", "/api/servers", undefined, withToken(bobToken))).status).toBe(200);
    disableUser(db, bob.id);
    const me = await call("GET", "/api/auth/me", undefined, withToken(bobToken));
    expect(me.body).toMatchObject({ authenticated: false, accessEmail: "bob@example.com", accessError: "disabled" });
    expect((await call("GET", "/api/servers", undefined, withToken(bobToken))).status).toBe(401);
  });

  it("only shows the Access config to the Admin", async () => {
    createUser(db, { username: "bob", email: "bob@example.com" });
    const me = await call("GET", "/api/auth/me", undefined, withToken(await accessToken({ email: "bob@example.com" })));
    expect(me.body.authenticated).toBe(true);
    expect(me.body).not.toHaveProperty("access");
  });

  it("turns password endpoints away with a clear 400 and logs out through Cloudflare", async () => {
    for (const [url, body] of [
      ["/api/auth/setup", { password: "long-enough-pw" }],
      ["/api/auth/login", { username: "admin", password: "x" }],
      ["/api/auth/setup-code", { username: "admin", code: "abc", password: "long-enough-pw" }],
      ["/api/auth/change-password", { newPassword: "long-enough-pw" }],
    ] as const) {
      const res = await call("POST", url, body, withToken(await accessToken()));
      expect(res.status, url).toBe(400);
      expect(res.body.error, url).toMatch(/Password login is off/);
      expect(res.setCookie, url).toBeNull();
    }
    const out = await call("POST", "/api/auth/logout", undefined, withToken(await accessToken()));
    expect(out.body).toEqual({ ok: true, redirect: "/cdn-cgi/access/logout" });
    expect(out.setCookie).toBeNull();
  });
});

describe("switching modes", () => {
  const config = { loginMode: "cloudflare", accessTeamDomain: "acme", accessAudTags: [AUD] };

  it("refuses to switch to Access without the Admin's own valid token under the new config", async () => {
    const cookie = await setUpAdminSession();
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      call("POST", "/api/auth/settings", body, { Cookie: cookie, ...headers });
    const refused = async (res: Promise<Reply>, message: RegExp) => {
      const r = await res;
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(message);
      expect(readLoginMode(db)).toBe("password");
    };

    await refused(post(config), /no Cloudflare Access token/);
    await refused(post(config, withToken(await accessToken({ aud: "other" }))), /isn't valid/);
    await refused(post(config, withToken(await accessToken({ email: "bob@example.com" }))), /Access sees you as bob@example.com/);
    await refused(post({ ...config, accessAudTags: [] }, withToken(await accessToken())), /AUD tag/);
    await refused(post({ ...config, accessTeamDomain: "evil.example.com" }, withToken(await accessToken())), /team domain/);

    // The token is checked under the NEW config, not whatever was saved before.
    await refused(post({ ...config, accessAudTags: ["brand-new"] }, withToken(await accessToken())), /isn't valid/);

    setUserEmail(db, defaultUserId(db), null);
    await refused(post(config, withToken(await accessToken())), /Set your own email/);
    setUserEmail(db, defaultUserId(db), ADMIN_EMAIL);

    // Still fully usable in password mode.
    expect((await call("GET", "/api/servers", undefined, { Cookie: cookie })).status).toBe(200);
  });

  it("accepts the switch with the Admin's own token, then drops sessions and honours only Access", async () => {
    const cookie = await setUpAdminSession();
    const token = await accessToken();
    const res = await call("POST", "/api/auth/settings", config, { Cookie: cookie, ...withToken(token) });
    expect(res.status).toBe(200);
    expect(readLoginMode(db)).toBe("cloudflare");

    expect((await call("GET", "/api/servers", undefined, { Cookie: cookie })).status).toBe(401);
    const me = await call("GET", "/api/auth/me", undefined, withToken(token));
    expect(me.body).toMatchObject({ authenticated: true, access: { teamDomain: TEAM, audTags: [AUD] } });
    // Back in password mode the old cookie must not have come back to life.
    writeSetting(db, "loginMode", "password");
    expect((await call("GET", "/api/servers", undefined, { Cookie: cookie })).status).toBe(401);
  });

  it("re-checks the token when the config changes inside Access mode, and lets non-Admins out", async () => {
    enterCloudflareMode();
    const token = await accessToken();
    const change = { accessAudTags: [AUD, "second-app"] };
    expect((await call("POST", "/api/auth/settings", change, withToken(token))).status).toBe(200);
    expect((await call("GET", "/api/auth/me", undefined, withToken(token))).body.access.audTags).toEqual([AUD, "second-app"]);

    const wrongAud = await call("POST", "/api/auth/settings", { accessAudTags: ["typo"] }, withToken(token));
    expect(wrongAud.status).toBe(400);
    expect((await call("GET", "/api/servers", undefined, withToken(token))).status).toBe(200);

    createUser(db, { username: "bob", email: "bob@example.com" });
    const bobToken = await accessToken({ email: "bob@example.com" });
    const asBob = await call("POST", "/api/auth/settings", { loginMode: "password" }, withToken(bobToken));
    expect(asBob.status).toBe(403);
  });

  it("lets the Admin switch back to password mode from Access mode and stay signed in", async () => {
    setPasswordHash(db, defaultUserId(db), hashPassword("admin-pass"));
    enterCloudflareMode();
    const res = await call("POST", "/api/auth/settings", { loginMode: "password" }, withToken(await accessToken()));
    expect(res.status).toBe(200);
    expect(readLoginMode(db)).toBe("password");
    expect(res.cookie).toBeDefined();
    expect((await call("GET", "/api/servers", undefined, { Cookie: res.cookie! })).status).toBe(200);
  });

  it("cannot be used to claim the Admin after an Access round-trip on a passwordless install", async () => {
    const token = withToken(await accessToken());
    // A legacy install already in Access mode (Default user never set a password) can't walk back
    // to a state where anyone reaching the login page could claim the Admin.
    enterCloudflareMode();
    const back = await call("POST", "/api/auth/settings", { loginMode: "password" }, token);
    expect(back.status).toBe(400);
    expect(back.body.error).toMatch(/Set a password for admin/);
    expect(readLoginMode(db)).toBe("cloudflare");
  });

  it("never offers first-run setup once there is more than one user", async () => {
    createUser(db, { username: "bob" });
    expect((await call("GET", "/api/auth/me")).body.needsSetup).toBe(false);
    const claim = await call("POST", "/api/auth/setup", { password: "attacker-pass" });
    expect(claim.status).toBe(409);
    expect(getUserByUsername(db, "admin")!.passwordHash).toBeNull();
  });

  it("keeps Access config as a draft while in password mode", async () => {
    const cookie = await setUpAdminSession();
    const res = await call("POST", "/api/auth/settings", { accessTeamDomain: "acme", accessAudTags: [AUD] }, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(readLoginMode(db)).toBe("password");
    const me = await call("GET", "/api/auth/me", undefined, { Cookie: cookie });
    expect(me.body).toMatchObject({ loginMode: "password", access: { teamDomain: TEAM, audTags: [AUD] } });
  });

  it("logout in password mode reports no redirect", async () => {
    const cookie = await setUpAdminSession();
    const out = await call("POST", "/api/auth/logout", undefined, { Cookie: cookie });
    expect(out.body).toEqual({ ok: true, redirect: null });
  });
});

describe("lockout recovery", () => {
  it("`login-mode password` restores password login from Access mode", async () => {
    await setUpAdminSession();
    enterCloudflareMode();
    expect((await call("POST", "/api/auth/login", { username: "admin", password: "admin-pass" })).status).toBe(400);

    const io: CliIo = {
      out: () => {},
      err: () => {},
      interactive: false,
      promptHidden: async () => "",
      readStdin: async () => "",
      openDb: () => db,
      closeDb: () => {},
    };
    expect(await runCli(["login-mode", "password"], io)).toBe(0);

    const login = await call("POST", "/api/auth/login", { username: "admin", password: "admin-pass" });
    expect(login.status).toBe(200);
    expect((await call("GET", "/api/servers", undefined, { Cookie: login.cookie! })).status).toBe(200);
  });
});

describe("agent paths never look at Access", () => {
  const initialize = (headers: Record<string, string>) =>
    app.request("http://localhost/mcp/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });

  beforeEach(() => {
    enterCloudflareMode();
    db.insert(agents)
      .values({ userId: defaultUserId(db), slug: "claude", name: "claude", tokenEnc: encrypt("agent-token"), createdAt: Date.now() })
      .run();
  });

  it("an Access JWT is no credential on /mcp and does not disturb a bearer token", async () => {
    const jwt = await accessToken();
    expect((await initialize(withToken(jwt))).status).toBe(401);
    expect((await initialize({ ...withToken(jwt), Cookie: `CF_Authorization=${jwt}` })).status).toBe(401);
    expect((await initialize({ ...withToken(jwt), Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await initialize({ Authorization: "Bearer agent-token" })).status).toBe(200);
    expect((await initialize({ ...withToken(jwt), Authorization: "Bearer agent-token" })).status).toBe(200);
    expect((await initialize({ ...withToken("garbage"), Authorization: "Bearer agent-token" })).status).toBe(200);
  });
});
