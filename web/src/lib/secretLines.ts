/**
 * Stored env vars / headers in an edit form. Secret values never reach the browser, so each stored
 * key starts as a `KEY=••••••••` line: left masked it keeps its stored value, deleting the line
 * drops it, typing over the mask replaces it.
 */
export const SECRET_MASK = "••••••••";

export const maskedSecretLines = (keys: string[]) => keys.map((k) => `${k}=${SECRET_MASK}`).join("\n");

/** `KEY=value` lines → map; a still-masked stored key becomes `null` (keep stored). */
export function parseSecretLines(text: string, storedKeys: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = value === SECRET_MASK && storedKeys.includes(key) ? null : value;
  }
  return out;
}

export const secretLinesHint = (noun: string, hasStored: boolean, fallback: string) =>
  hasStored ? `${noun}=value per line · ${SECRET_MASK} keeps the stored value` : fallback;
