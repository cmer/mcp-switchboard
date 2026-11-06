import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * OS-level sandboxes for stdio servers. A stdio server is somebody's npm/PyPI package running on
 * the switchboard's host; without a sandbox it runs as the switchboard's own user and can read
 * `secret.key` and the database (every user's credentials) and every other process. Inside one it
 * sees the system directories read-only, its own home directory read-write, and nothing else of
 * the host unless the Admin lists a host path for it. Its network is left as it is.
 *
 * Linux uses bubblewrap: fresh user, PID, IPC and UTS namespaces, a minimal mount tree, no nested
 * user namespaces. macOS uses Seatbelt (`sandbox-exec`), which hides files but can't hide other
 * processes: a server can still read the command line and environment of processes running as
 * the same user. Nothing else is supported; there, stdio servers only run with the sandbox off.
 */

export type SandboxKind = "bwrap" | "seatbelt";

export interface SandboxStatus {
  /** The mechanism this platform would use, or null where there is none. */
  kind: SandboxKind | null;
  available: boolean;
  /** Why it isn't available, in words for the Settings page. */
  error: string | null;
}

export interface HostPath {
  path: string;
  writable: boolean;
}

export interface StdioSpawn {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface SandboxLayout {
  /** The server's own directory: its HOME and TMPDIR, the only place it can write by default. */
  home: string;
  /** Extra read-only directories: the Node install and the directory a bare command resolved to. */
  readOnly: string[];
  hostPaths: HostPath[];
  /** Never readable: the data dir, the other servers' homes, the switchboard user's home. */
  hidden: string[];
}

/** A server's stored `host_paths_json`; anything malformed reads as no host paths. */
export function parseHostPaths(json: string | null): HostPath[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((h): h is HostPath => typeof h?.path === "string" && typeof h?.writable === "boolean")
      .map((h) => ({ path: h.path, writable: h.writable }));
  } catch {
    return [];
  }
}

/**
 * Why `p` can't be a host path, or null. Checked when it's saved and again at every spawn, since
 * a symlink can change underneath a saved path.
 */
export function checkHostPath(p: string, protectedPaths: string[]): string | null {
  if (!path.isAbsolute(p)) return `Host path "${p}" must be absolute`;
  const real = realpathOr(path.resolve(p));
  if (real === "/") return "A host path can't be the whole filesystem";
  for (const prot of protectedPaths) {
    if (overlaps(real, realpathOr(prot))) {
      return `Host path "${p}" overlaps the switchboard's own data, which no server may see`;
    }
  }
  return null;
}

export const SANDBOX_LABELS: Record<SandboxKind, string> = { bwrap: "bubblewrap", seatbelt: "macOS Seatbelt" };

/** `child` is `parent` or somewhere below it. Both absolute and normalised. */
function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

/** True when `a` and `b` are the same directory or one contains the other. */
export function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

/** System directories bubblewrap mounts read-only for every server. */
const BWRAP_SYSTEM_DIRS = ["/usr", "/etc"];
/** Top-level links into /usr on merged-/usr distros, real directories on older ones. */
const BWRAP_ROOT_LINKS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
/** systemd-resolved hosts point /etc/resolv.conf in here; without it, DNS fails. */
const BWRAP_OPTIONAL_DIRS = ["/run/systemd/resolve"];

type PathKind = { type: "dir" } | { type: "link"; target: string } | { type: "file" } | null;

function pathKind(p: string): PathKind {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return { type: "link", target: fs.readlinkSync(p) };
    return st.isDirectory() ? { type: "dir" } : { type: "file" };
  } catch {
    return null;
  }
}

/**
 * The bubblewrap command line that runs `spec` inside `layout`. The network namespace is shared:
 * servers reach the APIs they wrap exactly as before. Mounts are listed parents-first, so a
 * host path inside the home directory (or the reverse) lands on top of the right parent.
 */
export function bwrapArgs(
  spec: StdioSpawn,
  layout: SandboxLayout,
  opts: { disableUserns: boolean; kind?: (p: string) => PathKind },
): string[] {
  const kind = opts.kind ?? pathKind;
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--die-with-parent",
    // No controlling terminal: blocks TIOCSTI keystroke injection into whoever started us.
    "--new-session",
    ...(opts.disableUserns ? ["--disable-userns"] : []),
  ];
  for (const dir of BWRAP_SYSTEM_DIRS) args.push("--ro-bind", dir, dir);
  for (const link of BWRAP_ROOT_LINKS) {
    const k = kind(link);
    if (k?.type === "link") args.push("--symlink", k.target, link);
    else if (k?.type === "dir") args.push("--ro-bind", link, link);
  }
  for (const dir of BWRAP_OPTIONAL_DIRS) args.push("--ro-bind-try", dir, dir);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");

  const mounts: { path: string; flag: string }[] = [
    ...layout.readOnly
      .filter((p) => !BWRAP_SYSTEM_DIRS.some((sys) => within(p, sys)))
      .map((p) => ({ path: p, flag: "--ro-bind" })),
    { path: layout.home, flag: "--bind" },
    ...layout.hostPaths.map((h) => ({ path: h.path, flag: h.writable ? "--bind" : "--ro-bind" })),
  ];
  mounts.sort((a, b) => a.path.length - b.path.length);
  for (const m of mounts) args.push(m.flag, m.path, m.path);

  args.push("--chdir", spec.cwd ?? layout.home, "--", spec.command, ...spec.args);
  return args;
}

const sbString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const subpaths = (paths: string[]) => paths.map((p) => `(subpath ${sbString(p)})`).join(" ");

/**
 * A Seatbelt profile for `layout`. Later rules win, so the order is: everything allowed, all
 * writes refused, writes re-allowed where the server may write, the hidden paths refused
 * outright, and reads re-allowed for what sits inside them (the Node install under the user's
 * home, the server's own directory, host paths).
 */
export function seatbeltProfile(layout: SandboxLayout): string {
  const writable = [layout.home, ...layout.hostPaths.filter((h) => h.writable).map((h) => h.path)];
  const readable = [...layout.readOnly, ...layout.hostPaths.map((h) => h.path)];
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${subpaths(writable)} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
  ];
  if (layout.hidden.length > 0) lines.push(`(deny file-read* file-write* ${subpaths(layout.hidden)})`);
  if (readable.length > 0) lines.push(`(allow file-read* ${subpaths(readable)})`);
  lines.push(`(allow file-read* file-write* ${subpaths(writable)})`);
  return lines.join("\n") + "\n";
}

/** Where a bare command name resolves on the switchboard's own PATH (never a user-supplied one). */
function resolveOnPath(command: string, pathEnv = process.env.PATH ?? ""): string | null {
  if (command.includes("/")) return null;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function run(file: string, args: string[], timeoutMs = 10_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stderr}${stdout}`.trim() || (err?.message ?? "") });
    });
  });
}

export interface SandboxOptions {
  /** Parent of every server's home directory. */
  rootDir: string;
  /** The switchboard's data dir: the encryption key and the database. */
  dataDir: string;
  platform?: NodeJS.Platform;
}

export interface WrapRequest {
  serverId: number;
  hostPaths: HostPath[];
}

export class StdioSandbox {
  private status: SandboxStatus;
  private disableUserns = false;
  private bwrapPath: string | null = null;
  private readonly platform: NodeJS.Platform;
  readonly rootDir: string;
  private readonly dataDir: string;

  constructor(opts: SandboxOptions) {
    this.platform = opts.platform ?? process.platform;
    this.rootDir = opts.rootDir;
    this.dataDir = opts.dataDir;
    const kind = this.platform === "linux" ? "bwrap" : this.platform === "darwin" ? "seatbelt" : null;
    this.status = { kind, available: false, error: kind ? "Not checked yet" : `No sandbox is available on ${this.platform}` };
  }

  getStatus(): SandboxStatus {
    return this.status;
  }

  /** Paths a host path must stay clear of, and that a sandboxed server must never read. */
  protectedPaths(): string[] {
    return [realpathOr(this.dataDir), realpathOr(this.rootDir)];
  }

  checkHostPath(p: string): string | null {
    return checkHostPath(p, this.protectedPaths());
  }

  /** Find the mechanism and run a no-op inside it once. Called at boot, before servers start. */
  async probe(): Promise<SandboxStatus> {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    if (this.platform === "linux") {
      this.bwrapPath = resolveOnPath("bwrap");
      if (!this.bwrapPath) {
        this.status = { kind: "bwrap", available: false, error: "bubblewrap (bwrap) is not installed" };
        return this.status;
      }
      this.disableUserns = (await run(this.bwrapPath, ["--help"])).output.includes("--disable-userns");
      const home = path.join(this.rootDir, ".probe");
      fs.mkdirSync(home, { recursive: true });
      const layout: SandboxLayout = { home, readOnly: [], hostPaths: [], hidden: [] };
      const result = await run(this.bwrapPath, bwrapArgs({ command: "true", args: [], env: {} }, layout, { disableUserns: this.disableUserns }));
      this.status = result.ok
        ? { kind: "bwrap", available: true, error: null }
        : { kind: "bwrap", available: false, error: `bubblewrap can't create a sandbox here: ${result.output}` };
    } else if (this.platform === "darwin") {
      const result = await run("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
      this.status = result.ok
        ? { kind: "seatbelt", available: true, error: null }
        : { kind: "seatbelt", available: false, error: `sandbox-exec failed: ${result.output}` };
    }
    return this.status;
  }

  /**
   * `spec` rewritten to run inside the server's sandbox. Throws, with a message the server's
   * status shows, when the sandbox is unavailable or the spec reaches outside it.
   */
  wrap(spec: StdioSpawn, req: WrapRequest): StdioSpawn {
    if (!this.status.available) {
      throw new Error(
        `Local servers run in a sandbox, and it isn't available: ${this.status.error ?? "unknown reason"}.\n` +
          "→ See docs/sandbox.md, or have the Admin turn the sandbox off in Settings.",
      );
    }
    for (const h of req.hostPaths) {
      const bad = this.checkHostPath(h.path);
      if (bad) throw new Error(bad);
      if (!fs.existsSync(h.path)) throw new Error(`Host path "${h.path}" doesn't exist`);
    }
    const home = path.join(this.rootDir, `server-${req.serverId}`);
    fs.mkdirSync(path.join(home, "tmp"), { recursive: true, mode: 0o700 });
    const realHome = realpathOr(home);
    const hostPaths = req.hostPaths.map((h) => ({ path: realpathOr(h.path), writable: h.writable }));

    if (spec.cwd) {
      const cwd = realpathOr(path.resolve(spec.cwd));
      if (!within(cwd, realHome) && !hostPaths.some((h) => within(cwd, h.path))) {
        throw new Error(`Working directory "${spec.cwd}" is outside the sandbox.\n→ Add it under Host paths, or clear it.`);
      }
    }

    const layout: SandboxLayout = {
      home: realHome,
      readOnly: this.runtimeDirs(spec.command),
      hostPaths,
      hidden: [...this.protectedPaths(), realpathOr(os.homedir())],
    };
    const env = { ...spec.env, HOME: realHome, TMPDIR: path.join(realHome, "tmp") };
    const cwd = spec.cwd ? realpathOr(path.resolve(spec.cwd)) : realHome;

    if (this.status.kind === "bwrap") {
      return {
        command: this.bwrapPath!,
        args: bwrapArgs({ ...spec, cwd }, layout, { disableUserns: this.disableUserns }),
        env,
        cwd: realHome,
      };
    }
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", seatbeltProfile(layout), spec.command, ...spec.args],
      env,
      cwd,
    };
  }

  /**
   * Read-only directories a server needs beyond the system ones: the Node install running the
   * switchboard (npx and node may live under the user's home, e.g. with nvm), and the directory
   * a bare command such as `uvx` resolved to on the switchboard's PATH. A directory that overlaps
   * the protected paths, or is the user's home or above it, is never added.
   */
  private runtimeDirs(command: string): string[] {
    const candidates = [path.dirname(path.dirname(process.execPath)), path.dirname(path.dirname(realpathOr(process.execPath)))];
    const resolved = resolveOnPath(command);
    if (resolved) candidates.push(path.dirname(resolved), path.dirname(realpathOr(resolved)));
    const prot = this.protectedPaths();
    const home = realpathOr(os.homedir());
    const dirs = new Set<string>();
    for (const c of candidates) {
      const real = realpathOr(c);
      if (within(home, real) || prot.some((p) => overlaps(real, p))) continue;
      dirs.add(real);
    }
    return [...dirs];
  }
}
