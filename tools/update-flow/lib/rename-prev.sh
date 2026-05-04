#!/usr/bin/env bash
# tools/update-flow/lib/rename-prev.sh
#
# Atomically back up the existing ccsm-daemon binary and any native/ dir to
# a `.prev` sibling so rollback can restore them.
#
# Spec ref: docs/.../v03-daemon-split-design.md ch10 §8 step 2.
#   "rename existing ccsm-daemon(.exe) to ccsm-daemon.prev(.exe) (atomic on
#    all three OSes when source + dest are on the same volume; installers
#    MUST place binaries on the same volume as state)"
#
# Contract:
#   - INSTALL_ROOT env (or arg 1) = directory containing ccsm-daemon binary
#   - exit 0 = renames done (or no-op if nothing to rename)
#   - exit non-zero = rename failed (volume mismatch, permission, ...)
#
# Usage:
#   rename-prev.sh [--dry-run] [--install-root=/path]

set -euo pipefail

DRY_RUN=0
INSTALL_ROOT="${INSTALL_ROOT:-}"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --install-root=*) INSTALL_ROOT="${arg#*=}" ;;
    *) echo "rename-prev: unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$INSTALL_ROOT" ]; then
  # Sketch default for dry-run; real flow gets it from updater env.
  INSTALL_ROOT="/opt/ccsm"
fi

log() { echo "[rename-prev] $*"; }

dry() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: would run: $*"
    return 0
  fi
  "$@"
}

rename_one() {
  local src="$1"
  local dst="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: would rename $src -> $dst (if exists)"
    return 0
  fi
  if [ -e "$src" ]; then
    # mv on same filesystem is atomic (renameat2/MoveFileEx).
    dry mv -f "$src" "$dst"
  else
    log "skip (not present): $src"
  fi
}

main() {
  local bin="$INSTALL_ROOT/ccsm-daemon"
  local bin_prev="$INSTALL_ROOT/ccsm-daemon.prev"
  local native="$INSTALL_ROOT/native"
  local native_prev="$INSTALL_ROOT/native.prev"

  log "install root: $INSTALL_ROOT"
  rename_one "$bin" "$bin_prev"

  if [ "$DRY_RUN" -eq 1 ] || [ -d "$native" ]; then
    rename_one "$native" "$native_prev"
  fi
}

main
