import { eq, sql } from "drizzle-orm";
import { DEFAULT_USER_SETTING, type Db } from "../db/index.js";
import { adminSessions, users, type UserRow } from "../db/schema.js";
import { readSetting } from "../lib/settings.js";
import { isValidSlug } from "../lib/slug.js";

/**
 * The `users` table. Deleting a user takes their servers, agents, logs, requests, settings and
 * received shares with them through ON DELETE CASCADE; stopping their connections and live agent
 * sessions is the caller's job. The Default user (created by `initDb`) can be neither disabled nor
 * deleted, and stays an Admin.
 */

export class UserError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface CreateUserInput {
  username: string;
  email?: string | null;
  role?: UserRow["role"];
  canRunLocalCommands?: boolean;
}

/** Set by `initDb` on every install, so a missing marker is a broken database, not a state. */
export function defaultUserId(db: Db): number {
  const raw = readSetting(db, DEFAULT_USER_SETTING);
  if (raw === null) throw new Error("No Default user — the database was not initialised by initDb()");
  return Number(raw);
}

export function isDefaultUser(db: Db, id: number): boolean {
  return defaultUserId(db) === id;
}

export function listUsers(db: Db): UserRow[] {
  return db.select().from(users).orderBy(users.id).all();
}

export function getUser(db: Db, id: number): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function getUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.username, username)).get();
}

/** Who anyone may share with: the other active users' usernames, nothing else about them. */
export function userDirectory(db: Db, exceptUserId: number): string[] {
  return listUsers(db)
    .filter((u) => u.id !== exceptUserId && u.disabledAt === null)
    .map((u) => u.username);
}

/** Case-insensitive, as Cloudflare Access matching needs. */
export function getUserByEmail(db: Db, email: string): UserRow | undefined {
  return db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email.trim()})`)
    .get();
}

export function createUser(db: Db, input: CreateUserInput): UserRow {
  checkUsername(db, input.username);
  const email = normaliseEmail(db, input.email ?? null);
  return db
    .insert(users)
    .values({
      username: input.username,
      email,
      role: input.role ?? "user",
      canRunLocalCommands: input.canRunLocalCommands ?? false,
      createdAt: Date.now(),
    })
    .returning()
    .get();
}

/** Breaks the user's `/mcp/<username>/…` URLs; the Default user's legacy URLs survive (by id). */
export function renameUser(db: Db, id: number, username: string): UserRow {
  const user = mustGet(db, id);
  if (user.username === username) return user;
  checkUsername(db, username);
  return update(db, id, { username });
}

export function setUserEmail(db: Db, id: number, email: string | null): UserRow {
  mustGet(db, id);
  return update(db, id, { email: normaliseEmail(db, email, id) });
}

export function setUserRole(db: Db, id: number, role: UserRow["role"]): UserRow {
  mustGet(db, id);
  if (role !== "admin" && isDefaultUser(db, id)) throw new UserError("The Default user is always an Admin", 400);
  return update(db, id, { role });
}

export function setCanRunLocalCommands(db: Db, id: number, value: boolean): UserRow {
  mustGet(db, id);
  return update(db, id, { canRunLocalCommands: value });
}

/** Also signs the user out everywhere; their agents and connections are the caller's to stop. */
export function disableUser(db: Db, id: number): UserRow {
  const user = mustGet(db, id);
  if (isDefaultUser(db, id)) throw new UserError("The Default user can't be disabled", 400);
  if (user.disabledAt !== null) return user;
  const row = update(db, id, { disabledAt: Date.now() });
  dropUserSessions(db, id);
  return row;
}

/** Signs the user out of every browser (disable, password reset, password change). */
export function dropUserSessions(db: Db, id: number): void {
  db.delete(adminSessions).where(eq(adminSessions.userId, id)).run();
}

export function enableUser(db: Db, id: number): UserRow {
  mustGet(db, id);
  return update(db, id, { disabledAt: null });
}

export function deleteUser(db: Db, id: number): void {
  mustGet(db, id);
  if (isDefaultUser(db, id)) throw new UserError("The Default user can't be deleted", 400);
  db.delete(users).where(eq(users.id, id)).run();
}

export function getPasswordHash(db: Db, id: number): string | null {
  return mustGet(db, id).passwordHash;
}

export function setPasswordHash(db: Db, id: number, hash: string | null): void {
  mustGet(db, id);
  update(db, id, { passwordHash: hash });
}

function mustGet(db: Db, id: number): UserRow {
  const user = getUser(db, id);
  if (!user) throw new UserError("User not found", 404);
  return user;
}

function update(db: Db, id: number, set: Partial<typeof users.$inferInsert>): UserRow {
  return db.update(users).set(set).where(eq(users.id, id)).returning().get();
}

/** A username is a path segment of `/mcp/<username>/<agent-slug>`, so it follows the slug rule. */
function checkUsername(db: Db, username: string): void {
  if (!isValidSlug(username)) {
    throw new UserError("Username must be 1-64 chars of a-z, 0-9, and dashes", 400);
  }
  if (getUserByUsername(db, username)) throw new UserError(`Username "${username}" is already taken`, 409);
}

/** Trimmed, empty → null, and unique ignoring case (the `lower(email)` index backs this up). */
function normaliseEmail(db: Db, email: string | null, selfId?: number): string | null {
  const trimmed = email?.trim() || null;
  if (trimmed === null) return null;
  if (!/^[^\s@]+@[^\s@]+$/.test(trimmed)) throw new UserError("That doesn't look like an email address", 400);
  const clash = getUserByEmail(db, trimmed);
  if (clash && clash.id !== selfId) throw new UserError(`Email "${trimmed}" is already in use`, 409);
  return trimmed;
}
