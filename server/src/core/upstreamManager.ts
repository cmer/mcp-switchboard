import type { Db } from "../db/index.js";
import { markServerStreamableHttp, runnableServers, serverById } from "./systemView.js";
import { UpstreamConnection, type ChangedKind, type UpstreamEvents, type UpstreamState } from "./upstreamConnection.js";

export class UpstreamManager {
  private connections = new Map<number, UpstreamConnection>();

  /** Wired by SwitchboardHub after construction (breaks the circular dependency). */
  onCachesChanged: (serverId: number, kind: ChangedKind) => void = () => {};
  onStateChanged: (serverId: number, state: UpstreamState) => void = () => {};

  constructor(
    private db: Db,
    private makeOAuthProvider: UpstreamEvents["makeOAuthProvider"],
  ) {}

  private events(): UpstreamEvents {
    return {
      onCachesChanged: (id, kind) => this.onCachesChanged(id, kind),
      onStateChanged: (id, state) => this.onStateChanged(id, state),
      makeOAuthProvider: this.makeOAuthProvider,
      // The connection adopts the returned row, so reconcile() sees a matching updatedAt and won't restart it.
      onLegacySseFallback: (id) => markServerStreamableHttp(this.db, id),
    };
  }

  /** Bring live connections in line with the DB (call at boot and after any server mutation). */
  async reconcile(): Promise<void> {
    // Runnable = switched on AND owned by someone who isn't disabled (a disabled user's servers go dark).
    const wanted = new Map(runnableServers(this.db).map((r) => [r.id, r]));

    // stop & drop connections that are no longer wanted
    for (const [id, conn] of this.connections) {
      if (!wanted.has(id)) {
        await conn.stop();
        this.connections.delete(id);
        this.onCachesChanged(id, "tools");
      }
    }

    // start new ones; restart changed ones
    for (const [id, row] of wanted) {
      const existing = this.connections.get(id);
      if (!existing) {
        const conn = new UpstreamConnection(row, this.events());
        this.connections.set(id, conn);
        conn.start();
      } else if (existing.row.updatedAt !== row.updatedAt) {
        existing.updateRow(row);
        await existing.restart();
      }
    }
  }

  get(serverId: number): UpstreamConnection | undefined {
    return this.connections.get(serverId);
  }

  async restart(serverId: number): Promise<boolean> {
    const conn = this.connections.get(serverId);
    if (!conn) {
      // may have been disabled; try reconcile in case it was re-enabled
      const row = serverById(this.db, serverId);
      if (row?.enabled) {
        await this.reconcile();
        return this.connections.has(serverId);
      }
      return false;
    }
    await conn.restart();
    return true;
  }

  statusSummary(): Record<number, { state: UpstreamState; lastError: string | null; toolCount: number }> {
    const out: Record<number, { state: UpstreamState; lastError: string | null; toolCount: number }> = {};
    for (const [id, conn] of this.connections) {
      out[id] = { state: conn.state, lastError: conn.lastError, toolCount: conn.toolsCache.length };
    }
    return out;
  }

  async stopAll(): Promise<void> {
    for (const conn of this.connections.values()) await conn.stop();
    this.connections.clear();
  }
}
