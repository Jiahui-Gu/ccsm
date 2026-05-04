#!/usr/bin/env bash
# tools/update-flow/lib/stop-with-escalation.sh
#
# Stop the ccsm-daemon service with the spec-locked escalation:
#   1. Polite stop via service manager (launchctl / systemctl) — wait up to 10s.
#   2. If still running, SIGKILL via service manager (`launchctl kill SIGKILL`
#      or `systemctl kill --signal=SIGKILL`).
#   3. Verify PID is gone via `pgrep` before returning success.
#
# Spec ref: docs/.../v03-daemon-split-design.md ch10 §8 step 1.
#
# Contract:
#   - exit 0 = service stopped (verified via pgrep -f ccsm-daemon = empty)
#   - exit non-zero = could not stop within total budget, caller must abort
#
# Usage:
#   stop-with-escalation.sh [--dry-run]
#
# This is a v0.3 SKETCH per ch10 §8 (manual pre-release smoke; CI in v0.4).
# Real e2e against a live launchd/systemd unit is v0.4 work.

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "stop-with-escalation: unknown arg: $arg" >&2; exit 2 ;;
  esac
done

OS_NAME="$(uname -s)"
SERVICE_NAME="ccsm-daemon"

log() { echo "[stop-with-escalation] $*"; }

dry() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: would run: $*"
    return 0
  fi
  "$@"
}

polite_stop() {
  case "$OS_NAME" in
    Darwin)
      dry launchctl bootout "system/com.ccsm.daemon" || true
      ;;
    Linux)
      dry systemctl stop "$SERVICE_NAME" || true
      ;;
    *)
      # In dry-run we still want to walk the flow (e.g. on MINGW where
      # devs rehearse the script); the real stop is no-op anyway.
      if [ "$DRY_RUN" -eq 1 ]; then
        log "DRY-RUN: would stop service via OS service manager (host=$OS_NAME)"
      else
        log "unsupported OS for stop: $OS_NAME"
        return 1
      fi
      ;;
  esac
}

force_kill() {
  case "$OS_NAME" in
    Darwin)
      dry launchctl kill SIGKILL "system/com.ccsm.daemon" || true
      ;;
    Linux)
      dry systemctl kill --signal=SIGKILL "$SERVICE_NAME" || true
      ;;
  esac
}

pid_gone() {
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0  # in dry-run, assume gone
  fi
  ! pgrep -f "$SERVICE_NAME" >/dev/null 2>&1
}

main() {
  log "polite stop ($OS_NAME)"
  polite_stop

  # Wait up to 10s for the polite stop.
  for _ in $(seq 1 10); do
    if pid_gone; then
      log "service stopped politely"
      return 0
    fi
    [ "$DRY_RUN" -eq 1 ] && break
    sleep 1
  done

  log "polite stop timed out, escalating to SIGKILL"
  force_kill

  # Wait up to 5s after SIGKILL for the PID to disappear.
  for _ in $(seq 1 5); do
    if pid_gone; then
      log "service killed"
      return 0
    fi
    [ "$DRY_RUN" -eq 1 ] && break
    sleep 1
  done

  log "ERROR: service still running after SIGKILL"
  return 1
}

main
