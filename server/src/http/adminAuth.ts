import crypto from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const COOKIE = "gw_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class AdminSessionStore {
  private sessions = new Map<string, number>(); // id → createdAt

  create(): string {
    const id = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(id, Date.now());
    return id;
  }

  has(id: string | undefined): boolean {
    if (!id) return false;
    const createdAt = this.sessions.get(id);
    if (createdAt == null) return false;
    if (Date.now() - createdAt > SESSION_TTL_MS) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  delete(id: string | undefined): void {
    if (id) this.sessions.delete(id);
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

export function adminAuthMiddleware(store: AdminSessionStore) {
  return async (c: Context, next: Next) => {
    if (!store.has(getSessionId(c))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}
