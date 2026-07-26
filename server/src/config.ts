import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${name} must be a port number between 0 and 65535 (got "${raw}")`);
  }
  return value;
}

const PORT = numericEnv("PORT", 8787);

/**
 * Optional second listener that serves *only* `/mcp/<agent-slug>`, so the agent endpoint can be
 * exposed (firewall rule, reverse proxy, tunnel) without also exposing the admin UI and REST API.
 * Same value as PORT means "one listener for everything", which is the default.
 */
const MCP_PORT = numericEnv("MCP_PORT", PORT);
const mcpPort = MCP_PORT === PORT ? null : MCP_PORT;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** `~/.config/mcp-switchboard`, honouring XDG_CONFIG_HOME when it is set. */
const defaultDataDir = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "mcp-switchboard",
);

/**
 * Releases up to 1.0.1 defaulted to `./data` relative to the working directory, which meant the
 * data dir moved with your shell. We now default to a fixed location, but keep using an existing
 * cwd-relative one so those installs don't silently start from an empty database.
 */
function resolveDataDir(): string {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  if (fs.existsSync(path.join(defaultDataDir, "switchboard.db"))) return defaultDataDir;

  const legacy = path.resolve(process.cwd(), "data");
  if (fs.existsSync(path.join(legacy, "switchboard.db"))) {
    console.warn(
      `[config] using legacy data dir ${legacy}\n` +
        `[config] move it to ${defaultDataDir} (or set DATA_DIR) — this fallback will be removed`,
    );
    return legacy;
  }
  return defaultDataDir;
}

/**
 * Built UI assets. When published to npm they are bundled at `<dist>/web`; in the monorepo they
 * sit at `web/dist`, two levels up from both `server/src` (tsx) and `server/dist` (compiled).
 */
function resolveWebDist(): string {
  if (process.env.WEB_DIST) return path.resolve(process.env.WEB_DIST);
  const bundled = path.join(moduleDir, "web");
  return fs.existsSync(bundled) ? bundled : path.resolve(moduleDir, "../../web/dist");
}

const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

/**
 * Base URL agents use for `/mcp/<slug>` (shown in the UI's connection snippets). Only meaningful
 * once the MCP endpoint has its own port: default it to PUBLIC_URL with the port swapped, which is
 * right for a LAN, and let MCP_PUBLIC_URL override it when the endpoint is fronted by a tunnel or
 * reverse proxy on a different host entirely.
 */
function resolveMcpPublicUrl(): string | null {
  const explicit = process.env.MCP_PUBLIC_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  if (mcpPort === null) return null;
  try {
    const url = new URL(publicUrl);
    url.port = String(mcpPort);
    return url.toString().replace(/\/$/, "");
  } catch {
    return `http://localhost:${mcpPort}`;
  }
}

export const config = {
  port: PORT,
  /** Separate port for the agent-facing MCP endpoint, or null when it shares `port`. */
  mcpPort,
  /** Interface to bind; undefined = all interfaces (node's default). */
  host: process.env.HOST || undefined,
  /** Interface for the MCP listener; falls back to HOST when unset. */
  mcpHost: process.env.MCP_HOST || process.env.HOST || undefined,
  dataDir: resolveDataDir(),
  /** Base URL the browser can reach the switchboard at; used for the OAuth redirect URI. */
  publicUrl,
  /** Base URL agents reach `/mcp/<slug>` at; null when it is the same origin as the UI. */
  mcpPublicUrl: resolveMcpPublicUrl(),
  /** Directory containing the built web UI (production). */
  webDist: resolveWebDist(),
};

export function ensureDataDir(): string {
  // 0700: this directory holds the encryption key and the token database.
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return config.dataDir;
}
