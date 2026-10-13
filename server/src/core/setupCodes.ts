import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { users, type UserRow } from "../db/schema.js";
import { hashPassword, timingSafeEqualStr } from "../lib/crypto.js";
import { newPairingCode, normalizePairingCode, sha256 } from "../oauth/agentOAuth.js";
import { dropUserSessions, getUser, getUserByUsername, setPasswordHash, UserError } from "./users.js";

/**
 * Setup codes: how a user gets their first password (or a new one after the Admin resets it)
 * without the Admin ever knowing it. Minted and typed like agent pairing codes, but kept as a hash
 * on the user row, because a 24h code has to survive a restart.
 */

export const SETUP_CODE_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 4;
/** Same bound as pairing codes: this many wrong codes burns every outstanding one. */
const MAX_SETUP_FAILURES = 10;

// Per database handle rather than module-global, so a test's fresh db starts at zero.
const failures = new WeakMap<Db, number>();

export interface SetupCode {
  code: string;
  expiresAt: number;
}

/** Replaces any code the user already had. The plain code is returned once and never stored. */
export function issueSetupCode(db: Db, userId: number): SetupCode {
  if (!getUser(db, userId)) throw new UserError("User not found", 404);
  const code = newPairingCode();
  const expiresAt = Date.now() + SETUP_CODE_TTL_MS;
  db.update(users)
    .set({ setupCodeHash: sha256(normalizePairingCode(code)), setupCodeExpiresAt: expiresAt })
    .where(eq(users.id, userId))
    .run();
  return { code, expiresAt };
}

export function clearSetupCode(db: Db, userId: number): void {
  db.update(users).set({ setupCodeHash: null, setupCodeExpiresAt: null }).where(eq(users.id, userId)).run();
}

/**
 * The Admin's "reset password": the old password stops working, the user is signed out
 * everywhere, and a fresh setup code takes its place.
 */
export function resetUserPassword(db: Db, userId: number): SetupCode {
  setPasswordHash(db, userId, null);
  dropUserSessions(db, userId);
  return issueSetupCode(db, userId);
}

/**
 * Set a password directly, as the CLI does (shell access to the host is already full access, so no
 * code is involved): any pending setup code is void and every session is dropped.
 */
export function setUserPassword(db: Db, userId: number, password: string): void {
  setPasswordHash(db, userId, hashPassword(password));
  clearSetupCode(db, userId);
  dropUserSessions(db, userId);
}

/**
 * Spend a setup code: the user's password becomes `password`, the code is gone and every older
 * session is dropped (the caller signs them in afresh). Null on any miss — wrong, expired,
 * already spent, unknown or disabled user — and a miss counts towards burning all outstanding codes.
 */
export function redeemSetupCode(db: Db, username: string, code: string, password: string): UserRow | null {
  pruneExpired(db);
  const user = getUserByUsername(db, username);
  const presented = sha256(normalizePairingCode(code));
  if (
    !user ||
    user.disabledAt !== null ||
    user.setupCodeHash === null ||
    !timingSafeEqualStr(presented, user.setupCodeHash)
  ) {
    if ((failures.get(db) ?? 0) + 1 >= MAX_SETUP_FAILURES) {
      db.update(users).set({ setupCodeHash: null, setupCodeExpiresAt: null }).where(isNotNull(users.setupCodeHash)).run();
      failures.delete(db);
    } else {
      failures.set(db, (failures.get(db) ?? 0) + 1);
    }
    return null;
  }
  setUserPassword(db, user.id, password);
  return getUser(db, user.id) ?? null;
}

function pruneExpired(db: Db): void {
  db.update(users)
    .set({ setupCodeHash: null, setupCodeExpiresAt: null })
    .where(and(isNotNull(users.setupCodeExpiresAt), lt(users.setupCodeExpiresAt, Date.now())))
    .run();
  // Nothing outstanding means nothing left to burn, so an old streak of misses stops counting.
  if (!db.select({ id: users.id }).from(users).where(isNotNull(users.setupCodeHash)).get()) failures.delete(db);
}
