import { eq } from "drizzle-orm";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Db } from "../db/index.js";
import { oauthCredentials, servers } from "../db/schema.js";

const MIN_DELAY_MS = 1_000;
const RETRY_BACKOFF_MS = 60_000;

/**
 * Pure scheduling rule (unit-tested): refresh at 80% of the token's lifetime.
 * Returns null when there is nothing to schedule (no expiry known).
 */
export function computeRefreshDelay(now: number, savedAt: number | null, expiresAt: number | null): number | null {
  if (expiresAt == null) return null;
  const basis = savedAt ?? now;
  const lifetime = expiresAt - basis;
  if (lifetime <= 0) return MIN_DELAY_MS;
  const refreshAt = basis + 0.8 * lifetime;
  return Math.max(refreshAt - now, MIN_DELAY_MS);
}

export interface TokenRefresherDeps {
  db: Db;
  makeProvider: (serverId: number) => OAuthClientProvider;
  /** Called when a background refresh permanently fails (refresh token dead). */
  onNeedsAuth: (serverId: number) => void;
  /** Called after a successful refresh so a dead connection can be revived. */
  onRefreshed: (serverId: number) => void;
  log?: (msg: string) => void;
}

/**
 * Proactively renews OAuth access tokens in the background at 80% of their
 * lifetime, so agents never hit a stale token. Transient failures retry with
 * a flat backoff; a dead refresh token flips the server to needs_auth.
 */
export class TokenRefresher {
  private timers = new Map<number, NodeJS.Timeout>();
  private refreshing = new Set<number>();

  constructor(private deps: TokenRefresherDeps) {}

  /** Scan all OAuth servers and (re)schedule. Call at boot. */
  scheduleAll(): void {
    const rows = this.deps.db.select().from(oauthCredentials).all();
    for (const row of rows) this.schedule(row.serverId);
  }

  /** (Re)schedule one server based on its stored token expiry. */
  schedule(serverId: number): void {
    this.cancel(serverId);
    const row = this.deps.db
      .select()
      .from(oauthCredentials)
      .where(eq(oauthCredentials.serverId, serverId))
      .get();
    if (!row || row.status !== "ok" || !row.tokensEnc) return;
    const delay = computeRefreshDelay(Date.now(), row.tokenSavedAt, row.tokenExpiresAt);
    if (delay == null) return; // token without known expiry — nothing to do proactively
    this.deps.log?.(`[oauth] server ${serverId}: refresh scheduled in ${Math.round(delay / 1000)}s`);
    this.timers.set(
      serverId,
      setTimeout(() => void this.refresh(serverId), delay),
    );
  }

  cancel(serverId: number): void {
    const t = this.timers.get(serverId);
    if (t) clearTimeout(t);
    this.timers.delete(serverId);
  }

  stopAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private async refresh(serverId: number): Promise<void> {
    if (this.refreshing.has(serverId)) return;
    this.refreshing.add(serverId);
    try {
      const server = this.deps.db.select().from(servers).where(eq(servers.id, serverId)).get();
      if (!server?.url || server.authType !== "oauth" || !server.enabled) return;

      const provider = this.deps.makeProvider(serverId);
      // auth() tries refresh-token reuse before anything interactive.
      const result = await auth(provider, { serverUrl: server.url });
      if (result === "AUTHORIZED") {
        this.deps.log?.(`[oauth] server ${serverId}: token refreshed proactively`);
        // saveTokens() already rescheduled via onTokensSaved; revive the connection if needed.
        this.deps.onRefreshed(serverId);
      } else {
        this.deps.log?.(`[oauth] server ${serverId}: refresh requires re-authorization`);
        this.markNeedsAuth(serverId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`[oauth] server ${serverId}: refresh failed (${msg}); retrying in ${RETRY_BACKOFF_MS / 1000}s`);
      this.timers.set(
        serverId,
        setTimeout(() => void this.refresh(serverId), RETRY_BACKOFF_MS),
      );
    } finally {
      this.refreshing.delete(serverId);
    }
  }

  private markNeedsAuth(serverId: number): void {
    this.deps.db
      .update(oauthCredentials)
      .set({ status: "needs_auth", updatedAt: Date.now() })
      .where(eq(oauthCredentials.serverId, serverId))
      .run();
    this.cancel(serverId);
    this.deps.onNeedsAuth(serverId);
  }
}
