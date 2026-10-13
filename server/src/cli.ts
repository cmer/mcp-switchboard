import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { closeDb, initDb, type Db } from "./db/index.js";
import { MIN_PASSWORD_LENGTH, setUserPassword } from "./core/setupCodes.js";
import { defaultUserId, getUser, getUserByUsername } from "./core/users.js";
import { LOGIN_MODE_SETTING, writeSetting } from "./lib/settings.js";

/**
 * The `mcp-switchboard` subcommands that repair an install from the host (a lost password, a
 * wrong login mode). They open the same SQLite file as the server but never start it, and are safe
 * to run beside a live server: sessions and setup codes are rows it re-reads on every request.
 */

export const USAGE = `Usage:
  mcp-switchboard                                Start the switchboard
  mcp-switchboard reset-password <username>      Set a user's password (prompts, no echo)
        [--password-stdin]                       Read the new password from stdin instead
  mcp-switchboard login-mode password            Switch the instance back to password login
  mcp-switchboard --help                         Show this message`;

/** Everything the CLI touches outside the database, so tests can drive it without a terminal. */
export interface CliIo {
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
 * Only `password` can be set from here: it is the way back in when Cloudflare Access is
 * misconfigured. Switching Access on needs a live Access token, so it happens in Settings.
 */
export function setLoginMode(db: Db, mode: string): void {
  if (mode !== "password") throw new CliError(`Unknown login mode "${mode}" (expected: password)`);
  // An unclaimed Default user would let anyone who reaches the login page become the Admin.
  const admin = getUser(db, defaultUserId(db));
  if (admin && admin.passwordHash === null) {
    throw new CliError(`${admin.username} has no password yet: run \`mcp-switchboard reset-password ${admin.username}\` first`);
  }
  writeSetting(db, LOGIN_MODE_SETTING, mode);
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
      case "login-mode": {
        if (rest.length !== 1) return usageError(io);
        const db = io.openDb();
        try {
          setLoginMode(db, rest[0]);
        } finally {
          io.closeDb();
        }
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

/** The real thing: the data dir comes from `config.ts`, exactly as for the server. */
export function processCliIo(): CliIo {
  return {
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
