#!/usr/bin/env bash
# Usage: scripts/sync-pool.sh [branch] [--force]
#   branch: defaults to "working"
#   --force: skip uncommitted-changes guard (for cron / unattended use)
set -euo pipefail

BRANCH="working"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) BRANCH="$arg" ;;
  esac
done

git fetch origin --quiet
TARGET_SHA="$(git rev-parse "origin/$BRANCH")"
MARKER=".pool-synced-at-$TARGET_SHA"

# Idempotent no-op if already synced AND build artifact present
if [ -f "$MARKER" ] && [ -f "dist/renderer/bundle.js" ]; then
  echo "sync-pool: already at $TARGET_SHA with built dist, skipping"
  exit 0
fi

# Guard: refuse to nuke uncommitted work unless --force
if [ "$FORCE" -eq 0 ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "sync-pool: uncommitted changes present, refusing to reset (use --force to override)" >&2
    exit 1
  fi
  if [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "sync-pool: untracked files present, refusing to wipe (use --force to override)" >&2
    exit 1
  fi
fi

git reset --hard "origin/$BRANCH"
git clean -fd
npm install --no-audit --no-fund
npm run build

rm -f .pool-synced-at-* 2>/dev/null || true
touch "$MARKER"
echo "sync-pool: synced to $TARGET_SHA, deps installed, build complete"
