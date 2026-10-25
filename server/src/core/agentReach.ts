import type { Db } from "../db/index.js";
import type { AgentRow } from "../db/schema.js";
import type { UpstreamConnection } from "./upstreamConnection.js";
import { userScope, type NamedServer } from "./userScope.js";

/**
 * The per-agent reach module: the only path from a name an agent uses to a server. Everything on
 * the agent-facing side goes through it — tool/prompt/resource lists, call/read/get resolution, the
 * lean search space, the roster, and request-log attribution — so "can this agent use that server,
 * and under what name" is decided in exactly one place.
 *
 * An agent reaches a server it has switched on in the matrix when the server is one of its owner's
 * own (named by slug) or a share the owner accepted (named by alias) whose owner isn't disabled,
 * whose server is switched on, and whose recipient-side switch is on. Nothing else — in particular
 * not another user's server through a stray matrix row. Rules are read fresh on every call: a
 * toggle in the UI applies to sessions that are already live.
 */

/** A server the agent can reach, by the name it uses. `sharedBy` marks a received share. */
export type Reachable = NamedServer;

export interface LiveTarget {
  server: Reachable;
  conn: UpstreamConnection;
}

/** The part of `UpstreamManager` the reach module reads: live connections by server id. */
export interface ConnectionLookup {
  get(serverId: number): UpstreamConnection | undefined;
}

export interface AgentReach {
  /**
   * The roster: own servers then received shares, each under its reach name. An own server its
   * owner switched off stays listed (`enabled: false`) so the roster can say so; an unavailable
   * share is simply absent.
   */
  list(): Reachable[];
  /** By reach name, whatever the connection state: attribution only, never to call through. */
  find(name: string): Reachable | undefined;
  /** Reachable, switched on and connected: whose tools, prompts and resources the agent sees. */
  connected(): LiveTarget[];
  /**
   * The connection to call through for a reach name, or undefined — for an unknown name, a server
   * the agent can't reach and one that isn't running alike, so nothing can be probed.
   */
  resolve(name: string): LiveTarget | undefined;
  /** A call, read or get went through `server`: a share's usage counter moves; own servers don't count. */
  recordUse(server: Reachable): void;
}

const NO_CONNECTIONS: ConnectionLookup = { get: () => undefined };

/**
 * `connections` is the upstream manager; leave it out where only names matter (the request
 * logger), and `connected` / `resolve` then find nothing.
 */
export function agentReach(
  db: Db,
  agent: Pick<AgentRow, "id" | "userId">,
  connections: ConnectionLookup = NO_CONNECTIONS,
): AgentReach {
  const scope = userScope(db, agent.userId);
  const list = () => scope.matrix.reachable(agent.id);

  return {
    list,

    find: (name) => list().find((s) => s.name === name),

    connected: () =>
      list().flatMap((server) => {
        const conn = server.available ? connections.get(server.serverId) : undefined;
        return conn?.state === "connected" ? [{ server, conn }] : [];
      }),

    resolve: (name) => {
      const server = list().find((s) => s.name === name);
      const conn = server?.available ? connections.get(server.serverId) : undefined;
      return server && conn ? { server, conn } : undefined;
    },

    recordUse: (server) => {
      if (server.shareId !== undefined) scope.shares.recordUse(server.shareId);
    },
  };
}
