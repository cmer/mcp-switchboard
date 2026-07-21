import path from "node:path";
import fs from "node:fs";

const PORT = Number(process.env.PORT ?? 8787);

export const config = {
  port: PORT,
  dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), "data"),
  /** Base URL the browser can reach the switchboard at; used for the OAuth redirect URI. */
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, ""),
  /** Directory containing the built web UI (production). */
  webDist: process.env.WEB_DIST ?? path.resolve(process.cwd(), "../web/dist"),
};

export function ensureDataDir(): string {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return config.dataDir;
}
