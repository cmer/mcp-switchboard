#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { config, ensureDataDir } from "./config.js";
import { initDb } from "./db/index.js";
import { loadOrCreateKey } from "./lib/crypto.js";
import { SwitchboardHub } from "./core/switchboardHub.js";
import { TokenRefresher } from "./core/tokenRefresher.js";
import { UpstreamManager } from "./core/upstreamManager.js";
import { DbOAuthProvider } from "./oauth/dbOAuthProvider.js";
import { AdminSessionStore } from "./http/adminAuth.js";
import { createApp, createMcpApp } from "./http/app.js";
import type { AppContext } from "./http/context.js";

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

async function main(): Promise<void> {
  const dataDir = ensureDataDir();
  loadOrCreateKey(dataDir);
  const db = initDb(dataDir);

  // Declared before use inside makeOAuthProvider's onTokensSaved closure.
  let refresher: TokenRefresher;

  const makeOAuthProvider = (serverId: number): DbOAuthProvider =>
    new DbOAuthProvider(serverId, {
      db,
      publicUrl: config.publicUrl,
      onTokensSaved: (id) => refresher?.schedule(id),
    });

  const manager = new UpstreamManager(db, makeOAuthProvider);
  const hub = new SwitchboardHub({ db, manager, version: VERSION });

  manager.onCachesChanged = (serverId, kind) => hub.notifyChanged(serverId, kind);
  manager.onStateChanged = (serverId, state) => {
    console.log(`[upstream] server ${serverId}: ${state}`);
  };

  refresher = new TokenRefresher({
    db,
    makeProvider: makeOAuthProvider,
    onNeedsAuth: (serverId) => hub.notifyChanged(serverId, "tools"),
    onRefreshed: (serverId) => {
      const conn = manager.get(serverId);
      if (conn && conn.state !== "connected") void conn.restart();
    },
    log: (msg) => console.log(msg),
  });

  const ctx: AppContext = {
    db,
    manager,
    hub,
    refresher,
    adminSessions: new AdminSessionStore(db),
    makeOAuthProvider,
    version: VERSION,
  };

  const splitPorts = config.mcpPort !== null;
  const app = createApp(ctx, config.webDist, { serveMcp: !splitPorts });

  await manager.reconcile();
  refresher.scheduleAll();
  hub.startGc();

  // overrideGlobalObjects: hono's lightweight Response subclass breaks
  // `instanceof Response` checks in the MCP SDK's OAuth error parsing.
  serve(
    { fetch: app.fetch, port: config.port, hostname: config.host, overrideGlobalObjects: false },
    (info) => {
      console.log(`MCP Switchboard listening on http://localhost:${info.port}${splitPorts ? " (UI + API)" : ""}`);
      console.log(`  data dir:   ${config.dataDir}`);
      console.log(`  public url: ${config.publicUrl}`);
    },
  );

  // Two listeners, one process: they share the database, the upstream connections and every
  // in-memory session, so nothing about the switchboard's behaviour changes — only who can reach
  // which route.
  if (config.mcpPort !== null) {
    const mcpApp = createMcpApp(ctx);
    serve(
      { fetch: mcpApp.fetch, port: config.mcpPort, hostname: config.mcpHost, overrideGlobalObjects: false },
      (info) => {
        console.log(`  MCP endpoint listening on http://localhost:${info.port}/mcp/<agent-slug>`);
        if (config.mcpPublicUrl) console.log(`  mcp url:    ${config.mcpPublicUrl}`);
      },
    );
  }

  const shutdown = async (): Promise<void> => {
    console.log("Shutting down…");
    refresher.stopAll();
    await hub.stopAll();
    await manager.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
