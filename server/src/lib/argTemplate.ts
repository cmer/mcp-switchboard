/**
 * `${VAR}` in a stdio server's arguments, filled in from that server's own env vars at spawn time
 * (the same syntax Claude Code's `.mcp.json` uses). `${VAR:-fallback}` uses the fallback when VAR
 * isn't set; `$${VAR}` is a literal `${VAR}`. Only the server's env map is consulted — never the
 * switchboard's own process env — and a missing variable is an error rather than an empty string.
 */
const PLACEHOLDER = /\$(\$?)\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function expandArgs(
  args: string[],
  env: Record<string, string>,
): { args: string[] } | { error: string } {
  const missing = new Set<string>();
  const out = args.map((arg) =>
    arg.replace(PLACEHOLDER, (match, escape: string, name: string, fallback: string | undefined) => {
      if (escape) return match.slice(1);
      if (Object.hasOwn(env, name)) return env[name];
      if (fallback !== undefined) return fallback;
      missing.add(name);
      return match;
    }),
  );
  if (missing.size === 0) return { args: out };
  const names = [...missing];
  return {
    error:
      `Argument${names.length > 1 ? "s use" : " uses"} ${names.map((n) => `\${${n}}`).join(", ")}, ` +
      `but the server has no env var ${names.join(", ")}.\n→ Edit the server and add it under Environment variables.`,
  };
}
