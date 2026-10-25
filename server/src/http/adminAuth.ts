import crypto from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq, lt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { adminSessions, type UserRow } from "../db/schema.js";
import { dropUserSessions, getUser, getUserByEmail } from "../core/users.js";
import {
  ACCESS_COOKIE,
  accessTokenFrom,
  defaultAccessVerifier,
  type AccessVerifier,
} from "../lib/cloudflareAccess.js";
import { readAccessSettings, readLoginMode } from "../lib/settings.js";

declare module "hono" {
  /** Set by `adminAuthMiddleware` on every `/api/*` route except `/api/auth/*`. */
  interface ContextVariableMap {
    user: UserRow;
  }
}

const COOKIE = "sb_session";
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Admin sessions persisted in SQLite so "remember me" survives restarts —
 * the cookie and the row both live for 365 days. Each belongs to a user.
 */
export class AdminSessionStore {
  constructor(private db: Db) {
    this.prune();
  }

  private prune(): void {
    this.db.delete(adminSessions).where(lt(adminSessions.createdAt, Date.now() - SESSION_TTL_MS)).run();
  }

  create(userId: number): string {
    const id = crypto.randomBytes(32).toString("base64url");
    this.db.insert(adminSessions).values({ id, userId, createdAt: Date.now() }).run();
    this.prune();
    return id;
  }

  /**
   * The user a session belongs to. A disabled user is refused and their sessions are dropped
   * (a safety net: disabling already drops them, the CLI or a restore might not).
   */
  resolve(id: string | undefined): UserRow | undefined {
    if (!id) return undefined;
    const row = this.db.select().from(adminSessions).where(eq(adminSessions.id, id)).get();
    if (!row) return undefined;
    if (Date.now() - row.createdAt > SESSION_TTL_MS) {
      this.delete(id);
      return undefined;
    }
    const user = getUser(this.db, row.userId);
    if (!user) {
      this.delete(id);
      return undefined;
    }
    if (user.disabledAt !== null) {
      dropUserSessions(this.db, user.id);
      return undefined;
    }
    return user;
  }

  delete(id: string | undefined): void {
    if (id) this.db.delete(adminSessions).where(eq(adminSessions.id, id)).run();
  }

  /** Drop every session (the instance is leaving password mode). */
  deleteAll(): void {
    this.db.delete(adminSessions).run();
  }

  /** Sign a user out everywhere (password change, reset, disable). */
  deleteForUser(userId: number): void {
    dropUserSessions(this.db, userId);
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

export type AccessFailure = "no_token" | "invalid_token" | "unknown_email" | "disabled";

/** Who a request is, or (in Access mode) why it is nobody. */
export type Identity =
  | { user: UserRow }
  | { user?: undefined; accessError?: AccessFailure; accessEmail?: string | null };

/** What identifying a request needs; `AppContext` satisfies it. */
export interface IdentityDeps {
  db: Db;
  adminSessions: AdminSessionStore;
  /** Injectable for tests; defaults to the shared verifier that fetches Cloudflare's keys. */
  access?: AccessVerifier;
}

/** The Access JWT a request carries: the header, else the `CF_Authorization` cookie. */
export function requestAccessToken(c: Context): string | undefined {
  return accessTokenFrom(c.req.raw.headers, getCookie(c, ACCESS_COOKIE));
}

/**
 * Identify the caller. In Access mode the JWT is verified on every call (so removing someone in
 * Cloudflare bites when their token expires) and no switchboard session is read or created; the
 * email in the verified token is mapped to a user. Otherwise: the session cookie's user.
 */
export async function identify(c: Context, deps: IdentityDeps): Promise<Identity> {
  if (readLoginMode(deps.db) === "cloudflare") {
    const token = requestAccessToken(c);
    if (!token) return { accessError: "no_token", accessEmail: null };
    const access = readAccessSettings(deps.db);
    if (!access.teamDomain || access.audTags.length === 0) {
      return { accessError: "invalid_token", accessEmail: null };
    }
    const verdict = await (deps.access ?? defaultAccessVerifier).verify(token, {
      teamDomain: access.teamDomain,
      audTags: access.audTags,
    });
    if (!verdict.ok) return { accessError: "invalid_token", accessEmail: null };
    const user = getUserByEmail(deps.db, verdict.email);
    if (!user) return { accessError: "unknown_email", accessEmail: verdict.email };
    if (user.disabledAt !== null) return { accessError: "disabled", accessEmail: verdict.email };
    return { user };
  }
  const user = deps.adminSessions.resolve(getSessionId(c));
  return user ? { user } : {};
}

/** Who is making this request, or undefined. */
export async function requestUser(c: Context, deps: IdentityDeps): Promise<UserRow | undefined> {
  return (await identify(c, deps)).user;
}

/** Puts the signed-in user on the context (`c.get("user")`) for everything mounted behind it. */
export function adminAuthMiddleware(deps: IdentityDeps) {
  return async (c: Context, next: Next) => {
    const user = await requestUser(c, deps);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", user);
    await next();
  };
}

/** Admin-only routes: signed in as someone else is a 403, not a 401. */
export async function requireAdmin(c: Context, next: Next) {
  if (c.get("user").role !== "admin") return c.json({ error: "Admin only" }, 403);
  await next();
}
