import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../../config.js";
import type { UserRow } from "../../db/schema.js";
import { MIN_PASSWORD_LENGTH, redeemSetupCode } from "../../core/setupCodes.js";
import { defaultUserId, getUser, getUserByUsername, isDefaultUser, listUsers, setPasswordHash } from "../../core/users.js";
import { hashPassword, verifyPassword } from "../../lib/crypto.js";
import {
  ACCESS_LOGOUT_PATH,
  defaultAccessVerifier,
  normalizeAudTags,
  normalizeTeamDomain,
} from "../../lib/cloudflareAccess.js";
import { userScope } from "../../core/userScope.js";
import {
  LOGIN_MODES,
  readAccessSettings,
  readLoginMode,
  readSetting,
  USER_SETTING_DEFAULTS,
  writeSetting,
  LOGIN_MODE_SETTING,
  ACCESS_AUD_TAGS_SETTING,
  ACCESS_TEAM_DOMAIN_SETTING,
} from "../../lib/settings.js";
import { clearSessionCookie, identify, requestAccessToken, setSessionCookie } from "../adminAuth.js";
import type { AppContext } from "../context.js";

const PASSWORD_LOGIN_OFF = "Password login is off: this instance signs in through Cloudflare Access";
const TOO_SHORT = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
const passwordSchema = z.object({ password: z.string().min(MIN_PASSWORD_LENGTH) });
const loginSchema = z.object({ username: z.string(), password: z.string() });
const setupCodeSchema = z.object({ username: z.string(), code: z.string().min(1), password: z.string() });
const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH),
});
const authSettingsSchema = z.object({
  // Instance settings (Admin only).
  instanceName: z.string().max(60).nullish(),
  loginMode: z.enum(LOGIN_MODES).optional(),
  accessTeamDomain: z.string().max(200).optional(),
  accessAudTags: z.array(z.string().max(200)).max(20).optional(),
  // Per-user settings.
  autoEnableNewServers: z.boolean().optional(),
  allowServerRequests: z.boolean().optional(),
  capturePayloads: z.boolean().optional(),
});

/** The keys of `authSettingsSchema` that govern the whole install rather than the caller. */
const INSTANCE_SETTING_KEYS = ["instanceName", "loginMode", "accessTeamDomain", "accessAudTags"] as const;

export function getSetting(ctx: AppContext, key: string): string | null {
  return readSetting(ctx.db, key);
}

function setSetting(ctx: AppContext, key: string, value: string): void {
  writeSetting(ctx.db, key, value);
}

/** What the UI may know about a user; never the password hash or setup code. */
export function serializeUser(ctx: AppContext, user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    email: user.email,
    canRunLocalCommands: user.canRunLocalCommands,
    isDefault: isDefaultUser(ctx.db, user.id),
  };
}

export function authRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  const defaultUserHash = () => getUser(ctx.db, defaultUserId(ctx.db))?.passwordHash ?? null;
  const who = (c: Context) => identify(c, ctx);
  const whoAmI = async (c: Context) => (await who(c)).user;
  const passwordLoginOff = () => readLoginMode(ctx.db) === "cloudflare";
  const signIn = (c: Parameters<typeof setSessionCookie>[0], user: UserRow) =>
    setSessionCookie(c, ctx.adminSessions.create(user.id));

  /** Null when this request carries a valid Access token, under `config`, for the Admin's own email. */
  const checkAdminAccess = async (
    c: Context,
    admin: UserRow,
    config: { teamDomain: string; audTags: string[] },
  ): Promise<string | null> => {
    if (!admin.email) {
      return "Set your own email on the Users page first: Cloudflare Access signs you in by email";
    }
    const token = requestAccessToken(c);
    if (!token) {
      return "This request has no Cloudflare Access token. Open the switchboard through your Access-protected hostname and try again";
    }
    const verdict = await (ctx.access ?? defaultAccessVerifier).verify(token, config);
    if (!verdict.ok) {
      return "The Cloudflare Access token on this request isn't valid for that team domain and AUD tag(s)";
    }
    if (verdict.email.toLowerCase() !== admin.email.trim().toLowerCase()) {
      return `Access sees you as ${verdict.email}, but your switchboard email is ${admin.email}`;
    }
    return null;
  };

  app.get("/me", async (c) => {
    const identity = await who(c);
    const user = identity.user;
    const loginMode = readLoginMode(ctx.db);
    const mine = user ? userScope(ctx.db, user).settings : undefined;
    const access = readAccessSettings(ctx.db);
    return c.json({
      // Only a genuine first run: with other users around, the Default user's missing password is
      // a leftover, not an invitation to claim the Admin.
      needsSetup: loginMode === "password" && defaultUserHash() === null && listUsers(ctx.db).length <= 1,
      authenticated: user !== undefined,
      loginMode,
      // Why a visitor isn't signed in, so the login page can say more than "sign in".
      ...(!user && loginMode === "cloudflare"
        ? { accessEmail: identity.accessEmail ?? null, accessError: identity.accessError ?? "no_token" }
        : {}),
      user: user ? serializeUser(ctx, user) : null,
      // The Admin's Access config (non-secret); empty until they set it up.
      ...(user?.role === "admin" ? { access: { teamDomain: access.teamDomain, audTags: access.audTags } } : {}),
      instanceName: getSetting(ctx, "instanceName") || null,
      // Per-user: the signed-in user's own values, or the defaults for a visitor who isn't.
      autoEnableNewServers: mine?.get("autoEnableNewServers") ?? USER_SETTING_DEFAULTS.autoEnableNewServers,
      allowServerRequests: mine?.get("allowServerRequests") ?? USER_SETTING_DEFAULTS.allowServerRequests,
      capturePayloads: mine?.get("capturePayloads") ?? USER_SETTING_DEFAULTS.capturePayloads,
      // null = the endpoint lives on this same origin, so the UI can use window.location.
      mcpBaseUrl: config.mcpPublicUrl,
    });
  });

  // First-run setup: the Default user exists from the start with no password; this sets it.
  app.post("/setup", async (c) => {
    if (passwordLoginOff()) return c.json({ error: PASSWORD_LOGIN_OFF }, 400);
    if (defaultUserHash() !== null) return c.json({ error: "Password already set" }, 409);
    if (listUsers(ctx.db).length > 1) return c.json({ error: "Setup is only for a first run" }, 409);
    const body = passwordSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: TOO_SHORT }, 400);
    const user = getUser(ctx.db, defaultUserId(ctx.db))!;
    setPasswordHash(ctx.db, user.id, hashPassword(body.data.password));
    signIn(c, user);
    return c.json({ ok: true });
  });

  app.post("/login", async (c) => {
    if (passwordLoginOff()) return c.json({ error: PASSWORD_LOGIN_OFF }, 400);
    const body = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Body must be { username, password }" }, 400);
    if (defaultUserHash() === null) {
      return c.json({ error: "No password set — complete setup first" }, 409);
    }
    const user = getUserByUsername(ctx.db, body.data.username.trim().toLowerCase());
    if (!user?.passwordHash || !verifyPassword(body.data.password, user.passwordHash)) {
      return c.json({ error: "Wrong username or password" }, 401);
    }
    if (user.disabledAt !== null) return c.json({ error: "This account is disabled — ask the Admin" }, 403);
    signIn(c, user);
    return c.json({ ok: true });
  });

  // "I have a setup code": spends the code, sets the user's password and signs them in.
  app.post("/setup-code", async (c) => {
    if (passwordLoginOff()) return c.json({ error: PASSWORD_LOGIN_OFF }, 400);
    const body = setupCodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Body must be { username, code, password }" }, 400);
    // Checked before the code is spent, so a too-short password doesn't cost them the code.
    if (body.data.password.length < MIN_PASSWORD_LENGTH) return c.json({ error: TOO_SHORT }, 400);
    const user = redeemSetupCode(ctx.db, body.data.username.trim().toLowerCase(), body.data.code, body.data.password);
    if (!user) return c.json({ error: "That setup code is wrong, expired or already used" }, 401);
    signIn(c, user);
    return c.json({ ok: true });
  });

  app.post("/logout", (c) => {
    // Access mode keeps no switchboard session: signing out means leaving Cloudflare's.
    if (passwordLoginOff()) return c.json({ ok: true, redirect: ACCESS_LOGOUT_PATH });
    ctx.adminSessions.delete(clearSessionCookie(c));
    return c.json({ ok: true, redirect: null });
  });

  // Change your own password. Requires the current password, unless the user has none yet.
  app.post("/change-password", async (c) => {
    if (passwordLoginOff()) return c.json({ error: PASSWORD_LOGIN_OFF }, 400);
    const user = await whoAmI(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = changePasswordSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: `New ${TOO_SHORT.toLowerCase()}` }, 400);
    if (user.passwordHash !== null) {
      if (!body.data.currentPassword || !verifyPassword(body.data.currentPassword, user.passwordHash)) {
        return c.json({ error: "Current password is wrong" }, 401);
      }
    }
    setPasswordHash(ctx.db, user.id, hashPassword(body.data.newPassword));
    // The user's other browsers die; this one gets a fresh session.
    ctx.adminSessions.deleteForUser(user.id);
    signIn(c, user);
    return c.json({ ok: true });
  });

  // Settings: the caller's own, plus the instance's (name, login mode, Access config) for the Admin.
  app.post("/settings", async (c) => {
    const user = await whoAmI(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = authSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid settings" }, 400);
    const data = body.data;

    if (user.role !== "admin" && INSTANCE_SETTING_KEYS.some((key) => data[key] !== undefined)) {
      return c.json({ error: "Only the Admin can change instance settings" }, 403);
    }
    const currentMode = readLoginMode(ctx.db);
    const nextMode = data.loginMode ?? currentMode;
    // The Default user's password is the way back in if Access ever locks everyone out, and the
    // only thing standing between a passwordless Admin and anyone who can reach the login page.
    if (currentMode !== nextMode && defaultUserHash() === null) {
      const name = getUser(ctx.db, defaultUserId(ctx.db))!.username;
      if (nextMode === "cloudflare") {
        return c.json({ error: `Set a password for ${name} first — it's the way back in if Access ever locks you out` }, 400);
      }
      return c.json({ error: `Set a password for ${name} before switching back to password login` }, 400);
    }

    // The Access config as it would be after this request (saved values under the new ones).
    let accessConfig: { teamDomain: string; audTags: string[] } | undefined;
    if (data.accessTeamDomain !== undefined || data.accessAudTags !== undefined || nextMode === "cloudflare") {
      const saved = readAccessSettings(ctx.db);
      const teamDomain = data.accessTeamDomain !== undefined ? normalizeTeamDomain(data.accessTeamDomain) : saved.teamDomain;
      const audTags = data.accessAudTags !== undefined ? normalizeAudTags(data.accessAudTags) : saved.audTags;
      if (data.accessTeamDomain !== undefined && !teamDomain) {
        return c.json({ error: "That isn't a Cloudflare Access team domain (expected <team>.cloudflareaccess.com)" }, 400);
      }
      if (teamDomain && audTags.length > 0) accessConfig = { teamDomain, audTags };
      else if (nextMode === "cloudflare") {
        return c.json({ error: "Cloudflare Access needs a team domain and at least one AUD tag" }, 400);
      }
    }

    // Switching to Access mode, or changing its config while in it, is only accepted when this very
    // request proves the new config lets the Admin back in: a valid Access token (under the NEW
    // config) for the Admin's own email. Otherwise a typo would lock everyone out.
    const accessChange = nextMode === "cloudflare" && (currentMode !== "cloudflare" || data.accessTeamDomain !== undefined || data.accessAudTags !== undefined);
    if (accessChange) {
      const problem = await checkAdminAccess(c, user, accessConfig!);
      if (problem) return c.json({ error: problem }, 400);
    }

    if (data.instanceName !== undefined) setSetting(ctx, "instanceName", (data.instanceName ?? "").trim());
    // Saved piecemeal, so the Admin can prepare the config while still in password mode.
    if (data.accessTeamDomain !== undefined) setSetting(ctx, ACCESS_TEAM_DOMAIN_SETTING, normalizeTeamDomain(data.accessTeamDomain)!);
    if (data.accessAudTags !== undefined) setSetting(ctx, ACCESS_AUD_TAGS_SETTING, JSON.stringify(normalizeAudTags(data.accessAudTags)));
    if (data.loginMode !== undefined) {
      setSetting(ctx, LOGIN_MODE_SETTING, data.loginMode);
      // Cookies are not honoured in Access mode, so don't leave year-long ones lying in wait for
      // the day the Admin switches back.
      if (data.loginMode === "cloudflare" && currentMode !== "cloudflare") ctx.adminSessions.deleteAll();
      // Back to passwords: the Admin just proved who they are, so they stay signed in.
      if (data.loginMode === "password" && currentMode === "cloudflare") signIn(c, user);
    }

    const mine = userScope(ctx.db, user).settings;
    for (const name of ["autoEnableNewServers", "allowServerRequests", "capturePayloads"] as const) {
      if (data[name] !== undefined) mine.set(name, data[name]);
    }

    return c.json({ ok: true });
  });

  return app;
}
