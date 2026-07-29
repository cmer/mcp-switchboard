#!/usr/bin/env node
// Promotes CHANGELOG.md's `## [Unreleased]` section to a dated release heading, leaves a fresh
// empty `## [Unreleased]` in its place, adds the compare link, and writes the section body out for
// `gh release create --notes-file`.
//
// Usage: node scripts/changelog-release.mjs <X.Y.Z> <notes-out-path>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [version, notesOut] = process.argv.slice(2);
if (!version || !notesOut) {
  console.error("usage: changelog-release.mjs <X.Y.Z> <notes-out-path>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "CHANGELOG.md");
const original = fs.readFileSync(file, "utf8");

const start = original.indexOf("## [Unreleased]");
if (start === -1) {
  console.error("changelog: no `## [Unreleased]` section — add one before releasing.");
  process.exit(1);
}

const rest = original.slice(start + "## [Unreleased]".length);
const nextHeading = rest.indexOf("\n## ");
const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
if (!body) {
  console.error("changelog: `## [Unreleased]` is empty — nothing to release.");
  process.exit(1);
}

// The version directly below Unreleased is what we compare against for the diff link.
const prev = (original.slice(start).match(/\n## \[(\d+\.\d+\.\d+)\]/) || [])[1];
const date = new Date().toISOString().slice(0, 10);

// Leave an empty `## [Unreleased]` behind so the next change has somewhere to go — otherwise the
// heading only comes back if someone remembers to retype it, and a later release fails preflight.
let updated = original.replace("## [Unreleased]", `## [Unreleased]\n\n## [${version}] — ${date}`);

const repo = "https://github.com/cmer/mcp-switchboard";
const link = prev
  ? `[${version}]: ${repo}/compare/v${prev}...v${version}`
  : `[${version}]: ${repo}/releases/tag/v${version}`;
// `## [Unreleased]` is a link reference; without a definition it renders as literal brackets.
// Repoint it at whatever lands after this release, replacing any definition from the last one.
const unreleasedLink = `[Unreleased]: ${repo}/compare/v${version}...HEAD`;
updated = updated.replace(/^\[Unreleased\]: .*\n/m, "");
const prevLink = prev ? `[${prev}]: ` : null;
updated =
  prevLink && updated.includes(`\n${prevLink}`)
    ? updated.replace(`\n${prevLink}`, `\n${unreleasedLink}\n${link}\n${prevLink}`)
    : `${updated.trimEnd()}\n\n${unreleasedLink}\n${link}\n`;

fs.writeFileSync(file, updated);
fs.writeFileSync(notesOut, `${body}\n`);
console.log(`changelog: released [Unreleased] as ${version} (${date})`);
