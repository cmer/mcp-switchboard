import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Db } from "../db/index.js";
import { oauthCredentials } from "../db/schema.js";
import { decrypt, encrypt } from "../lib/crypto.js";

export interface DbOAuthProviderDeps {
  db: Db;
  publicUrl: string;
  /** Called after tokens are saved so the refresher can reschedule. */
  onTokensSaved?: (serverId: number) => void;
}

/**
 * True when a stored client registration is still usable with `redirectUrl`. Registrations that
 * do not list any redirect URI (some servers omit the echo) are taken at face value.
 */
export function clientInfoMatchesRedirect(info: unknown, redirectUrl: string): boolean {
  const uris = (info as { redirect_uris?: unknown } | null)?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return true;
  return uris.includes(redirectUrl);
}

/**
 * OAuthClientProvider backed by the oauth_credentials table.
 *
 * `redirectToAuthorization` never opens a browser: it CAPTURES the URL in
 * `capturedAuthorizationUrl` so the REST layer can hand it to the UI. Background
 * refresh code treats a "REDIRECT" result as needs_auth.
 */
export class DbOAuthProvider implements OAuthClientProvider {
  capturedAuthorizationUrl: URL | null = null;

  constructor(
    private serverId: number,
    private deps: DbOAuthProviderDeps,
  ) {}

  private row() {
    return this.deps.db
      .select()
      .from(oauthCredentials)
      .where(eq(oauthCredentials.serverId, this.serverId))
      .get();
  }

  private update(values: Partial<typeof oauthCredentials.$inferInsert>): void {
    const now = Date.now();
    const existing = this.row();
    if (existing) {
      this.deps.db
        .update(oauthCredentials)
        .set({ ...values, updatedAt: now })
        .where(eq(oauthCredentials.serverId, this.serverId))
        .run();
    } else {
      this.deps.db
        .insert(oauthCredentials)
        .values({ serverId: this.serverId, status: "needs_auth", ...values, updatedAt: now })
        .run();
    }
  }

  get redirectUrl(): string {
    return `${this.deps.publicUrl}/oauth/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "MCP Switchboard",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    const state = crypto.randomUUID();
    this.update({ pendingState: state });
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const row = this.row();
    if (!row?.clientInfoEnc) return undefined;
    const info = JSON.parse(decrypt(row.clientInfoEnc)) as OAuthClientInformationMixed;
    // A registration is bound to the redirect URI it was created with. If PUBLIC_URL changed
    // since then, reusing this client_id makes the authorization server reject the authorize
    // request ("redirect URI does not match any registered URI"), and no amount of re-auth
    // clears it. Drop the stale registration so the SDK registers a fresh client instead.
    if (!clientInfoMatchesRedirect(info, this.redirectUrl)) {
      console.warn(
        `[oauth] server ${this.serverId}: stored client registration was issued for a different ` +
          `redirect URI than ${this.redirectUrl} — discarding it and re-registering.`,
      );
      this.invalidateCredentials("all");
      return undefined;
    }
    return info;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.update({ clientInfoEnc: encrypt(JSON.stringify(info)) });
  }

  tokens(): OAuthTokens | undefined {
    const row = this.row();
    if (!row?.tokensEnc) return undefined;
    return JSON.parse(decrypt(row.tokensEnc)) as OAuthTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const now = Date.now();
    this.update({
      tokensEnc: encrypt(JSON.stringify(tokens)),
      tokenSavedAt: now,
      tokenExpiresAt: tokens.expires_in ? now + tokens.expires_in * 1000 : null,
      status: "ok",
      pendingState: null,
    });
    this.deps.onTokensSaved?.(this.serverId);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.capturedAuthorizationUrl = authorizationUrl;
    this.update({ status: "pending" });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.update({ codeVerifierEnc: encrypt(codeVerifier) });
  }

  codeVerifier(): string {
    const row = this.row();
    if (!row?.codeVerifierEnc) throw new Error("No PKCE code verifier stored");
    return decrypt(row.codeVerifierEnc);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") {
      this.update({
        clientInfoEnc: null,
        tokensEnc: null,
        tokenExpiresAt: null,
        tokenSavedAt: null,
        codeVerifierEnc: null,
        discoveryJson: null,
        status: "needs_auth",
      });
    } else if (scope === "client") {
      this.update({ clientInfoEnc: null });
    } else if (scope === "tokens") {
      this.update({ tokensEnc: null, tokenExpiresAt: null, tokenSavedAt: null, status: "needs_auth" });
    } else if (scope === "verifier") {
      this.update({ codeVerifierEnc: null });
    } else if (scope === "discovery") {
      this.update({ discoveryJson: null });
    }
  }
}
