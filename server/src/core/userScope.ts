import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  agentServers,
  agents,
  oauthCredentials,
  requestLogs,
  serverRequests,
  servers,
  shares,
  userSettings,
  users,
  type AgentRow,
  type RequestLogRow,
  type ServerRequestRow,
  type ServerRow,
  type UserRow,
} from "../db/schema.js";
import { decrypt, encrypt, randomToken } from "../lib/crypto.js";
import type { ParsedServer } from "../lib/importParser.js";
import { mergeSecrets } from "../lib/secretMap.js";
import { USER_SETTING_DEFAULTS, USER_SETTING_KEYS, type UserSettingName } from "../lib/settings.js";
import { isReservedSlug, isValidSlug, slugify } from "../lib/slug.js";
import { getUser, getUserByUsername } from "./users.js";

/**
 * The isolation seam: everything one user owns, and nothing anyone else does.
 *
 * Built per request for one user (REST: the signed-in user; MCP: the agent's owner). It is the
 * only code that touches the owned tables (`servers`, `agents`, `agent_servers`, `shares`,
 * `server_requests`, `request_logs`, `user_settings`) — a guard test enforces that — so every
 * query below is pinned to `user.id` and callers never pass a user id themselves.
 *
 * Another user's id behaves exactly like an id that doesn't exist (`undefined` / `false` / 404),
 * so nothing reveals what other users have. Pure data access: no reconcile, no notifications —
 * results carry what the caller needs to do those (e.g. the agents to notify).
 */
export interface UserScope {
  readonly user: UserRow;
  /** Whether stdio servers may be added directly: the Admin always, anyone else with the flag. */
  readonly canRunLocalCommands: boolean;
  readonly servers: ScopedServers;
  readonly agents: ScopedAgents;
  readonly matrix: ScopedMatrix;
  readonly requests: ScopedRequests;
  readonly logs: ScopedLogs;
  readonly settings: ScopedSettings;
  readonly shares: ScopedShares;
}

export type ScopeError = { error: string; status: 400 | 404 | 409 };

export interface NewServer {
  name: string;
  slug?: string;
  description?: string | null;
  type: "stdio" | "http" | "sse";
  enabled?: boolean;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  // remote
  url?: string;
  authType?: "none" | "bearer" | "headers" | "oauth";
  bearerToken?: string;
  headers?: Record<string, string>;
  createdByAgentSlug?: string | null;
}

/** For the secrets, `null` clears the stored value and `undefined` leaves it as it is. */
export interface ServerPatch {
  name?: string;
  slug?: string;
  description?: string | null;
  type?: "stdio" | "http" | "sse";
  enabled?: boolean;
  command?: string;
  args?: string[];
  /** null clears; a null value keeps that key's stored value; keys left out are dropped. */
  env?: Record<string, string | null> | null;
  cwd?: string | null;
  url?: string;
  authType?: "none" | "bearer" | "headers" | "oauth";
  bearerToken?: string | null;
  /** Same semantics as `env`. */
  headers?: Record<string, string | null> | null;
}

export interface ScopedServers {
  list(): ServerRow[];
  get(id: number): ServerRow | undefined;
  bySlug(slug: string): ServerRow | undefined;
  /** Why `slug` can't be used for one of this user's servers (format, reserved, taken), or null. */
  checkSlug(slug: string, exceptId?: number): ScopeError | null;
  /**
   * Validates, inserts, seeds OAuth credentials and applies the owner's `autoEnableNewServers`
   * (their own agents only). Does NOT reconcile: callers do that once per batch.
   */
  create(input: NewServer): { row: ServerRow } | ScopeError;
  /** `affectedAgentIds`: agents that had it switched on before the change, to notify. */
  update(id: number, patch: ServerPatch): { row: ServerRow; affectedAgentIds: number[] } | ScopeError;
  /** Collects the agents to notify *before* the cascade removes their matrix rows. */
  remove(id: number): { affectedAgentIds: number[] } | undefined;
}

export interface AgentPatch {
  name?: string;
  slug?: string;
  role?: AgentRow["role"];
  toolMode?: AgentRow["toolMode"];
}

export interface ScopedAgents {
  list(): AgentRow[];
  get(id: number): AgentRow | undefined;
  bySlug(slug: string): AgentRow | undefined;
  /** Generates the agent's bearer token. */
  create(input: { name: string; slug?: string }): { row: AgentRow } | ScopeError;
  update(id: number, patch: AgentPatch): { row: AgentRow; previous: AgentRow } | ScopeError;
  rotateToken(id: number): AgentRow | undefined;
  remove(id: number): boolean;
}

/**
 * A server this user's agents can be switched on for, under the name this user knows it by: one of
 * their own servers (its slug) or an accepted share (its alias). Never URL, command or credentials.
 */
export interface NamedServer {
  /** Own slug, or the share's alias: the tool-name prefix the user's agents see. */
  name: string;
  serverId: number;
  /** The owner's username, for a received share. */
  sharedBy?: string;
  shareId?: number;
  /** The server's display name and note, as its owner set them. */
  serverName: string;
  description: string | null;
  type: ServerRow["type"];
  /** The owner has the server switched on. */
  enabled: boolean;
  /**
   * Usable as far as the data goes: own → switched on; share → switched on, owner not disabled,
   * and the recipient's own switch for the share on.
   */
  available: boolean;
}

export interface ScopedMatrix {
  /** One switch per server this agent could be given (off where no row exists yet). */
  forAgent(agentId: number): { serverId: number; enabled: boolean }[];
  /**
   * False — and nothing written — unless both the agent and the server are this user's to link:
   * one of their own servers, or one shared with them and accepted (the recipient's row, never the owner's).
   */
  set(agentId: number, serverId: number, enabled: boolean): boolean;
  /** Own servers, then accepted shares: everything `set` accepts, addressed by name. */
  switchable(): NamedServer[];
  /**
   * What one agent has switched on and may reach: its matrix rows, intersected with `switchable`,
   * minus shares that aren't `available` (a switched-off own server stays, so the roster can say
   * "disabled"). A matrix row pointing anywhere else is ignored. This is the data half of the
   * per-agent reach module (`agentReach.ts`), which adds the live connections — go through that.
   */
  reachable(agentId: number): NamedServer[];
}

/** One recipient of one of this user's servers, as the owner sees it: a name and usage, nothing of theirs. */
export interface OwnedShare {
  id: number;
  serverId: number;
  /** The recipient's username. */
  username: string;
  status: "offered" | "accepted";
  callCount: number;
  lastUsedAt: number | null;
  createdAt: number;
}

/**
 * A server shared with this user, as they see it. Never URL, command, env, headers or credentials:
 * only what the owner chose to show (name, description) plus the facts the status is derived from.
 */
export interface ReceivedShare {
  id: number;
  serverId: number;
  status: "offered" | "accepted";
  /** The recipient's name for it; null until accepted. */
  alias: string | null;
  /** What accepting prefills: `<owner>-<slug>`, cut to the slug rule. */
  proposedAlias: string;
  ownerUsername: string;
  serverName: string;
  description: string | null;
  /** The recipient's own switch for the share. */
  enabled: boolean;
  /** The owner has the server switched on and isn't disabled; whether it connects is the runtime's to say. */
  ownerAvailable: boolean;
  createdAt: number;
}

/** Longest alias the slug rule allows. */
const MAX_SLUG = 64;

export interface ScopedShares {
  /** One call/read/get went through a share this user received: bump its usage for the owner. */
  recordUse(shareId: number): void;

  /* Owner side: shares of this user's own servers. Another user's server id is simply unknown. */

  /** Who one of this user's servers is shared with; undefined if it isn't theirs. */
  forServer(serverId: number): OwnedShare[] | undefined;
  /** Every share of every server this user owns, by server id: the servers list's "shared with" badges. */
  summaries(): Map<number, OwnedShare[]>;
  /** Offers `serverId` to a user by username. Not to yourself, a disabled user, or twice. */
  offer(serverId: number, username: string): { share: OwnedShare } | ScopeError;
  /**
   * Revokes an offered or accepted share, deleting the recipient's matrix rows for the server.
   * `affectedAgentIds`: the recipient's agents that had rows, collected before the delete, to notify.
   */
  revoke(serverId: number, shareId: number): { affectedAgentIds: number[] } | undefined;

  /* Recipient side: shares of other users' servers offered to this user. */

  /** Offers and accepted shares, oldest first. */
  received(): ReceivedShare[];
  /** Why `alias` can't name a share for this user (format, reserved, an own slug, another alias), or null. */
  checkAlias(alias: string, exceptShareId?: number): ScopeError | null;
  /**
   * Accepts an offer under `alias`. Switches start off, unless `autoEnableNewServers` is on: then
   * every one of this user's agents gets it, and `enabledAgentIds` lists them to notify.
   */
  accept(shareId: number, alias: string): { share: ReceivedShare; enabledAgentIds: number[] } | ScopeError;
  /** Declining deletes a pending offer. False if there is no such offer. */
  decline(shareId: number): boolean;
  /** `affectedAgentIds`: this user's agents that have the share switched on, whose tool names change. */
  rename(shareId: number, alias: string): { share: ReceivedShare; affectedAgentIds: number[] } | ScopeError;
  /** The recipient's own switch; the per-agent rows are left as they are. */
  setEnabled(shareId: number, enabled: boolean): { share: ReceivedShare; affectedAgentIds: number[] } | undefined;
  /** Drops an accepted share and this user's matrix rows for it; the owner's server is untouched. */
  remove(shareId: number): { affectedAgentIds: number[] } | undefined;
}

export interface NewServerRequest {
  /** Null when a person filed it from the web UI rather than an agent. */
  agentId: number | null;
  /** `""` for a request filed from the web UI (no agent can have an empty slug). */
  agentSlug: string;
  kind: "add_server" | "freeform";
  /** The exact config to approve; null for a freeform ask. */
  payload?: ParsedServer | null;
  reason?: string | null;
}

export interface ScopedRequests {
  /** Newest first, including the user's own escalated ones ("waiting for Admin"). */
  list(): ServerRequestRow[];
  get(id: number): ServerRequestRow | undefined;
  /** Filed by one of this user's agents (or from the UI); `escalated` = routed to the Admin. */
  forAgent(agent: { id: number; slug: string }): ServerRequestRow[];
  /** A local command the user can't run goes to the Admin's queue (`escalated`). */
  file(input: NewServerRequest): { id: number; escalated: boolean };
  /** Only a pending request resolves; false otherwise (unknown, someone else's, already resolved). */
  resolve(id: number, outcome: { status: "approved" | "denied"; note?: string | null }): boolean;
}

/** The query-string filters the Logs page sends; every value is optional text. */
export interface LogFilter {
  agent?: string;
  server?: string;
  method?: string;
  status?: string;
  before?: string;
  q?: string;
}

export interface LogStats {
  total: number;
  errors: number;
  medianMs: number | null;
  p95Ms: number | null;
}

/** A request-log row as the logger writes it; the owner is always this user. */
export type NewLogRow = Omit<typeof requestLogs.$inferInsert, "id" | "userId">;

export interface ScopedLogs {
  list(filter: LogFilter, limit: number): LogSummary[];
  /** The live tail's projection of one row. */
  summary(id: number): LogSummary | undefined;
  /** The request logger's write path: a row for one of this user's agents. Returns its id. */
  record(row: NewLogRow): number;
  /** Fills in the response half of a row recorded by `record`. */
  complete(id: number, patch: Partial<NewLogRow>): void;
  get(id: number): RequestLogRow | undefined;
  /** Headline numbers since `since` (unix ms). */
  stats(since: number): LogStats;
  /** Deletes this user's rows only. */
  clear(): number;
}

export interface ScopedSettings {
  get(name: UserSettingName): boolean;
  set(name: UserSettingName, value: boolean): void;
}

/** The columns the list view and the live stream need — payloads are fetched per row on expand. */
export const LOG_SUMMARY_COLUMNS = {
  id: requestLogs.id,
  ts: requestLogs.ts,
  agentId: requestLogs.agentId,
  agentSlug: requestLogs.agentSlug,
  agentName: requestLogs.agentName,
  serverSlug: requestLogs.serverSlug,
  method: requestLogs.method,
  target: requestLogs.target,
  summary: requestLogs.summary,
  status: requestLogs.status,
  durationMs: requestLogs.durationMs,
  errorCode: requestLogs.errorCode,
  errorMessage: requestLogs.errorMessage,
  requestBytes: requestLogs.requestBytes,
  responseBytes: requestLogs.responseBytes,
} as const;

export type LogSummary = {
  [K in keyof typeof LOG_SUMMARY_COLUMNS]: RequestLogRow[K];
};

/** Anything above this is flagged amber in the UI and matched by `status=slow`. */
export const SLOW_MS = 1_000;

const SLUG_RULE = "Slug must be 1-64 chars of a-z, 0-9, and dashes (no underscores)";

/** Accepts the row (REST already has it) or an id (MCP has the agent's `userId`). */
export function userScope(db: Db, user: UserRow | number): UserScope {
  const row = typeof user === "number" ? getUser(db, user) : user;
  if (!row) throw new Error(`No user with id ${String(user)}`);
  return new Scope(db, row);
}

class Scope implements UserScope {
  readonly canRunLocalCommands: boolean;

  constructor(
    private db: Db,
    readonly user: UserRow,
  ) {
    this.canRunLocalCommands = user.role === "admin" || user.canRunLocalCommands;
  }

  private get uid(): number {
    return this.user.id;
  }

  /** Agents with this server switched on, any owner: the ones whose toolset a change reshapes. */
  private agentsUsing(serverId: number): number[] {
    return this.db
      .select({ agentId: agentServers.agentId })
      .from(agentServers)
      .where(and(eq(agentServers.serverId, serverId), eq(agentServers.enabled, true)))
      .all()
      .map((r) => r.agentId);
  }

  /** The servers this user's agents can be switched on for: their own and accepted shares. */
  private switchableServerIds(): number[] {
    return this.matrix.switchable().map((s) => s.serverId);
  }

  /** Every share offered to this user, any status, with the server's public face and its owner. */
  private receivedRows() {
    return this.db
      .select({ share: shares, server: servers, owner: { username: users.username, disabledAt: users.disabledAt } })
      .from(shares)
      .innerJoin(servers, eq(servers.id, shares.serverId))
      .innerJoin(users, eq(users.id, servers.userId))
      .where(and(eq(shares.recipientUserId, this.uid), ne(servers.userId, this.uid)))
      .orderBy(shares.id)
      .all();
  }

  private receivedShares(): NamedServer[] {
    return this.receivedRows()
      .filter(({ share }) => share.status === "accepted" && share.alias !== null)
      .map(({ share, server, owner }) => ({
        name: share.alias!,
        serverId: server.id,
        sharedBy: owner.username,
        shareId: share.id,
        serverName: server.name,
        description: server.description,
        type: server.type,
        enabled: server.enabled,
        available: server.enabled && share.enabled && owner.disabledAt === null,
      }));
  }

  /** The agents among `agentOwnerId`'s that have any matrix row (or an enabled one) for the server. */
  private agentsWithRows(agentOwnerId: number, serverId: number, onlyEnabled = false): number[] {
    return this.db
      .select({ agentId: agentServers.agentId })
      .from(agentServers)
      .innerJoin(agents, eq(agents.id, agentServers.agentId))
      .where(
        and(
          eq(agents.userId, agentOwnerId),
          eq(agentServers.serverId, serverId),
          onlyEnabled ? eq(agentServers.enabled, true) : undefined,
        ),
      )
      .all()
      .map((r) => r.agentId);
  }

  private receivedShare(shareId: number): ReceivedShare | undefined {
    const found = this.receivedRows().find((r) => r.share.id === shareId);
    return found && toReceived(found);
  }

  readonly servers: ScopedServers = {
    list: () => this.db.select().from(servers).where(eq(servers.userId, this.uid)).orderBy(servers.id).all(),

    get: (id) =>
      this.db
        .select()
        .from(servers)
        .where(and(eq(servers.id, id), eq(servers.userId, this.uid)))
        .get(),

    bySlug: (slug) =>
      this.db
        .select()
        .from(servers)
        .where(and(eq(servers.slug, slug), eq(servers.userId, this.uid)))
        .get(),

    checkSlug: (slug, exceptId) => {
      if (!isValidSlug(slug)) return { error: SLUG_RULE, status: 400 };
      if (isReservedSlug(slug)) {
        return { error: `Slug "${slug}" is reserved for the switchboard's own tools`, status: 400 };
      }
      const clash = this.servers.bySlug(slug);
      if (clash && clash.id !== exceptId) return { error: `Slug "${slug}" is already in use`, status: 409 };
      // One namespace: a server slug can't be the name a received share already goes by.
      if (this.receivedShares().some((s) => s.name === slug)) {
        return { error: `Slug "${slug}" is already the alias of a server shared with you`, status: 409 };
      }
      return null;
    },

    create: (input) => {
      const slug = input.slug ?? slugify(input.name);
      const bad = this.servers.checkSlug(slug);
      if (bad) return bad;
      if (input.type === "stdio" && !input.command) return { error: "Local servers need a command", status: 400 };
      if (input.type !== "stdio" && !input.url) return { error: "Remote servers need a URL", status: 400 };

      const now = Date.now();
      const row = this.db
        .insert(servers)
        .values({
          userId: this.uid,
          slug,
          name: input.name,
          description: input.description ?? null,
          type: input.type,
          enabled: input.enabled ?? true,
          command: input.command ?? null,
          argsJson: input.args ? JSON.stringify(input.args) : null,
          envJsonEnc: encryptMap(input.env),
          cwd: input.cwd ?? null,
          url: input.url ?? null,
          authType: input.type === "stdio" ? "none" : (input.authType ?? "none"),
          bearerTokenEnc: input.bearerToken ? encrypt(input.bearerToken) : null,
          headersJsonEnc: encryptMap(input.headers),
          createdByAgentSlug: input.createdByAgentSlug ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      if (row.authType === "oauth") {
        this.db.insert(oauthCredentials).values({ serverId: row.id, status: "needs_auth", updatedAt: now }).run();
      }
      // Optional convenience (Settings → General): new servers start enabled for every one of the owner's agents.
      if (this.settings.get("autoEnableNewServers")) {
        for (const agent of this.agents.list()) this.matrix.set(agent.id, row.id, true);
      }
      return { row };
    },

    update: (id, patch) => {
      const row = this.servers.get(id);
      if (!row) return { error: "Not found", status: 404 };
      if (patch.slug !== undefined) {
        const bad = this.servers.checkSlug(patch.slug, id);
        if (bad) return bad;
      }

      const env = patch.env ? mergeSecrets("Env var", decryptMap(row.envJsonEnc), patch.env) : { value: patch.env };
      if ("error" in env) return { error: env.error, status: 400 };
      const headers = patch.headers
        ? mergeSecrets("Header", decryptMap(row.headersJsonEnc), patch.headers)
        : { value: patch.headers };
      if ("error" in headers) return { error: headers.error, status: 400 };

      const values: Partial<typeof servers.$inferInsert> = { updatedAt: Date.now() };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.slug !== undefined) values.slug = patch.slug;
      if (patch.description !== undefined) values.description = patch.description || null;
      if (patch.type !== undefined) values.type = patch.type;
      if (patch.enabled !== undefined) values.enabled = patch.enabled;
      if (patch.command !== undefined) values.command = patch.command;
      if (patch.args !== undefined) values.argsJson = JSON.stringify(patch.args);
      if (patch.cwd !== undefined) values.cwd = patch.cwd;
      if (patch.url !== undefined) values.url = patch.url;
      if (patch.authType !== undefined) values.authType = patch.authType;
      if (patch.env !== undefined) values.envJsonEnc = encryptMap(env.value);
      if (patch.bearerToken !== undefined) values.bearerTokenEnc = patch.bearerToken ? encrypt(patch.bearerToken) : null;
      if (patch.headers !== undefined) values.headersJsonEnc = encryptMap(headers.value);

      const affectedAgentIds = this.agentsUsing(id);
      const updated = this.db.update(servers).set(values).where(eq(servers.id, id)).returning().get();
      if (updated.authType === "oauth" && row.authType !== "oauth") {
        this.db
          .insert(oauthCredentials)
          .values({ serverId: id, status: "needs_auth", updatedAt: Date.now() })
          .onConflictDoNothing()
          .run();
      }
      return { row: updated, affectedAgentIds };
    },

    remove: (id) => {
      if (!this.servers.get(id)) return undefined;
      const affectedAgentIds = this.agentsUsing(id);
      this.db.delete(servers).where(eq(servers.id, id)).run();
      return { affectedAgentIds };
    },
  };

  readonly agents: ScopedAgents = {
    list: () => this.db.select().from(agents).where(eq(agents.userId, this.uid)).orderBy(agents.id).all(),

    get: (id) =>
      this.db
        .select()
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, this.uid)))
        .get(),

    bySlug: (slug) =>
      this.db
        .select()
        .from(agents)
        .where(and(eq(agents.slug, slug), eq(agents.userId, this.uid)))
        .get(),

    create: (input) => {
      const slug = input.slug ?? slugify(input.name);
      const bad = this.checkAgentSlug(slug);
      if (bad) return bad;
      const row = this.db
        .insert(agents)
        .values({ userId: this.uid, slug, name: input.name, tokenEnc: encrypt(randomToken()), createdAt: Date.now() })
        .returning()
        .get();
      return { row };
    },

    update: (id, patch) => {
      const previous = this.agents.get(id);
      if (!previous) return { error: "Not found", status: 404 };
      if (patch.slug !== undefined) {
        const bad = this.checkAgentSlug(patch.slug, id);
        if (bad) return bad;
      }
      const set: AgentPatch = {};
      for (const key of ["name", "slug", "role", "toolMode"] as const) {
        if (patch[key] !== undefined) Object.assign(set, { [key]: patch[key] });
      }
      if (Object.keys(set).length === 0) return { row: previous, previous };
      const row = this.db.update(agents).set(set).where(eq(agents.id, id)).returning().get();
      return { row, previous };
    },

    rotateToken: (id) => {
      if (!this.agents.get(id)) return undefined;
      return this.db
        .update(agents)
        .set({ tokenEnc: encrypt(randomToken()) })
        .where(eq(agents.id, id))
        .returning()
        .get();
    },

    remove: (id) => {
      if (!this.agents.get(id)) return false;
      this.db.delete(agents).where(eq(agents.id, id)).run();
      return true;
    },
  };

  private checkAgentSlug(slug: string, exceptId?: number): ScopeError | null {
    if (!isValidSlug(slug)) return { error: SLUG_RULE, status: 400 };
    const clash = this.agents.bySlug(slug);
    if (clash && clash.id !== exceptId) return { error: `Slug "${slug}" is already in use`, status: 409 };
    return null;
  }

  readonly matrix: ScopedMatrix = {
    forAgent: (agentId) => {
      if (!this.agents.get(agentId)) return [];
      const rows = this.db
        .select({ serverId: agentServers.serverId, enabled: agentServers.enabled })
        .from(agentServers)
        .where(eq(agentServers.agentId, agentId))
        .all();
      const enabled = new Map(rows.map((m) => [m.serverId, m.enabled]));
      return this.switchableServerIds().map((serverId) => ({ serverId, enabled: enabled.get(serverId) ?? false }));
    },

    set: (agentId, serverId, enabled) => {
      if (!this.agents.get(agentId) || !this.switchableServerIds().includes(serverId)) return false;
      this.db
        .insert(agentServers)
        .values({ agentId, serverId, enabled })
        .onConflictDoUpdate({ target: [agentServers.agentId, agentServers.serverId], set: { enabled } })
        .run();
      return true;
    },

    switchable: () => [
      ...this.servers.list().map((s) => ({
        name: s.slug,
        serverId: s.id,
        serverName: s.name,
        description: s.description,
        type: s.type,
        enabled: s.enabled,
        available: s.enabled,
      })),
      ...this.receivedShares(),
    ],

    reachable: (agentId) => {
      if (!this.agents.get(agentId)) return [];
      const on = new Set(
        this.db
          .select({ serverId: agentServers.serverId })
          .from(agentServers)
          .where(and(eq(agentServers.agentId, agentId), eq(agentServers.enabled, true)))
          .all()
          .map((r) => r.serverId),
      );
      return this.matrix.switchable().filter((s) => on.has(s.serverId) && (s.sharedBy === undefined || s.available));
    },
  };

  private ownedShareRows() {
    return this.db
      .select({ share: shares, username: users.username })
      .from(shares)
      .innerJoin(servers, eq(servers.id, shares.serverId))
      .innerJoin(users, eq(users.id, shares.recipientUserId))
      .where(eq(servers.userId, this.uid))
      .orderBy(shares.id)
      .all()
      .map(({ share, username }): OwnedShare => ({
        id: share.id,
        serverId: share.serverId,
        username,
        status: share.status,
        callCount: share.callCount,
        lastUsedAt: share.lastUsedAt,
        createdAt: share.createdAt,
      }));
  }

  readonly shares: ScopedShares = {
    recordUse: (shareId) => {
      this.db
        .update(shares)
        .set({ callCount: sql`${shares.callCount} + 1`, lastUsedAt: Date.now() })
        .where(and(eq(shares.id, shareId), eq(shares.recipientUserId, this.uid)))
        .run();
    },

    forServer: (serverId) =>
      this.servers.get(serverId) ? this.ownedShareRows().filter((s) => s.serverId === serverId) : undefined,

    summaries: () => {
      const bySever = new Map<number, OwnedShare[]>();
      for (const share of this.ownedShareRows()) {
        bySever.set(share.serverId, [...(bySever.get(share.serverId) ?? []), share]);
      }
      return bySever;
    },

    offer: (serverId, username) => {
      if (!this.servers.get(serverId)) return { error: "Not found", status: 404 };
      const recipient = getUserByUsername(this.db, username);
      if (!recipient) return { error: `No user named "${username}"`, status: 404 };
      if (recipient.id === this.uid) return { error: "You can't share a server with yourself", status: 400 };
      if (recipient.disabledAt !== null) return { error: `"${username}" is disabled`, status: 400 };
      const existing = this.db
        .select({ id: shares.id })
        .from(shares)
        .where(and(eq(shares.serverId, serverId), eq(shares.recipientUserId, recipient.id)))
        .get();
      if (existing) return { error: `Already shared with "${username}"`, status: 409 };

      const row = this.db
        .insert(shares)
        .values({ serverId, recipientUserId: recipient.id, status: "offered", createdAt: Date.now() })
        .returning()
        .get();
      return { share: this.ownedShareRows().find((s) => s.id === row.id)! };
    },

    revoke: (serverId, shareId) => {
      if (!this.servers.get(serverId)) return undefined;
      const share = this.db
        .select()
        .from(shares)
        .where(and(eq(shares.id, shareId), eq(shares.serverId, serverId)))
        .get();
      if (!share) return undefined;
      // The recipient's agents come first: once the rows are gone there is nobody left to tell.
      const affectedAgentIds = this.agentsWithRows(share.recipientUserId, serverId);
      this.dropShare(share.id, share.recipientUserId, serverId, affectedAgentIds);
      return { affectedAgentIds };
    },

    received: () => this.receivedRows().map(toReceived),

    checkAlias: (alias, exceptShareId) => {
      if (!isValidSlug(alias)) return { error: SLUG_RULE.replace("Slug", "Alias"), status: 400 };
      if (isReservedSlug(alias)) {
        return { error: `Alias "${alias}" is reserved for the switchboard's own tools`, status: 400 };
      }
      if (this.servers.bySlug(alias)) return { error: `"${alias}" is already the slug of one of your servers`, status: 409 };
      if (this.receivedShares().some((s) => s.name === alias && s.shareId !== exceptShareId)) {
        return { error: `"${alias}" is already the alias of another shared server`, status: 409 };
      }
      return null;
    },

    accept: (shareId, alias) => {
      const share = this.receivedShare(shareId);
      if (!share) return { error: "Not found", status: 404 };
      if (share.status === "accepted") return { error: "Already accepted", status: 409 };
      const bad = this.shares.checkAlias(alias);
      if (bad) return bad;

      this.db.update(shares).set({ status: "accepted", alias }).where(eq(shares.id, shareId)).run();
      const enabledAgentIds: number[] = [];
      if (this.settings.get("autoEnableNewServers")) {
        for (const agent of this.agents.list()) {
          if (this.matrix.set(agent.id, share.serverId, true)) enabledAgentIds.push(agent.id);
        }
      }
      return { share: this.receivedShare(shareId)!, enabledAgentIds };
    },

    decline: (shareId) => {
      const share = this.receivedShare(shareId);
      if (share?.status !== "offered") return false;
      this.db.delete(shares).where(eq(shares.id, shareId)).run();
      return true;
    },

    rename: (shareId, alias) => {
      const share = this.receivedShare(shareId);
      if (share?.status !== "accepted") return { error: "Not found", status: 404 };
      const bad = this.shares.checkAlias(alias, shareId);
      if (bad) return bad;
      this.db.update(shares).set({ alias }).where(eq(shares.id, shareId)).run();
      return {
        share: this.receivedShare(shareId)!,
        affectedAgentIds: this.agentsWithRows(this.uid, share.serverId, true),
      };
    },

    setEnabled: (shareId, enabled) => {
      const share = this.receivedShare(shareId);
      if (share?.status !== "accepted") return undefined;
      this.db.update(shares).set({ enabled }).where(eq(shares.id, shareId)).run();
      return {
        share: this.receivedShare(shareId)!,
        affectedAgentIds: this.agentsWithRows(this.uid, share.serverId, true),
      };
    },

    remove: (shareId) => {
      const share = this.receivedShare(shareId);
      if (share?.status !== "accepted") return undefined;
      const affectedAgentIds = this.agentsWithRows(this.uid, share.serverId);
      this.dropShare(shareId, this.uid, share.serverId, affectedAgentIds);
      return { affectedAgentIds };
    },
  };

  /** Deletes a share together with its recipient's matrix rows for the server (never the owner's own). */
  private dropShare(shareId: number, recipientId: number, serverId: number, recipientAgentIds: number[]): void {
    this.db.transaction((tx) => {
      if (recipientAgentIds.length > 0) {
        tx.delete(agentServers)
          .where(and(eq(agentServers.serverId, serverId), inArray(agentServers.agentId, recipientAgentIds)))
          .run();
      }
      tx.delete(shares).where(and(eq(shares.id, shareId), eq(shares.recipientUserId, recipientId))).run();
    });
  }

  private mine(): SQL {
    return eq(serverRequests.userId, this.uid);
  }

  readonly requests: ScopedRequests = {
    list: () => this.db.select().from(serverRequests).where(this.mine()).orderBy(desc(serverRequests.id)).all(),

    get: (id) =>
      this.db
        .select()
        .from(serverRequests)
        .where(and(this.mine(), eq(serverRequests.id, id)))
        .get(),

    // The slug fallback covers rows filed before an agent was recreated; never widens past this
    // user, so another user's agent of the same slug can't read them.
    forAgent: (agent) =>
      this.db
        .select()
        .from(serverRequests)
        .where(
          and(
            this.mine(),
            or(eq(serverRequests.requestedByAgentId, agent.id), eq(serverRequests.requestedByAgentSlug, agent.slug)),
          ),
        )
        .orderBy(desc(serverRequests.id))
        .all(),

    file: (input) => {
      const escalated = input.payload?.type === "stdio" && !this.canRunLocalCommands;
      const id = this.db
        .insert(serverRequests)
        .values({
          requestedByAgentId: input.agentId,
          requestedByAgentSlug: input.agentSlug,
          userId: this.uid,
          escalated,
          kind: input.kind,
          // Encrypted at rest: a pasted config can carry env values and bearer tokens.
          payloadJsonEnc: input.payload ? encrypt(JSON.stringify(input.payload)) : null,
          reason: input.reason ?? null,
          status: "pending",
          createdAt: Date.now(),
        })
        .returning({ id: serverRequests.id })
        .get().id;
      return { id, escalated };
    },

    resolve: (id, outcome) =>
      this.db
        .update(serverRequests)
        .set({ status: outcome.status, resolutionNote: outcome.note ?? null, resolvedAt: Date.now() })
        .where(and(this.mine(), eq(serverRequests.id, id), eq(serverRequests.status, "pending")))
        .run().changes > 0,
  };

  private myLogs(extra?: SQL): SQL {
    return extra ? and(eq(requestLogs.userId, this.uid), extra)! : eq(requestLogs.userId, this.uid);
  }

  readonly logs: ScopedLogs = {
    list: (filter, limit) =>
      this.db
        .select(LOG_SUMMARY_COLUMNS)
        .from(requestLogs)
        .where(this.myLogs(logWhere(filter)))
        .orderBy(desc(requestLogs.id))
        .limit(limit)
        .all(),

    get: (id) => this.db.select().from(requestLogs).where(this.myLogs(eq(requestLogs.id, id))).get(),

    summary: (id) => this.db.select(LOG_SUMMARY_COLUMNS).from(requestLogs).where(this.myLogs(eq(requestLogs.id, id))).get(),

    record: (row) =>
      this.db
        .insert(requestLogs)
        .values({ ...row, userId: this.uid })
        .returning({ id: requestLogs.id })
        .get().id,

    complete: (id, patch) => {
      this.db.update(requestLogs).set(patch).where(this.myLogs(eq(requestLogs.id, id))).run();
    },

    // SQLite has no percentile function, so we pick the nth row of the sorted durations instead.
    stats: (since) => {
      const recent = gte(requestLogs.ts, since);
      const tally = (extra?: SQL) =>
        this.db
          .select({ n: count() })
          .from(requestLogs)
          .where(this.myLogs(extra ? and(recent, extra) : recent))
          .get()?.n ?? 0;

      const total = tally();
      const errors = tally(eq(requestLogs.status, "error"));
      const timed = tally(isNotNull(requestLogs.durationMs));
      const percentile = (fraction: number): number | null => {
        if (timed === 0) return null;
        const row = this.db
          .select({ ms: requestLogs.durationMs })
          .from(requestLogs)
          .where(this.myLogs(and(recent, isNotNull(requestLogs.durationMs))))
          .orderBy(asc(requestLogs.durationMs))
          .limit(1)
          .offset(Math.min(timed - 1, Math.floor(timed * fraction)))
          .get();
        return row?.ms ?? null;
      };
      return { total, errors, medianMs: percentile(0.5), p95Ms: percentile(0.95) };
    },

    clear: () => this.db.delete(requestLogs).where(this.myLogs()).run().changes,
  };

  readonly settings: ScopedSettings = {
    get: (name) => {
      const raw = this.db
        .select({ value: userSettings.value })
        .from(userSettings)
        .where(and(eq(userSettings.userId, this.uid), eq(userSettings.key, USER_SETTING_KEYS[name])))
        .get()?.value;
      return raw === undefined ? USER_SETTING_DEFAULTS[name] : raw === "1";
    },

    set: (name, value) => {
      const v = value ? "1" : "0";
      this.db
        .insert(userSettings)
        .values({ userId: this.uid, key: USER_SETTING_KEYS[name], value: v })
        .onConflictDoUpdate({ target: [userSettings.userId, userSettings.key], set: { value: v } })
        .run();
    },
  };
}

function toReceived({
  share,
  server,
  owner,
}: {
  share: typeof shares.$inferSelect;
  server: ServerRow;
  owner: { username: string; disabledAt: number | null };
}): ReceivedShare {
  return {
    id: share.id,
    serverId: server.id,
    status: share.status,
    alias: share.alias,
    proposedAlias: `${owner.username}-${server.slug}`.slice(0, MAX_SLUG).replace(/-+$/, ""),
    ownerUsername: owner.username,
    serverName: server.name,
    description: server.description,
    enabled: share.enabled,
    ownerAvailable: server.enabled && owner.disabledAt === null,
    createdAt: share.createdAt,
  };
}

/** Empty maps are stored as "nothing", like an omitted one. */
function encryptMap(map: Record<string, string> | null | undefined): string | null {
  return map && Object.keys(map).length > 0 ? encrypt(JSON.stringify(map)) : null;
}

function decryptMap(enc: string | null): Record<string, string> | undefined {
  return enc ? (JSON.parse(decrypt(enc)) as Record<string, string>) : undefined;
}

/**
 * `serverSlug` null means the request spans every enabled server (tools/list, initialize …),
 * so those rows stay visible whichever server you filter by.
 */
function logWhere(filter: LogFilter): SQL | undefined {
  const clauses: (SQL | undefined)[] = [];

  if (filter.agent) clauses.push(eq(requestLogs.agentSlug, filter.agent));
  if (filter.server) clauses.push(or(eq(requestLogs.serverSlug, filter.server), isNull(requestLogs.serverSlug)));
  if (filter.method) clauses.push(eq(requestLogs.method, filter.method));
  if (filter.status === "error" || filter.status === "pending") clauses.push(eq(requestLogs.status, filter.status));
  if (filter.status === "slow") clauses.push(gt(requestLogs.durationMs, SLOW_MS));
  if (filter.before) clauses.push(lt(requestLogs.id, Number(filter.before)));

  const q = filter.q?.trim();
  if (q) {
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    clauses.push(
      or(
        like(requestLogs.target, pattern),
        like(requestLogs.method, pattern),
        like(requestLogs.summary, pattern),
        like(requestLogs.errorMessage, pattern),
        like(requestLogs.agentSlug, pattern),
      ),
    );
  }

  const defined = clauses.filter((c): c is SQL => c !== undefined);
  return defined.length === 0 ? undefined : and(...defined);
}
