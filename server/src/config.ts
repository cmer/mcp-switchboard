import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8787);

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

export const config = {
  port: PORT,
  dataDir: resolveDataDir(),
  /** Base URL the browser can reach the switchboard at; used for the OAuth redirect URI. */
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, ""),
  /** Directory containing the built web UI (production). */
  webDist: resolveWebDist(),
};

export function ensureDataDir(): string {
  // 0700: this directory holds the encryption key and the token database.
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return config.dataDir;
}
