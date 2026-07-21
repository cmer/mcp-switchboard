#!/usr/bin/env bash
# Release: bump versions everywhere, commit, tag, push, create GitHub release.
# Usage: scripts/release.sh <X.Y.Z>
set -euo pipefail

VERSION="${1:?usage: scripts/release.sh <X.Y.Z>}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must be X.Y.Z, got '$VERSION'"; exit 1; }

cd "$(dirname "$0")/.."

[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || { echo "error: releases are cut from main"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "error: working tree not clean"; exit 1; }
git pull --ff-only

echo "==> Tests + build"
npm test
npm run build

echo "==> Bumping to $VERSION (root + workspaces)"
npm version "$VERSION" --no-git-tag-version --workspaces --include-workspace-root --allow-same-version > /dev/null
npm install --package-lock-only > /dev/null

git add package.json package-lock.json server/package.json web/package.json
git commit -m "Release v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"

echo "==> Pushing main + tag"
git push origin main "v$VERSION"

echo "==> Creating GitHub release"
gh release create "v$VERSION" --title "v$VERSION" --generate-notes

echo "==> Released v$VERSION"
