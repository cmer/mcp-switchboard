import crypto from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** How long an unclaimed draft (and the tokens it holds) lives. */
const DRAFT_TTL_MS = 30 * 60_000;

export type DraftStatus = "pending" | "authorized" | "failed";

/**
 * OAuth for a server that doesn't exist yet. Testing a new OAuth server authorizes against a
 * draft held in memory only; adding the server adopts the draft's registration and tokens, so the
 * user never authorizes twice. Drafts belong to one user and one URL, and expire unclaimed.
 */
export interface OAuthDraft {
  id: string;
  userId: number;
  serverUrl: string;
  status: DraftStatus;
  error: string | null;
  createdAt: number;
  clientInfo?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** When the tokens arrived, so `expires_in` can be aged on adoption. */
  tokensAt?: number;
  codeVerifier?: string;
  pendingState?: string;
  discovery?: OAuthDiscoveryState;
}

export class DraftOAuthProvider implements OAuthClientProvider {
  capturedAuthorizationUrl: URL | null = null;

  constructor(
    readonly draft: OAuthDraft,
    private publicUrl: string,
    private now: () => number = Date.now,
  ) {}

  get redirectUrl(): string {
    return `${this.publicUrl}/oauth/callback`;
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
    this.draft.pendingState = crypto.randomUUID();
    return this.draft.pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.draft.clientInfo;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.draft.clientInfo = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.draft.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.draft.tokens = tokens;
    this.draft.tokensAt = this.now();
    this.draft.status = "authorized";
    this.draft.error = null;
    this.draft.pendingState = undefined;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.capturedAuthorizationUrl = authorizationUrl;
    this.draft.status = "pending";
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.draft.codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.draft.codeVerifier) throw new Error("No PKCE code verifier stored");
    return this.draft.codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.draft.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.draft.discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") this.draft.clientInfo = undefined;
    if (scope === "all" || scope === "tokens") {
      this.draft.tokens = undefined;
      this.draft.status = "pending";
    }
    if (scope === "all" || scope === "verifier") this.draft.codeVerifier = undefined;
    if (scope === "all" || scope === "discovery") this.draft.discovery = undefined;
  }
}

export class OAuthDraftStore {
  private drafts = new Map<string, OAuthDraft>();

  constructor(
    private publicUrl: string,
    private now: () => number = Date.now,
  ) {}

  /** The user's draft for this URL, reused across test runs; a new one when there is none. */
  open(userId: number, serverUrl: string, draftId?: string): OAuthDraft {
    this.prune();
    const existing = draftId ? this.get(userId, draftId) : undefined;
    if (existing && existing.serverUrl === serverUrl) return existing;
    const draft: OAuthDraft = {
      id: crypto.randomUUID(),
      userId,
      serverUrl,
      status: "pending",
      error: null,
      createdAt: this.now(),
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  /** Only the user who opened a draft can see or use it. */
  get(userId: number, draftId: string): OAuthDraft | undefined {
    this.prune();
    const draft = this.drafts.get(draftId);
    return draft && draft.userId === userId ? draft : undefined;
  }

  byState(state: string): OAuthDraft | undefined {
    this.prune();
    for (const d of this.drafts.values()) if (d.pendingState === state) return d;
    return undefined;
  }

  provider(draft: OAuthDraft): DraftOAuthProvider {
    return new DraftOAuthProvider(draft, this.publicUrl, this.now);
  }

  /**
   * Hand an authorized draft's registration and tokens to the server being created, and forget
   * it. Undefined unless it's this user's, for this URL, and authorized.
   */
  claim(
    userId: number,
    draftId: string,
    serverUrl: string,
  ): { clientInfo?: OAuthClientInformationMixed; tokens: OAuthTokens } | undefined {
    const draft = this.get(userId, draftId);
    if (!draft || draft.serverUrl !== serverUrl || draft.status !== "authorized" || !draft.tokens) return undefined;
    this.drafts.delete(draftId);
    const tokens = { ...draft.tokens };
    if (tokens.expires_in !== undefined && draft.tokensAt !== undefined) {
      tokens.expires_in = Math.max(0, tokens.expires_in - Math.floor((this.now() - draft.tokensAt) / 1000));
    }
    return { clientInfo: draft.clientInfo, tokens };
  }

  discard(userId: number, draftId: string): void {
    if (this.get(userId, draftId)) this.drafts.delete(draftId);
  }

  private prune(): void {
    const cutoff = this.now() - DRAFT_TTL_MS;
    for (const [id, d] of this.drafts) if (d.createdAt < cutoff) this.drafts.delete(id);
  }
}

/**
 * A live server's stored OAuth credentials, borrowed for a connection test. Reads and token
 * refreshes go through to the real provider (a rotated refresh token must be kept, or the live
 * connection breaks), but nothing the test does can start a new authorization, invalidate the
 * stored credentials or mark the server as needing auth.
 */
export class BorrowedOAuthProvider implements OAuthClientProvider {
  capturedAuthorizationUrl: URL | null = null;
  private verifier: string | undefined;

  constructor(private inner: OAuthClientProvider) {}

  get redirectUrl(): string | URL | undefined {
    return this.inner.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.inner.clientMetadata;
  }

  state(): string {
    return crypto.randomUUID();
  }

  clientInformation() {
    return this.inner.clientInformation();
  }

  saveClientInformation(): void {
    // a test never registers a new client for a live server
  }

  tokens() {
    return this.inner.tokens();
  }

  saveTokens(tokens: OAuthTokens) {
    return this.inner.saveTokens(tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.capturedAuthorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("No PKCE code verifier stored");
    return this.verifier;
  }

  invalidateCredentials(): void {
    // leave the live server's credentials alone
  }
}
