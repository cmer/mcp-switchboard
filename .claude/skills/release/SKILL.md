---
name: release
description: Cut a release of @cmer/mcp-switchboard (version bump, changelog, npm publish, git tag, GitHub release) and optionally deploy it to Carl's switchboard host. Use when asked to release, publish, cut or ship a new (patch/minor/major) version.
---

# Releasing @cmer/mcp-switchboard

`scripts/release.sh <X.Y.Z> [--otp <code>] [--dry-run]` is the canonical sequence: preflight, tests + build, changelog roll, version bump, commit + tag, npm publish, push, GitHub release. Follow its order even when running the steps by hand.

## 1. Preflight: stop on any failure

Run these before changing anything:

- `git pull --ff-only` on `main`, with a clean tree.
- `npm whoami`. **If it fails (401 or not logged in), stop the release.** Don't bump, commit, tag or prepare anything. Ask Carl to run `! npm login` and wait for confirmation that the login worked. Publishing is the one step that can't be undone, so it must be possible before any other step runs.
- `gh auth status`.

## 2. Pick the version

Read `## [Unreleased]` in `CHANGELOG.md`. A `### Added` entry means minor, `### Fixed` alone means patch, and breaking changes mean major. If the user named the bump ("minor"), use theirs. If `[Unreleased]` is empty, there's nothing to release, so say so.

## 3. Tests + build

`npm test && npm run build`. If better-sqlite3 fails with a `NODE_MODULE_VERSION` mismatch, the local Node was upgraded: run `npm rebuild better-sqlite3` and retry. That's not a code failure.

## 4. Release commit

- `node scripts/changelog-release.mjs <X.Y.Z> /tmp/mcp-sb-notes-<X.Y.Z>.md` renames `[Unreleased]`, fixes the compare links and writes the GitHub release notes.
- `npm version <X.Y.Z> --no-git-tag-version --workspaces --include-workspace-root --allow-same-version`
- Lockfile: if `npm install --package-lock-only` changes more than the four `"version"` fields (newer npm strips `"peer": true`, for example), restore the lockfile and bump just those four fields by hand. A release commit touches exactly `CHANGELOG.md`, `package.json`, `package-lock.json`, `server/package.json` and `web/package.json`.
- Commit `Release v<X.Y.Z>` with the Co-Authored-By trailer, then `git tag -a v<X.Y.Z> -m v<X.Y.Z>`. The script's own commit has no trailer, which is why the steps may be run by hand.

## 5. Publish, then push

1. `npm publish -w server`. Carl's account uses 2FA, so this fails with `EOTP`. Ask for a fresh code (it expires in about 30s) and re-run with `--otp <code>`, or have Carl run `! npm publish -w server` directly to use the browser flow. If publishing fails for any other reason, nothing has been pushed yet, so unwind with `git reset --hard origin/main && git tag -d v<X.Y.Z>`.
2. `git push origin main v<X.Y.Z>`
3. `gh release create v<X.Y.Z> --title v<X.Y.Z> --notes-file /tmp/mcp-sb-notes-<X.Y.Z>.md`
4. Check: `npm view @cmer/mcp-switchboard version` and the release URL.

## 6. Deploy (only when asked)

Carl's live instance is `ssh mcp-switchboard.cmer.lan`, at `/opt/mcp-switchboard`: a git checkout built with docker compose. Update it with `git pull --ff-only && docker compose up -d --build`. Leave the local, untracked `compose.override.yml` alone. To verify, check that `docker exec mcp-switchboard node -p 'require("/app/server/package.json").version'` reports the new version and `curl localhost:8787/api/auth/me` returns 200.
