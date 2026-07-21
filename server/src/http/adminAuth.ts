import crypto from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq, lt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { adminSessions } from "../db/schema.js";

const COOKIE = "sb_session";
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Admin sessions persisted in SQLite so "remember me" survives restarts —
 * the cookie and the row both live for 365 days.
 */
export class AdminSessionStore {
  constructor(private db: Db) {
    this.prune();
  }

  private prune(): void {
    this.db.delete(adminSessions).where(lt(adminSessions.createdAt, Date.now() - SESSION_TTL_MS)).run();
  }

  create(): string {
    const id = crypto.randomBytes(32).toString("base64url");
    this.db.insert(adminSessions).values({ id, createdAt: Date.now() }).run();
    this.prune();
    return id;
  }

  has(id: string | undefined): boolean {
    if (!id) return false;
    const row = this.db.select().from(adminSessions).where(eq(adminSessions.id, id)).get();
    if (!row) return false;
    if (Date.now() - row.createdAt > SESSION_TTL_MS) {
      this.delete(id);
      return false;
    }
    return true;
  }

  delete(id: string | undefined): void {
    if (id) this.db.delete(adminSessions).where(eq(adminSessions.id, id)).run();
  }

  /** Invalidate every session (e.g. after a password change from a logged-out state). */
  deleteAll(): void {
    this.db.delete(adminSessions).run();
  }
}

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context): string | undefined {
  const id = getCookie(c, COOKIE);
  deleteCookie(c, COOKIE, { path: "/" });
  return id;
}

export function getSessionId(c: Context): string | undefined {
  return getCookie(c, COOKIE);
}

export function adminAuthMiddleware(store: AdminSessionStore, isAuthDisabled: () => boolean) {
  return async (c: Context, next: Next) => {
    if (!isAuthDisabled() && !store.has(getSessionId(c))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}
