/**
 * Edited env vars / headers arrive as a full map in which a `null` value means "keep the stored
 * value for this key" (the browser never sees secret values, so it can't send them back).
 * Keys left out are dropped. Returns an error string when a key has nothing to keep.
 */
export function mergeSecrets(
  label: string,
  stored: Record<string, string> | undefined,
  edited: Record<string, string | null> | undefined,
): { value: Record<string, string> | undefined } | { error: string } {
  if (!edited) return { value: stored };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(edited)) {
    if (value !== null) out[key] = value;
    else if (stored && key in stored) out[key] = stored[key];
    else return { error: `${label} "${key}" has no stored value to keep` };
  }
  return { value: out };
}
