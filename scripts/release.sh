#!/usr/bin/env bash
# Release: bump versions, publish to npm, tag and push to GitHub, create the GitHub release.
# Usage: scripts/release.sh <X.Y.Z> [--dry-run]
set -euo pipefail

VERSION="${1:?usage: scripts/release.sh <X.Y.Z> [--dry-run]}"
DRY_RUN=""
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=1
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must be X.Y.Z, got '$VERSION'"; exit 1; }

cd "$(dirname "$0")/.."

echo "==> Preflight"
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || { echo "error: releases are cut from main"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "error: working tree not clean"; exit 1; }
git rev-parse "v$VERSION" >/dev/null 2>&1 && { echo "error: tag v$VERSION already exists"; exit 1; }
# Fail here rather than after the tag is cut: publishing to npm is effectively irreversible.
npm whoami >/dev/null 2>&1 || { echo "error: not logged in to npm — run \`npm login\`"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated — run \`gh auth login\`"; exit 1; }
git pull --ff-only

echo "==> Tests + build"
npm test
npm run build

NOTES="$(mktemp -t mcp-switchboard-notes)"
trap 'rm -f "$NOTES"' EXIT
node scripts/changelog-release.mjs "$VERSION" "$NOTES"

echo "==> Bumping to $VERSION (root + workspaces)"
npm version "$VERSION" --no-git-tag-version --workspaces --include-workspace-root --allow-same-version > /dev/null
npm install --package-lock-only > /dev/null

if [[ -n "$DRY_RUN" ]]; then
  echo "==> Dry run: packing instead of publishing"
  npm publish -w server --dry-run
  echo "==> Dry run: release notes would be:"
  cat "$NOTES"
  echo "==> Dry run complete — reverting local edits"
  git checkout -- CHANGELOG.md package.json package-lock.json server/package.json web/package.json
  exit 0
fi

git add CHANGELOG.md package.json package-lock.json server/package.json web/package.json
git commit -m "Release v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"

# npm first: if it fails, nothing has been pushed yet and the commit/tag can be dropped locally.
echo "==> Publishing @cmer/mcp-switchboard@$VERSION to npm"
npm publish -w server

echo "==> Pushing main + tag"
git push origin main "v$VERSION"

echo "==> Creating GitHub release"
gh release create "v$VERSION" --title "v$VERSION" --notes-file "$NOTES"

echo "==> Released v$VERSION"
echo "    npm:    https://www.npmjs.com/package/@cmer/mcp-switchboard/v/$VERSION"
echo "    github: https://github.com/cmer/mcp-switchboard/releases/tag/v$VERSION"
