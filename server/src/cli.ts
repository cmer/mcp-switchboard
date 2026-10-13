import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { closeDb, initDb, type Db } from "./db/index.js";
import { MIN_PASSWORD_LENGTH, setUserPassword } from "./core/setupCodes.js";
import { defaultUserId, getUser, getUserByUsername, listUsers, setUserEmail } from "./core/users.js";
import { adminSessions } from "./db/schema.js";
import { normalizeAudTags, normalizeTeamDomain } from "./lib/cloudflareAccess.js";
import {
  ACCESS_AUD_TAGS_SETTING,
  ACCESS_TEAM_DOMAIN_SETTING,
  LOGIN_MODE_SETTING,
  readAccessSettings,
  readLoginMode,
  writeSetting,
} from "./lib/settings.js";

/**
 * The `mcp-switchboard` subcommands that inspect and repair an install from the host (a lost
 * password, a wrong login mode, Cloudflare Access setup). They open the same SQLite file as the server but never start it, and are safe
 * to run beside a live server: sessions and setup codes are rows it re-reads on every request.
 */

export const USAGE = `Usage:
  mcp-switchboard                                Start the switchboard
  mcp-switchboard status [--json]                Show version, data dir, login mode, Access config, Default user
  mcp-switchboard user list [--json]             List users (never prints hashes or setup codes)
  mcp-switchboard user email <username> <email>  Set a user's email (what Cloudflare Access matches on)
  mcp-switchboard user email <username> --clear  Remove a user's email
  mcp-switchboard reset-password <username>      Set a user's password (prompts, no echo)
        [--password-stdin]                       Read the new password from stdin instead
  mcp-switchboard login-mode password            Switch the instance back to password login
  mcp-switchboard login-mode cloudflare          Switch to Cloudflare Access login
        --team-domain <team>.cloudflareaccess.com
        --aud <tag> [--aud <tag> ...]            AUD tag of each Access application (at least one)
  mcp-switchboard --help                         Show this message`;

/** Everything the CLI touches outside the database, so tests can drive it without a terminal. */
export interface CliIo {
  /** The package version, for `status`. */
  version: string;
  /** The data directory the database lives in, for `status`. */
  dataDir: string;
  out(message: string): void;
  err(message: string): void;
  /** True when stdin is an interactive terminal, so a hidden prompt is possible. */
  interactive: boolean;
  /** Prompt on the terminal without echoing what is typed. */
  promptHidden(question: string): Promise<string>;
  readStdin(): Promise<string>;
  openDb(): Db;
  closeDb(): void;
}

class CliError extends Error {}

export function resetPassword(db: Db, username: string, password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new CliError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const user = getUserByUsername(db, username);
  if (!user) throw new CliError(`No user named "${username}"`);
  setUserPassword(db, user.id, password);
}

/**
 * Back to password login: the way back in when Cloudflare Access is misconfigured. Switching Access
 * *on* is `enableCloudflareAccess`.
 */
export function setLoginMode(db: Db, mode: string): void {
  if (mode !== "password") throw new CliError(`Unknown login mode "${mode}" (expected: password or cloudflare)`);
  // An unclaimed Default user would let anyone who reaches the login page become the Admin.
  const admin = getUser(db, defaultUserId(db));
  if (admin && admin.passwordHash === null) {
    throw new CliError(`${admin.username} has no password yet: run \`mcp-switchboard reset-password ${admin.username}\` first`);
  }
  writeSetting(db, LOGIN_MODE_SETTING, mode);
}

/**
 * Stores the Access config, switches to Cloudflare Access login and signs everyone out. It applies
 * the Settings API's guards except the live-token check: the CLI is for a shell where the values
 * come straight from Cloudflare and shell access is already full access.
 */
export function enableCloudflareAccess(
  db: Db,
  input: { teamDomain: string; audTags: string[] },
): { teamDomain: string; audTags: string[]; adminUsername: string; adminEmail: string } {
  const teamDomain = normalizeTeamDomain(input.teamDomain);
  if (!teamDomain) {
    throw new CliError("That isn't a Cloudflare Access team domain (expected <team>.cloudflareaccess.com)");
  }
  const audTags = normalizeAudTags(input.audTags);
  if (audTags.length === 0) throw new CliError("Cloudflare Access needs at least one AUD tag (--aud <tag>)");

  const admin = getUser(db, defaultUserId(db))!;
  if (admin.passwordHash === null) {
    throw new CliError(
      `${admin.username} has no password: set one with \`mcp-switchboard reset-password ${admin.username}\` first. ` +
        "It's the way back in if Access ever locks you out",
    );
  }
  if (!admin.email?.trim()) {
    throw new CliError(
      `${admin.username} has no email: set one with \`mcp-switchboard user email ${admin.username} <email>\` first. ` +
        "Cloudflare Access signs you in by email",
    );
  }

  const switching = readLoginMode(db) !== "cloudflare";
  db.$client.transaction(() => {
    writeSetting(db, ACCESS_TEAM_DOMAIN_SETTING, teamDomain);
    writeSetting(db, ACCESS_AUD_TAGS_SETTING, JSON.stringify(audTags));
    writeSetting(db, LOGIN_MODE_SETTING, "cloudflare");
    // Cookies are not honoured in Access mode, so don't leave year-long ones lying in wait.
    if (switching) db.delete(adminSessions).run();
  })();
  return { teamDomain, audTags, adminUsername: admin.username, adminEmail: admin.email.trim() };
}

export function setEmail(db: Db, username: string, email: string | null): void {
  const user = getUserByUsername(db, username);
  if (!user) throw new CliError(`No user named "${username}"`);
  // The same checks as PATCH /api/users/:id: format, and unique ignoring case.
  setUserEmail(db, user.id, email);
}

export interface UserSummary {
  username: string;
  role: string;
  email: string | null;
  hasPassword: boolean;
  disabled: boolean;
  isDefault: boolean;
}

/** Everything about a user that is safe to print: never the hash or a setup code. */
export function summarizeUsers(db: Db): UserSummary[] {
  const defaultId = defaultUserId(db);
  return listUsers(db).map((u) => ({
    username: u.username,
    role: u.role,
    email: u.email,
    hasPassword: u.passwordHash !== null,
    disabled: u.disabledAt !== null,
    isDefault: u.id === defaultId,
  }));
}

export function instanceStatus(db: Db, info: { version: string; dataDir: string }) {
  const users = summarizeUsers(db);
  const admin = users.find((u) => u.isDefault)!;
  const access = readAccessSettings(db);
  return {
    version: info.version,
    dataDir: info.dataDir,
    loginMode: readLoginMode(db),
    access: { teamDomain: access.teamDomain, audTags: access.audTags },
    userCount: users.length,
    defaultUser: { username: admin.username, hasPassword: admin.hasPassword, email: admin.email },
  };
}

const yn = (b: boolean): string => (b ? "yes" : "no");

/** Flags that take a value, e.g. `--aud x` or `--aud=x`; everything else is positional. */
function parseArgs(
  args: string[],
  valueFlags: string[],
  boolFlags: string[],
): { positional: string[]; values: Record<string, string[]>; flags: Set<string> } | undefined {
  const positional: string[] = [];
  const values: Record<string, string[]> = {};
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [name, inline] = arg.startsWith("--") ? (arg.split(/=(.*)/s) as [string, string?]) : [arg, undefined];
    if (valueFlags.includes(name)) {
      const value = inline ?? args[++i];
      if (value === undefined) return undefined;
      (values[name] ??= []).push(value);
    } else if (boolFlags.includes(name) && inline === undefined) {
      flags.add(name);
    } else if (arg.startsWith("-")) {
      return undefined;
    } else {
      positional.push(arg);
    }
  }
  return { positional, values, flags };
}

/** Returns the process exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  if (command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case "reset-password": {
        const fromStdin = rest.includes("--password-stdin");
        const names = rest.filter((a) => a !== "--password-stdin");
        if (names.length !== 1 || names[0].startsWith("-")) return usageError(io);
        const db = io.openDb();
        try {
          // Fail on a typo'd username before asking anyone to type a password.
          if (!getUserByUsername(db, names[0])) throw new CliError(`No user named "${names[0]}"`);
          resetPassword(db, names[0], await readNewPassword(io, fromStdin));
        } finally {
          io.closeDb();
        }
        io.out(`Password for "${names[0]}" updated; their browser sessions were signed out.`);
        return 0;
      }
      case "status": {
        const parsed = parseArgs(rest, [], ["--json"]);
        if (!parsed || parsed.positional.length > 0) return usageError(io);
        const status = withDb(io, (db) => instanceStatus(db, { version: io.version, dataDir: io.dataDir }));
        if (parsed.flags.has("--json")) {
          io.out(JSON.stringify(status, null, 2));
          return 0;
        }
        io.out(
          [
            `Version:       ${status.version}`,
            `Data dir:      ${status.dataDir}`,
            `Login mode:    ${status.loginMode}`,
            `Access:        ${status.access.teamDomain ?? "-"}`,
            `AUD tags:      ${status.access.audTags.length > 0 ? status.access.audTags.join(", ") : "-"}`,
            `Users:         ${status.userCount}`,
            `Default user:  ${status.defaultUser.username} (password: ${yn(status.defaultUser.hasPassword)}, email: ${status.defaultUser.email ?? "-"})`,
          ].join("\n"),
        );
        return 0;
      }
      case "user": {
        const [sub, ...subRest] = rest;
        if (sub === "list") {
          const parsed = parseArgs(subRest, [], ["--json"]);
          if (!parsed || parsed.positional.length > 0) return usageError(io);
          const list = withDb(io, summarizeUsers);
          if (parsed.flags.has("--json")) {
            io.out(JSON.stringify(list, null, 2));
            return 0;
          }
          const width = Math.max(...list.map((u) => u.username.length));
          for (const u of list) {
            io.out(
              `${u.username.padEnd(width)}  ${u.role.padEnd(5)}  ${u.email ?? "-"}  password=${yn(u.hasPassword)}  disabled=${yn(u.disabled)}  default=${yn(u.isDefault)}`,
            );
          }
          return 0;
        }
        if (sub === "email") {
          const parsed = parseArgs(subRest, [], ["--clear"]);
          if (!parsed) return usageError(io);
          const clear = parsed.flags.has("--clear");
          const [username, email] = parsed.positional;
          if (!username || parsed.positional.length !== (clear ? 1 : 2)) return usageError(io);
          if (!clear && !email.trim()) throw new CliError("The email can't be empty: use --clear to remove it");
          withDb(io, (db) => setEmail(db, username, clear ? null : email));
          io.out(clear ? `Email for "${username}" cleared.` : `Email for "${username}" set to ${email.trim()}.`);
          return 0;
        }
        return usageError(io);
      }
      case "login-mode": {
        const [mode, ...modeRest] = rest;
        if (mode === "cloudflare") {
          const parsed = parseArgs(modeRest, ["--team-domain", "--aud"], []);
          if (!parsed || parsed.positional.length > 0 || (parsed.values["--team-domain"]?.length ?? 0) !== 1) {
            return usageError(io, "login-mode cloudflare needs --team-domain <domain> and at least one --aud <tag>");
          }
          const result = withDb(io, (db) =>
            enableCloudflareAccess(db, { teamDomain: parsed.values["--team-domain"][0], audTags: parsed.values["--aud"] ?? [] }),
          );
          io.out(
            [
              'Login mode set to "cloudflare"; everyone was signed out of their browser sessions.',
              `  Team domain: ${result.teamDomain}`,
              `  AUD tags:    ${result.audTags.join(", ")}`,
              `  Admin:       ${result.adminUsername} signs in as ${result.adminEmail}`,
              "If Access locks you out, switch back from the host: mcp-switchboard login-mode password",
            ].join("\n"),
          );
          return 0;
        }
        if (rest.length !== 1) return usageError(io);
        withDb(io, (db) => setLoginMode(db, rest[0]));
        io.out(`Login mode set to "${rest[0]}".`);
        return 0;
      }
      default:
        return usageError(io, command === undefined ? undefined : `Unknown command "${command}"`);
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** Opens the database for one command and always closes it. */
function withDb<T>(io: CliIo, fn: (db: Db) => T): T {
  const db = io.openDb();
  try {
    return fn(db);
  } finally {
    io.closeDb();
  }
}

function usageError(io: CliIo, problem?: string): number {
  io.err(problem ? `${problem}\n\n${USAGE}` : USAGE);
  return 1;
}

async function readNewPassword(io: CliIo, fromStdin: boolean): Promise<string> {
  if (fromStdin) return (await io.readStdin()).replace(/\r?\n$/, "");
  if (!io.interactive) throw new CliError("No terminal to prompt on — pipe the password in with --password-stdin");
  const first = await io.promptHidden("New password: ");
  const second = await io.promptHidden("Repeat password: ");
  if (first !== second) throw new CliError("The passwords don't match");
  return first;
}

function readVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/** The real thing: the data dir comes from `config.ts`, exactly as for the server. */
export function processCliIo(): CliIo {
  return {
    version: readVersion(),
    dataDir: config.dataDir,
    out: (m) => console.log(m),
    err: (m) => console.error(m),
    interactive: Boolean(process.stdin.isTTY),
    promptHidden,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    openDb: () => {
      // Unlike the server, don't conjure an empty database: that would hide a wrong DATA_DIR.
      if (!fs.existsSync(path.join(config.dataDir, "switchboard.db"))) {
        throw new CliError(`No switchboard database in ${config.dataDir} (set DATA_DIR if it lives elsewhere)`);
      }
      return initDb(config.dataDir);
    },
    closeDb,
  };
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let typed = "";
    const finish = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          resolve(typed);
          return;
        }
        if (ch === "\u0003") {
          finish();
          reject(new CliError("Cancelled"));
          return;
        }
        typed = ch === "\u007f" || ch === "\b" ? typed.slice(0, -1) : typed + ch;
      }
    };
    stdin.on("data", onData);
  });
}
