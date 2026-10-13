import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { settings } from "../db/schema.js";

/** Key/value settings live in one table; values are always stored as text. */
export function readSetting(db: Db, key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

export function writeSetting(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export function readNumberSetting(db: Db, key: string, fallback: number): number {
  const raw = readSetting(db, key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function readBoolSetting(db: Db, key: string, fallback: boolean): boolean {
  const raw = readSetting(db, key);
  if (raw === null) return fallback;
  return raw === "1";
}

/** The keys that live in `user_settings` (Phase A's migration copies the same three). */
export const USER_SETTING_KEYS = {
  autoEnableNewServers: "autoEnableNewServers",
  allowServerRequests: "allowServerRequests",
  capturePayloads: "logs.capturePayloads",
} as const;

export type UserSettingName = keyof typeof USER_SETTING_KEYS;

/**
 * What an unset per-user key means. Read and written through `userScope(...).settings`: the
 * `user_settings` table belongs to the user-scoped data access like every other owned table.
 */
export const USER_SETTING_DEFAULTS: Record<UserSettingName, boolean> = {
  autoEnableNewServers: false,
  // On unless explicitly switched off — the request tools are the safe path for every agent.
  allowServerRequests: true,
  capturePayloads: true,
};

/** How a human signs in to the UI: with a password, or through Cloudflare Access. */
export const LOGIN_MODE_SETTING = "loginMode";
export const LOGIN_MODES = ["password", "cloudflare"] as const;
export type LoginMode = (typeof LOGIN_MODES)[number];

export function readLoginMode(db: Db): LoginMode {
  const raw = readSetting(db, LOGIN_MODE_SETTING);
  return LOGIN_MODES.find((m) => m === raw) ?? "password";
}

export const ACCESS_TEAM_DOMAIN_SETTING = "accessTeamDomain";
export const ACCESS_AUD_TAGS_SETTING = "accessAudTags";

/** The saved Access config; the team domain is stored normalised and the tags as a JSON array. */
export function readAccessSettings(db: Db): { teamDomain: string | null; audTags: string[] } {
  let audTags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readSetting(db, ACCESS_AUD_TAGS_SETTING) ?? "[]");
    if (Array.isArray(parsed)) audTags = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    // A mangled value reads as "no tags", which keeps Access mode closed rather than open.
  }
  return { teamDomain: readSetting(db, ACCESS_TEAM_DOMAIN_SETTING) || null, audTags };
}
