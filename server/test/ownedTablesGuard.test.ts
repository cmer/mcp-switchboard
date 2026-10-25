import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The isolation seam holds only if nothing else can reach the owned tables. This fails when a
 * file under src/ imports one of them from db/schema outside the modules allowed to.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

const OWNED_TABLES = ["servers", "agents", "agentServers", "shares", "serverRequests", "requestLogs", "userSettings"];

/** Legitimately need the owned tables. Paths are relative to src/. */
const ALLOWED = new Set([
  "core/userScope.ts", // the user-scoped data access: every owned-table query for one user
  "core/adminView.ts", // the Admin's narrow cross-user window (names, counts, escalated requests)
  "core/systemView.ts", // the runtime's cross-user machinery: runnable servers, fan-out, log retention
]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Owned table names imported as values from db/schema (type-only imports can't query anything). */
function ownedImports(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const found: string[] = [];
  const importRe = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of text.matchAll(importRe)) {
    const [, typeOnly, clause, spec] = m;
    if (typeOnly || !/(^|\/)db\/schema(\.js)?$|^\.\/schema(\.js)?$/.test(spec)) continue;
    if (/\*\s+as\s+/.test(clause)) {
      found.push("* (namespace import)");
      continue;
    }
    const names = clause
      .replace(/[{}]/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "" && !s.startsWith("type "))
      .map((s) => s.split(/\s+as\s+/)[0].trim());
    found.push(...names.filter((n) => OWNED_TABLES.includes(n)));
  }
  return found;
}

const files = sourceFiles(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join("/"),
  owned: ownedImports(full),
}));

describe("owned-table guard", () => {
  it("keeps owned-table access inside the user scope, the admin view and the system view", () => {
    const offenders = files
      .filter((f) => f.owned.length > 0)
      .filter((f) => !f.rel.startsWith("db/") && !ALLOWED.has(f.rel))
      .map((f) => `${f.rel}: ${f.owned.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  it("actually detects an owned-table import", () => {
    expect(files.find((f) => f.rel === "core/userScope.ts")?.owned).toEqual(
      expect.arrayContaining(["servers", "agents", "agentServers", "serverRequests", "requestLogs", "userSettings"]),
    );
  });
});
