/**
 * Namespacing: every upstream server has a unique slug (no underscores allowed),
 * so `<slug>__<name>` always splits unambiguously on the FIRST `__`.
 */

const SEP = "__";

export function nsName(slug: string, name: string): string {
  return `${slug}${SEP}${name}`;
}

export function parseNsName(nsedName: string): { slug: string; name: string } | null {
  const idx = nsedName.indexOf(SEP);
  if (idx <= 0) return null;
  const slug = nsedName.slice(0, idx);
  const name = nsedName.slice(idx + SEP.length);
  if (name.length === 0) return null;
  return { slug, name };
}

/** Resource URIs are rewritten into a switchboard scheme so they route back to the owning server. */
export function nsResourceUri(slug: string, uri: string): string {
  return `sb://${slug}/${encodeURIComponent(uri)}`;
}

export function parseNsResourceUri(nsUri: string): { slug: string; uri: string } | null {
  const m = /^sb:\/\/([a-z0-9-]+)\/(.+)$/.exec(nsUri);
  if (!m) return null;
  try {
    return { slug: m[1], uri: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}
