#!/usr/bin/env bash
# tools/update-flow/lib/rollback.sh
#
# Restore the previous binary + native/ from `.prev` siblings and emit a
# crash_log entry with `source=update_rollback` so the user-facing crash
# surface (ch09) sees the failure regardless of whether rollback healthz
# passes.
#
# Spec ref: docs/.../v03-daemon-split-design.md ch10 §8 step 4 (rollback).
#   "log a `crash_log` entry with source `update_rollback` (regardless of
#    whether the rollback healthz succeeds, so the user sees the failure
#    surfaced via Chapter 09)"
#
# `crash_log.source` is an open string set per ch04 §5 / ch09 §1 — adding
# `update_rollback` requires NO sources.ts change. The script appends one
# NDJSON line to `state/crash-raw.ndjson` (same format as packages/daemon/
# src/crash/raw-appender.ts CrashRawEntry); the daemon's boot replay
# (raw-appender.ts replayCrashRawOnBoot) imports it on next start.
#
# Contract:
#   - exit 0 = rollback succeeded (renames + crash_raw append both worked)
#   - exit non-zero = rollback failed (manual recovery needed)
#
# Usage:
#   rollback.sh [--dry-run] [--install-root=/path] [--state-dir=/path] [--reason=...]

set -euo pipefail

DRY_RUN=0
INSTALL_ROOT="${INSTALL_ROOT:-}"
STATE_DIR="${STATE_DIR:-}"
REASON="${REASON:-update healthz failed}"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --install-root=*) INSTALL_ROOT="${arg#*=}" ;;
    --state-dir=*) STATE_DIR="${arg#*=}" ;;
    --reason=*) REASON="${arg#*=}" ;;
    *) echo "rollback: unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$INSTALL_ROOT" ]; then INSTALL_ROOT="/opt/ccsm"; fi
if [ -z "$STATE_DIR" ]; then
  case "$(uname -s)" in
    Darwin) STATE_DIR="/Library/Application Support/ccsm" ;;
    Linux)  STATE_DIR="/var/lib/ccsm" ;;
    *)      STATE_DIR="/var/lib/ccsm" ;;
  esac
fi

log() { echo "[rollback] $*"; }

dry() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: would run: $*"
    return 0
  fi
  "$@"
}

# Restore binary + native/ from .prev.
restore_prev() {
  local bin="$INSTALL_ROOT/ccsm-daemon"
  local bin_prev="$INSTALL_ROOT/ccsm-daemon.prev"
  local native="$INSTALL_ROOT/native"
  local native_prev="$INSTALL_ROOT/native.prev"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: would restore $bin_prev -> $bin"
    log "DRY-RUN: would restore $native_prev -> $native (if present)"
    return 0
  fi

  if [ ! -e "$bin_prev" ]; then
    log "ERROR: no previous binary at $bin_prev — manual recovery needed"
    return 1
  fi

  # Remove the (failed) new binary if present, then atomically swap in .prev.
  rm -f "$bin"
  mv -f "$bin_prev" "$bin"

  if [ -d "$native_prev" ]; then
    rm -rf "$native"
    mv -f "$native_prev" "$native"
  fi
}

# Append one NDJSON line to crash-raw.ndjson with source=update_rollback.
# Schema mirrors packages/daemon/src/crash/raw-appender.ts CrashRawEntry.
emit_crash_log() {
  local crash_raw="$STATE_DIR/crash-raw.ndjson"
  local now_ms
  now_ms="$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')"
  # Lexicographic-ordered id: base36(ts)-uuid; uuid via /proc or uuidgen fallback.
  local uid
  if command -v uuidgen >/dev/null 2>&1; then
    uid="$(uuidgen | tr 'A-Z' 'a-z')"
  else
    uid="$(printf '%08x-%04x-%04x-%04x-%012x' \
      "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM")"
  fi
  local ts_part
  ts_part="$(printf '%09s' "$(echo "obase=36; $now_ms" | bc 2>/dev/null || echo "$now_ms")")"
  local id="${ts_part}-${uid}"

  # Hand-built JSON keeps zero deps. REASON is escaped minimally
  # (this is the v0.3 sketch; v0.4 may swap to jq).
  local safe_reason
  safe_reason="$(printf '%s' "$REASON" | sed 's/\\/\\\\/g; s/"/\\"/g')"

  local line
  line="{\"id\":\"${id}\",\"ts_ms\":${now_ms},\"source\":\"update_rollback\",\"summary\":\"update_rollback: ${safe_reason}\",\"detail\":\"installRoot=${INSTALL_ROOT}\",\"labels\":{\"installRoot\":\"${INSTALL_ROOT}\"},\"owner_id\":\"daemon-self\"}"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: would append to $crash_raw:"
    log "  $line"
    return 0
  fi

  mkdir -p "$STATE_DIR"
  # Atomic append (POSIX O_APPEND) — same contract as raw-appender.ts.
  printf '%s\n' "$line" >> "$crash_raw"
}

main() {
  log "rollback start (reason: ${REASON})"
  restore_prev
  emit_crash_log
  log "rollback complete"
}

main
