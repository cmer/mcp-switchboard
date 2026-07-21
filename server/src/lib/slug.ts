const SLUG_RE = /^[a-z0-9-]{1,64}$/;

/** "switchboard" is the prefix of the switchboard's own meta-tools (switchboard__list_servers). */
const RESERVED_SLUGS = new Set(["switchboard"]);

/** Slugs may not contain underscores so `<slug>__<name>` splits unambiguously. */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}
