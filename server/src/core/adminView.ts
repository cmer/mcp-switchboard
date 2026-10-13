import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { agentServers, agents, serverRequests, servers, users } from "../db/schema.js";
import { requestServerSummary, type RequestServerSummary } from "./adminActions.js";

/**
 * The Admin's narrow window onto other users' data, beside `userScope` (which only ever sees one
 * user's own). Names, counts and ids for the Users page; the escalated server-request queue with
 * env var *names* only. Never another user's server configs, credentials, agent tokens or logs.
 */

/** For the Users page list. */
export function userCounts(db: Db, userId: number): { servers: number; agents: number } {
  const n = (table: typeof servers | typeof agents) =>
    db.select({ n: count() }).from(table).where(eq(table.userId, userId)).get()?.n ?? 0;
  return { servers: n(servers), agents: n(agents) };
}

/** A user's agents by id and slug: whose sessions to drop, and which URLs a rename breaks. */
export function userAgents(db: Db, userId: number): { id: number; slug: string }[] {
  return db
    .select({ id: agents.id, slug: agents.slug })
    .from(agents)
    .where(eq(agents.userId, userId))
    .orderBy(agents.id)
    .all();
}

/**
 * What deleting a user leaves to clean up, read before the cascade removes the rows it comes from:
 * their servers (token refresh to cancel), their agents (sessions to drop), and other users' agents
 * that had one of their servers switched on (to notify).
 */
export function userDeletionFallout(
  db: Db,
  userId: number,
): { serverIds: number[]; agentIds: number[]; recipientAgentIds: number[] } {
  const serverIds = db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.userId, userId))
    .all()
    .map((r) => r.id);
  const recipientAgentIds =
    serverIds.length === 0
      ? []
      : db
          .selectDistinct({ agentId: agentServers.agentId })
          .from(agentServers)
          .innerJoin(agents, eq(agents.id, agentServers.agentId))
          .where(and(inArray(agentServers.serverId, serverIds), eq(agentServers.enabled, true), ne(agents.userId, userId)))
          .all()
          .map((r) => r.agentId);
  return { serverIds, agentIds: userAgents(db, userId).map((a) => a.id), recipientAgentIds };
}

/** What the Admin sees of an escalated request: who, which agent, why, and the command without env values. */
export interface EscalatedRequestView {
  id: number;
  userId: number;
  username: string;
  /** Null when the user filed it from the web UI rather than through an agent. */
  requestedByAgentSlug: string | null;
  kind: "add_server" | "freeform";
  reason: string | null;
  status: "pending" | "approved" | "denied";
  resolutionNote: string | null;
  createdAt: number;
  resolvedAt: number | null;
  server: RequestServerSummary | null;
}

/** Every escalated request (pending and resolved), newest first. Acting on one goes through the requester's scope. */
export function escalatedRequests(db: Db): EscalatedRequestView[] {
  return escalatedWhere(db);
}

export function escalatedRequest(db: Db, id: number): EscalatedRequestView | undefined {
  return escalatedWhere(db, id)[0];
}

function escalatedWhere(db: Db, id?: number): EscalatedRequestView[] {
  return db
    .select({ row: serverRequests, username: users.username })
    .from(serverRequests)
    .innerJoin(users, eq(users.id, serverRequests.userId))
    .where(and(eq(serverRequests.escalated, true), id === undefined ? undefined : eq(serverRequests.id, id)))
    .orderBy(desc(serverRequests.id))
    .all()
    .map(({ row, username }) => ({
      id: row.id,
      userId: row.userId,
      username,
      requestedByAgentSlug: row.requestedByAgentSlug || null,
      kind: row.kind,
      reason: row.reason,
      status: row.status,
      resolutionNote: row.resolutionNote,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
      server: requestServerSummary(row),
    }));
}
