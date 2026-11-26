#!/usr/bin/env bash
# Release: bump versions, publish to npm, tag and push to GitHub, create the GitHub release.
# Usage: scripts/release.sh <X.Y.Z> [--otp <code>] [--dry-run]
#
# --otp is required if the npm account has 2FA enabled; codes expire in ~30s, so pass it at the
# moment you run this rather than up front.
set -euo pipefail

USAGE="usage: scripts/release.sh <X.Y.Z> [--otp <code>] [--dry-run]"
VERSION="${1:?$USAGE}"
shift
DRY_RUN=""
OTP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --otp) OTP="${2:?error: --otp needs a code}"; shift 2 ;;
    --otp=*) OTP="${1#*=}"; shift ;;
    *) echo "error: unknown argument '$1'"; echo "$USAGE"; exit 1 ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version must be X.Y.Z, got '$VERSION'"; exit 1; }

cd "$(dirname "$0")/.."

echo "==> Preflight"
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || { echo "error: releases are cut from main"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "error: working tree not clean"; exit 1; }
git rev-parse "v$VERSION" >/dev/null 2>&1 && { echo "error: tag v$VERSION already exists"; exit 1; }
# Fail here rather than after the tag is cut: publishing to npm is effectively irreversible.
# pnpm publishes with the same registry credentials as npm (~/.npmrc), so `npm whoami` checks them.
npm whoami >/dev/null 2>&1 || { echo "error: not logged in to npm — run \`npm login\`"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated — run \`gh auth login\`"; exit 1; }
git pull --ff-only

echo "==> Tests + build"
pnpm test
pnpm build

NOTES="$(mktemp -t mcp-switchboard-notes)"
trap 'rm -f "$NOTES"' EXIT
node scripts/changelog-release.mjs "$VERSION" "$NOTES"

echo "==> Bumping to $VERSION (root + workspaces)"
# pnpm-lock.yaml doesn't record workspace versions, so only the manifests change.
node -e '
const fs = require("fs");
for (const f of ["package.json", "server/package.json", "web/package.json"]) {
  const p = JSON.parse(fs.readFileSync(f, "utf8"));
  p.version = process.argv[1];
  fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
}' "$VERSION"

if [[ -n "$DRY_RUN" ]]; then
  echo "==> Dry run: packing instead of publishing"
  pnpm -C server publish --dry-run --no-git-checks
  echo "==> Dry run: release notes would be:"
  cat "$NOTES"
  echo "==> Dry run complete — reverting local edits"
  git checkout -- CHANGELOG.md package.json server/package.json web/package.json
  exit 0
fi

git add CHANGELOG.md package.json server/package.json web/package.json
git commit -m "Release v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"

# npm first: if it fails, nothing has been pushed yet and the commit/tag can be dropped locally.
echo "==> Publishing @cmer/mcp-switchboard@$VERSION to npm"
# Run from server/ rather than with --filter: a recursive publish silently skips versions it thinks
# are already out. --no-git-checks because the preflight above already did them (and pnpm's version
# would refuse a branch that's ahead of origin, which this one is until the push below).
if ! pnpm -C server publish --no-git-checks ${OTP:+--otp "$OTP"}; then
  echo
  echo "error: pnpm publish failed. Nothing has been pushed; to unwind the local release commit:"
  echo "    git reset --hard origin/main && git tag -d v$VERSION"
  [[ -z "$OTP" ]] && echo "If the account has 2FA, re-run with: scripts/release.sh $VERSION --otp <code>"
  exit 1
fi

echo "==> Pushing main + tag"
git push origin main "v$VERSION"

echo "==> Creating GitHub release"
gh release create "v$VERSION" --title "v$VERSION" --notes-file "$NOTES"

echo "==> Released v$VERSION"
echo "    npm:    https://www.npmjs.com/package/@cmer/mcp-switchboard/v/$VERSION"
echo "    github: https://github.com/cmer/mcp-switchboard/releases/tag/v$VERSION"
