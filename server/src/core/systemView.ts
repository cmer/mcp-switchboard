import { and, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { agentServers, requestLogs, servers, users, type ServerRow } from "../db/schema.js";

/**
 * The runtime's cross-user access, beside `userScope` (one user's data) and `adminView` (the Admin's
 * names-and-counts window). The machinery that runs servers, fans out notifications and maintains
 * the logs is keyed by server id or by time and serves every user at once, so it can't act through
 * one user's scope. Nothing here answers a person or an agent directly: results feed connection
 * management, `list_changed` and log retention.
 */

/**
 * Every server that should have a live connection: switched on and owned by someone who isn't
 * disabled (a disabled user's servers go dark, which recipients of their shares see too).
 */
export function runnableServers(db: Db): ServerRow[] {
  return db
    .select({ server: servers })
    .from(servers)
    .innerJoin(users, eq(users.id, servers.userId))
    .where(and(isNull(users.disabledAt), eq(servers.enabled, true)))
    .all()
    .map((r) => r.server);
}

/** One server's row by id, for the connection and token refresh machinery that only holds the id. */
export function serverById(db: Db, id: number): ServerRow | undefined {
  return db.select().from(servers).where(eq(servers.id, id)).get();
}

/**
 * An SSE server that turned out to speak Streamable HTTP is switched over for good. Returns the
 * updated row for the connection to adopt.
 */
export function markServerStreamableHttp(db: Db, id: number): ServerRow | undefined {
  db.update(servers).set({ type: "http", updatedAt: Date.now() }).where(eq(servers.id, id)).run();
  return serverById(db, id);
}

/**
 * Agents with a server switched on, whoever owns them: the owner's agents and, through their own
 * matrix rows, recipients of a share. These are the sessions a change to the server reshapes.
 */
export function agentsUsingServer(db: Db, serverId: number): number[] {
  return db
    .select({ agentId: agentServers.agentId })
    .from(agentServers)
    .where(and(eq(agentServers.serverId, serverId), eq(agentServers.enabled, true)))
    .all()
    .map((r) => r.agentId);
}

/**
 * Request-log rows still `pending` whose response can no longer arrive (a restart, or a session
 * that went away), across every user. With no age given, every pending row qualifies.
 */
export function markInterruptedLogs(db: Db, olderThanMs?: number): void {
  const stale = olderThanMs === undefined ? undefined : lt(requestLogs.ts, Date.now() - olderThanMs);
  db.update(requestLogs)
    .set({ status: "error", errorMessage: "Interrupted — no response was sent" })
    .where(and(eq(requestLogs.status, "pending"), stale))
    .run();
}

/** Retention is instance-wide: drops every user's rows older than `cutoff` (unix ms). */
export function pruneLogs(db: Db, cutoff: number): number {
  return db.delete(requestLogs).where(lt(requestLogs.ts, cutoff)).run().changes;
}
