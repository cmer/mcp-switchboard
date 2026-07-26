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
