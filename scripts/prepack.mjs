#!/usr/bin/env node
// Runs from server/'s `prepack`, i.e. on `npm pack` / `npm publish`.
//
// The published package is a single flat artifact: the compiled server plus the built web UI
// bundled at dist/web (config.ts prefers that path over the monorepo's ../../web/dist), and the
// repo-root README/LICENSE copied in so npm renders them on the package page.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(root, "server");
const serverDist = path.join(serverDir, "dist");
const webDist = path.join(root, "web", "dist");

function require(condition, message) {
  if (!condition) {
    console.error(`prepack: ${message}\nprepack: run \`npm run build\` from the repo root first.`);
    process.exit(1);
  }
}

require(fs.existsSync(path.join(serverDist, "index.js")), "server/dist/index.js is missing");
require(fs.existsSync(path.join(webDist, "index.html")), "web/dist/index.html is missing");

const bundledWeb = path.join(serverDist, "web");
fs.rmSync(bundledWeb, { recursive: true, force: true });
fs.cpSync(webDist, bundledWeb, { recursive: true });

for (const file of ["README.md", "LICENSE"]) {
  fs.copyFileSync(path.join(root, file), path.join(serverDir, file));
}

// npm strips the executable bit from files it packs, but restores it for `bin` entries on install.
// The shebang in src/index.ts is what actually makes `npx mcp-switchboard` work.
const entry = fs.readFileSync(path.join(serverDist, "index.js"), "utf8");
require(entry.startsWith("#!"), "server/dist/index.js lost its shebang");

console.log(`prepack: bundled ${path.relative(root, webDist)} -> ${path.relative(root, bundledWeb)}`);
