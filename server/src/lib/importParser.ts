import { slugify } from "./slug.js";

export interface ParsedServer {
  name: string;
  slug: string;
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  authType: "none" | "bearer" | "headers" | "oauth";
  bearerToken?: string;
  headers?: Record<string, string>;
}

/**
 * Parse pasted MCP server config. Accepts:
 *  - one or more `claude mcp add …` / `claude mcp add-json …` CLI lines
 *  - JSON: `{ "mcpServers": { name: {…} } }`, a bare `{ name: {…} }` map,
 *    or a single server object `{ "command": … }` / `{ "url": … }`
 * Throws Error with a user-facing message on unparseable input.
 */
export function parseImport(text: string): ParsedServer[] {
  let input = text.trim();
  if (!input) throw new Error("Nothing to parse");

  // strip markdown code fences
  input = input.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();

  if (input.startsWith("{")) return parseJsonConfig(input);
  if (/\bmcp\s+add(-json)?\b/.test(input)) return parseCliLines(input);
  throw new Error('Expected JSON starting with "{" or a "claude mcp add …" command');
}

/* ---------- JSON ---------- */

interface JsonServerConfig {
  type?: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function parseJsonConfig(input: string): ParsedServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  // single unnamed server object: { "command": … } or { "url": … }
  if (typeof obj.command === "string" || typeof obj.url === "string") {
    const cfg = obj as JsonServerConfig;
    const fallback =
      typeof cfg.url === "string"
        ? new URL(cfg.url).hostname.replace(/^mcp\./, "").replace(/\.(com|app|dev|io|ai|net|org)$/, "")
        : inferNameFromCommand(cfg.command ?? "", cfg.args ?? []);
    return [fromJsonEntry(fallback, cfg)];
  }

  const map = (obj.mcpServers ?? obj) as Record<string, unknown>;
  const entries = Object.entries(map).filter(
    ([, v]) => typeof v === "object" && v !== null && !Array.isArray(v),
  );
  if (entries.length === 0) {
    throw new Error('No servers found — expected { "mcpServers": { "name": { … } } }');
  }
  return entries.map(([name, cfg]) => fromJsonEntry(name, cfg as JsonServerConfig));
}

function fromJsonEntry(name: string, cfg: JsonServerConfig): ParsedServer {
  const declared = (cfg.type ?? cfg.transport ?? "").toLowerCase();
  const type: ParsedServer["type"] =
    declared === "sse" ? "sse" : declared === "http" || declared === "streamable-http" || declared === "streamable_http"
      ? "http"
      : declared === "stdio"
        ? "stdio"
        : cfg.url
          ? "http"
          : "stdio";

  const base = { name, slug: validSlugFrom(name) };
  if (type === "stdio") {
    if (!cfg.command) throw new Error(`"${name}": stdio server has no command`);
    return {
      ...base,
      type,
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env && Object.keys(cfg.env).length > 0 ? cfg.env : undefined,
      authType: "none",
    };
  }
  if (!cfg.url) throw new Error(`"${name}": remote server has no url`);
  return { ...base, type, url: cfg.url, ...authFromHeaders(cfg.headers) };
}

/* ---------- CLI ---------- */

function parseCliLines(input: string): ParsedServer[] {
  // join shell line-continuations, then parse each command line
  const joined = input.replace(/\\\s*\n/g, " ");
  const lines = joined
    .split("\n")
    .map((l) => l.trim().replace(/^\$\s+/, ""))
    .filter((l) => /\bmcp\s+add(-json)?\b/.test(l));
  if (lines.length === 0) throw new Error('No "claude mcp add" command found');
  return lines.map(parseCliLine);
}

function parseCliLine(line: string): ParsedServer {
  const tokens = tokenize(line);
  const mcpIdx = tokens.findIndex((t, i) => t === "mcp" && (tokens[i + 1] === "add" || tokens[i + 1] === "add-json"));
  if (mcpIdx < 0) throw new Error(`Not an mcp add command: ${line}`);
  const isAddJson = tokens[mcpIdx + 1] === "add-json";
  let rest = tokens.slice(mcpIdx + 2);

  if (isAddJson) {
    const [name, json] = rest.filter((t) => !t.startsWith("-"));
    if (!name || !json) throw new Error("add-json needs a name and a JSON blob");
    return fromJsonEntry(name, JSON.parse(json) as JsonServerConfig);
  }

  let transport: "stdio" | "http" | "sse" = "stdio";
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const positionals: string[] = [];
  let afterDashDash: string[] | null = null;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (afterDashDash !== null) {
      afterDashDash.push(tok);
      continue;
    }
    if (tok === "--") {
      afterDashDash = [];
      continue;
    }
    // Once we have <name> <command>, remaining tokens (flags included) belong to the command.
    if (transport === "stdio" && positionals.length >= 2) {
      positionals.push(tok);
      continue;
    }
    if (tok === "--transport" || tok === "-t") {
      const val = (rest[++i] ?? "").toLowerCase();
      if (val === "http" || val === "sse" || val === "stdio") transport = val;
      else throw new Error(`Unknown transport "${val}"`);
      continue;
    }
    if (tok === "--env" || tok === "-e") {
      const kv = rest[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
      continue;
    }
    if (tok === "--header" || tok === "-H") {
      const hv = rest[++i] ?? "";
      const sep = hv.indexOf(":") >= 0 ? hv.indexOf(":") : hv.indexOf("=");
      if (sep > 0) headers[hv.slice(0, sep).trim()] = hv.slice(sep + 1).trim();
      continue;
    }
    if (tok === "--scope" || tok === "-s") {
      i++; // consumed, irrelevant for the switchboard
      continue;
    }
    if (tok.startsWith("-")) continue; // unknown flag — skip conservatively
    positionals.push(tok);
  }

  const name = positionals.shift();
  if (!name) throw new Error("Missing server name in mcp add command");
  const base = { name, slug: validSlugFrom(name) };

  if (transport === "http" || transport === "sse") {
    const url = positionals.find((p) => /^https?:\/\//.test(p));
    if (!url) throw new Error(`"${name}": missing URL for ${transport} transport`);
    return { ...base, type: transport, url, ...authFromHeaders(headers) };
  }

  const cmdTokens = afterDashDash ?? positionals;
  const command = cmdTokens.shift();
  if (!command) throw new Error(`"${name}": missing command (use: claude mcp add ${name} -- npx …)`);
  return {
    ...base,
    type: "stdio",
    command,
    args: cmdTokens,
    env: Object.keys(env).length > 0 ? env : undefined,
    authType: "none",
  };
}

/* ---------- shared helpers ---------- */

function authFromHeaders(headers: Record<string, string> | undefined): Pick<ParsedServer, "authType" | "bearerToken" | "headers"> {
  if (!headers || Object.keys(headers).length === 0) return { authType: "none" };
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
  if (authKey && Object.keys(headers).length === 1) {
    const m = /^Bearer\s+(.+)$/i.exec(headers[authKey]);
    if (m) return { authType: "bearer", bearerToken: m[1] };
  }
  return { authType: "headers", headers };
}

function inferNameFromCommand(command: string, args: string[]): string {
  // e.g. npx -y @modelcontextprotocol/server-sequential-thinking → sequential-thinking
  const pkg = args.find((a) => !a.startsWith("-"));
  const source = pkg ?? command;
  const last = source.split("/").pop() ?? source;
  return last.replace(/^server-/, "").replace(/^mcp-/, "") || "server";
}

function validSlugFrom(name: string): string {
  const slug = slugify(name);
  if (!slug) throw new Error(`Cannot derive a slug from "${name}"`);
  return slug;
}

/** Minimal shell tokenizer: handles double/single quotes and backslash escapes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "\\" && i + 1 < line.length && '"\\'.includes(line[i + 1])) current += line[++i];
      else current += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken || current) tokens.push(current);
      current = "";
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken || current) tokens.push(current);
  return tokens;
}
