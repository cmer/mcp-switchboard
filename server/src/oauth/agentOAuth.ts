import crypto from "node:crypto";
import { and, count, eq, gt, isNull, lt, notExists } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  agentOAuthClients,
  agentOAuthCodes,
  agentOAuthGrants,
  agentOAuthTokens,
  type AgentOAuthClientRow,
  type AgentOAuthGrantRow,
} from "../db/schema.js";
import { decrypt, encrypt, timingSafeEqualStr } from "../lib/crypto.js";

/**
 * Token store for the agent-facing authorization server. Everything here is synchronous SQLite;
 * the HTTP layer (agentOAuthRoutes.ts) does parameter validation and protocol framing.
 */

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/**
 * How long a just-rotated refresh token keeps working. Claude refreshes proactively and again after
 * any 401, possibly from several workers at once; strict one-shot rotation would turn that race into
 * a dead connection and a fresh consent.
 */
export const REFRESH_GRACE_MS = 60 * 1000;
/** A registration nobody completed an authorization with is dropped after this long. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Registration is open to the internet; past this many clients the oldest unused ones go first. */
const MAX_CLIENTS = 500;
/** `last_used_at` is cosmetic — don't write it on every request. */
const LAST_USED_RESOLUTION_MS = 60 * 1000;
/**
 * Pairing codes are short enough to type, so guessing is bounded instead: this many wrong codes
 * burns every outstanding one. A 40-bit code with 10 tries is out of reach; the cost of an attacker
 * spamming wrong codes is that you generate a new one.
 */
const MAX_PAIRING_FAILURES = 10;
/** No 0/O or 1/I: codes are read off one screen and typed into another. */
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const ACCESS_PREFIX = "sb-at-";
const REFRESH_PREFIX = "sb-rt-";

export type TokenEndpointAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function randomSecret(prefix = ""): string {
  return prefix + crypto.randomBytes(32).toString("base64url");
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))) == code_challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  return timingSafeEqualStr(sha256(verifier), challenge);
}

/** Case, spaces and dashes don't matter when typing a pairing code back. */
function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export class AgentOAuthStore {
  /**
   * Pairing codes: minted in the admin UI, typed on the consent page, which may be on a different
   * origin with no admin session. In memory on purpose — they live ten minutes and the admin UI and
   * the MCP listener share this process.
   */
  private pairing = new Map<string, { agentId: number; expiresAt: number }>();
  private pairingFailures = 0;

  constructor(private db: Db) {}

  /* ---------- pairing codes ---------- */

  createPairingCode(agentId: number): { code: string; expiresAt: number } {
    const bytes = crypto.randomBytes(8);
    const raw = Array.from(bytes, (b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join("");
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pairing.set(sha256(raw), { agentId, expiresAt });
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  /** The agent a pairing code was minted for, without spending it. */
  peekPairingCode(code: string): number | null {
    this.prunePairing();
    return this.pairing.get(sha256(normalizePairingCode(code)))?.agentId ?? null;
  }

  /** Spend a pairing code. A miss counts towards burning all outstanding codes. */
  consumePairingCode(code: string): number | null {
    this.prunePairing();
    const key = sha256(normalizePairingCode(code));
    const entry = this.pairing.get(key);
    if (!entry) {
      if (++this.pairingFailures >= MAX_PAIRING_FAILURES) {
        this.pairing.clear();
        this.pairingFailures = 0;
      }
      return null;
    }
    this.pairing.delete(key);
    return entry.agentId;
  }

  private prunePairing(): void {
    const now = Date.now();
    for (const [key, entry] of this.pairing) if (entry.expiresAt < now) this.pairing.delete(key);
    if (this.pairing.size === 0) this.pairingFailures = 0;
  }

  /* ---------- clients ---------- */

  registerClient(input: {
    clientName: string | null;
    redirectUris: string[];
    authMethod: TokenEndpointAuthMethod;
  }): { client: AgentOAuthClientRow; clientSecret: string | null } {
    this.prune();
    const clientSecret = input.authMethod === "none" ? null : randomSecret();
    const client = this.db
      .insert(agentOAuthClients)
      .values({
        clientId: crypto.randomUUID(),
        clientSecretHash: clientSecret ? sha256(clientSecret) : null,
        clientName: input.clientName,
        redirectUrisJson: JSON.stringify(input.redirectUris),
        tokenEndpointAuthMethod: input.authMethod,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    this.evictOverflow();
    return { client, clientSecret };
  }

  getClient(clientId: string): AgentOAuthClientRow | undefined {
    return this.db.select().from(agentOAuthClients).where(eq(agentOAuthClients.clientId, clientId)).get();
  }

  /** A client registered with a secret must present it; a public client needs none. */
  authenticateClient(clientId: string, secret: string | undefined): AgentOAuthClientRow | null {
    const client = this.getClient(clientId);
    if (!client) return null;
    if (client.clientSecretHash === null) return client;
    if (secret === undefined || !timingSafeEqualStr(sha256(secret), client.clientSecretHash)) return null;
    return client;
  }

  /* ---------- authorization codes ---------- */

  createCode(input: {
    clientId: string;
    agentId: number;
    redirectUri: string;
    codeChallenge: string;
    scope: string | null;
    resource: string | null;
  }): string {
    const code = randomSecret();
    this.db
      .insert(agentOAuthCodes)
      .values({ codeHash: sha256(code), ...input, expiresAt: Date.now() + CODE_TTL_MS })
      .run();
    return code;
  }

  /**
   * Redeem a code for a new grant. A code presented twice means it leaked (RFC 6749 §4.1.2), so the
   * grant it already produced is revoked along with the refusal.
   */
  exchangeCode(input: {
    code: string;
    client: AgentOAuthClientRow;
    redirectUri: string | undefined;
    codeVerifier: string;
    resource: string | undefined;
  }): Result<TokenResponse> {
    return this.db.transaction((tx): Result<TokenResponse> => {
      const row = tx.select().from(agentOAuthCodes).where(eq(agentOAuthCodes.codeHash, sha256(input.code))).get();
      if (!row || row.clientId !== input.client.clientId) return { ok: false, error: "unknown code" };
      if (row.usedAt !== null) {
        if (row.grantId !== null) tx.delete(agentOAuthGrants).where(eq(agentOAuthGrants.id, row.grantId)).run();
        return { ok: false, error: "code already used" };
      }
      if (row.expiresAt < Date.now()) return { ok: false, error: "code expired" };
      // OAuth 2.1 requires redirect_uri at the token endpoint only when authorize had one; we always
      // stored one, so a client that sends it must send the same one.
      if (input.redirectUri !== undefined && row.redirectUri !== input.redirectUri) {
        return { ok: false, error: "redirect_uri mismatch" };
      }
      if (input.resource !== undefined && row.resource !== null && input.resource !== row.resource) {
        return { ok: false, error: "resource mismatch" };
      }
      if (!verifyPkce(input.codeVerifier, row.codeChallenge)) return { ok: false, error: "PKCE verification failed" };

      const now = Date.now();
      const grant = tx
        .insert(agentOAuthGrants)
        .values({ clientId: row.clientId, agentId: row.agentId, scope: row.scope, resource: row.resource, createdAt: now })
        .returning()
        .get();
      const tokens = issueTokens(tx, grant.id, row.scope, now);
      tx.update(agentOAuthCodes).set({ usedAt: now, grantId: grant.id }).where(eq(agentOAuthCodes.codeHash, row.codeHash)).run();
      if (input.client.authorizedAt === null) {
        tx.update(agentOAuthClients).set({ authorizedAt: now }).where(eq(agentOAuthClients.clientId, row.clientId)).run();
      }
      return { ok: true, value: tokens };
    });
  }

  /* ---------- refresh ---------- */

  refresh(input: { refreshToken: string; client: AgentOAuthClientRow }): Result<TokenResponse> {
    const hash = sha256(input.refreshToken);
    const now = Date.now();
    return this.db.transaction((tx): Result<TokenResponse> => {
      const found = tx
        .select({ token: agentOAuthTokens, grant: agentOAuthGrants })
        .from(agentOAuthTokens)
        .innerJoin(agentOAuthGrants, eq(agentOAuthGrants.id, agentOAuthTokens.grantId))
        .where(and(eq(agentOAuthTokens.tokenHash, hash), eq(agentOAuthTokens.kind, "refresh")))
        .get();
      if (!found || found.token.expiresAt < now) return { ok: false, error: "unknown or expired refresh token" };
      const { token, grant } = found;
      if (grant.clientId !== input.client.clientId) return { ok: false, error: "refresh token belongs to another client" };

      // Already rotated, still inside the grace window: a concurrent refresh lost the race. Hand it
      // the same tokens the winner got, so neither ends up holding tokens the other invalidated.
      if (token.rotatedAt !== null) {
        if (!grant.lastResponseEnc) return { ok: false, error: "refresh token already used" };
        return { ok: true, value: JSON.parse(decrypt(grant.lastResponseEnc)) as TokenResponse };
      }

      // The old access token is left to expire on its own: another worker may be mid-request with it.
      tx.update(agentOAuthTokens)
        .set({ rotatedAt: now, expiresAt: now + REFRESH_GRACE_MS })
        .where(eq(agentOAuthTokens.tokenHash, hash))
        .run();
      return { ok: true, value: issueTokens(tx, grant.id, grant.scope, now) };
    });
  }

  /* ---------- resource-server side ---------- */

  /** The live grant an access token belongs to, or null when it is unknown or expired. */
  verifyAccessToken(token: string): AgentOAuthGrantRow | null {
    if (!token.startsWith(ACCESS_PREFIX)) return null;
    const now = Date.now();
    const found = this.db
      .select({ grant: agentOAuthGrants, expiresAt: agentOAuthTokens.expiresAt })
      .from(agentOAuthTokens)
      .innerJoin(agentOAuthGrants, eq(agentOAuthGrants.id, agentOAuthTokens.grantId))
      .where(and(eq(agentOAuthTokens.tokenHash, sha256(token)), eq(agentOAuthTokens.kind, "access")))
      .get();
    if (!found || found.expiresAt < now) return null;
    const { grant } = found;
    if (grant.lastUsedAt === null || now - grant.lastUsedAt > LAST_USED_RESOLUTION_MS) {
      this.db.update(agentOAuthGrants).set({ lastUsedAt: now }).where(eq(agentOAuthGrants.id, grant.id)).run();
    }
    return grant;
  }

  /**
   * RFC 7009: revoke the grant behind an access or refresh token, if it belongs to this client.
   * Returns the revoked grant so the caller can drop the sessions it opened.
   */
  revoke(token: string, client: AgentOAuthClientRow): AgentOAuthGrantRow | null {
    const found = this.db
      .select({ grant: agentOAuthGrants })
      .from(agentOAuthTokens)
      .innerJoin(agentOAuthGrants, eq(agentOAuthGrants.id, agentOAuthTokens.grantId))
      .where(eq(agentOAuthTokens.tokenHash, sha256(token)))
      .get();
    if (!found || found.grant.clientId !== client.clientId) return null;
    this.db.delete(agentOAuthGrants).where(eq(agentOAuthGrants.id, found.grant.id)).run();
    return found.grant;
  }

  /* ---------- housekeeping ---------- */

  prune(): void {
    const now = Date.now();
    this.db.delete(agentOAuthCodes).where(lt(agentOAuthCodes.expiresAt, now)).run();
    this.db.delete(agentOAuthTokens).where(lt(agentOAuthTokens.expiresAt, now)).run();
    // A grant whose last refresh token expired can never be used again.
    this.db
      .delete(agentOAuthGrants)
      .where(
        notExists(
          this.db
            .select()
            .from(agentOAuthTokens)
            .where(and(eq(agentOAuthTokens.grantId, agentOAuthGrants.id), eq(agentOAuthTokens.kind, "refresh"))),
        ),
      )
      .run();
    this.db
      .delete(agentOAuthClients)
      .where(and(lt(agentOAuthClients.createdAt, now - UNUSED_CLIENT_TTL_MS), this.unused()))
      .run();
  }

  /** Clients that never completed an authorization and have none in flight. */
  private unused() {
    return and(
      isNull(agentOAuthClients.authorizedAt),
      notExists(
        this.db.select().from(agentOAuthGrants).where(eq(agentOAuthGrants.clientId, agentOAuthClients.clientId)),
      ),
      notExists(
        this.db
          .select()
          .from(agentOAuthCodes)
          .where(
            and(
              eq(agentOAuthCodes.clientId, agentOAuthClients.clientId),
              isNull(agentOAuthCodes.usedAt),
              gt(agentOAuthCodes.expiresAt, Date.now()),
            ),
          ),
      ),
    );
  }

  /** Keep a registration flood from growing the table without bound; authorized clients never go. */
  private evictOverflow(): void {
    const total = this.db.select({ n: count() }).from(agentOAuthClients).get()?.n ?? 0;
    if (total <= MAX_CLIENTS) return;
    const victims = this.db
      .select({ clientId: agentOAuthClients.clientId })
      .from(agentOAuthClients)
      .where(this.unused())
      .orderBy(agentOAuthClients.createdAt)
      .limit(total - MAX_CLIENTS)
      .all();
    for (const v of victims) this.db.delete(agentOAuthClients).where(eq(agentOAuthClients.clientId, v.clientId)).run();
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Mint an access/refresh pair for a grant and remember the response for grace-window replays. */
function issueTokens(tx: Tx, grantId: number, scope: string | null, now: number): TokenResponse {
  const access = randomSecret(ACCESS_PREFIX);
  const refresh = randomSecret(REFRESH_PREFIX);
  const tokens: TokenResponse = {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    ...(scope ? { scope } : {}),
  };
  tx.insert(agentOAuthTokens)
    .values([
      { tokenHash: sha256(access), grantId, kind: "access", expiresAt: now + ACCESS_TTL_MS },
      { tokenHash: sha256(refresh), grantId, kind: "refresh", expiresAt: now + REFRESH_TTL_MS },
    ])
    .run();
  tx.update(agentOAuthGrants).set({ lastResponseEnc: encrypt(JSON.stringify(tokens)) }).where(eq(agentOAuthGrants.id, grantId)).run();
  return tokens;
}
