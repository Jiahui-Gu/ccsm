#!/usr/bin/env bash
# tools/update-flow.spec.sh
#
# In-place update + rollback flow for ccsm-daemon (macOS + Linux).
#
# Spec ref: docs/.../v03-daemon-split-design.md ch10 §8.
#
# Steps (per spec):
#   1. Stop service with 10s + SIGKILL escalation (lib/stop-with-escalation.sh).
#   2. Rename existing binary -> ccsm-daemon.prev (lib/rename-prev.sh).
#   3. Move staged binary into place; restart service.
#   4. Poll /healthz for 10s. If 200: delete .prev. If timeout: rollback
#      (lib/rollback.sh) — restore .prev, restart, log crash_log entry
#      with source=update_rollback (regardless of whether the rollback
#      healthz succeeds, so the user sees the failure surfaced via ch09).
#
# v0.3 SCOPE: this is a SKETCH per ch10 §8 ("manual pre-release smoke v0.3,
# CI in v0.4"). The script is dry-run-capable end-to-end so the v0.3
# release rehearsal can validate it without touching a live system. Real
# e2e against launchd/systemd is v0.4.
#
# Usage:
#   tools/update-flow.spec.sh --dry-run
#   tools/update-flow.spec.sh --staged=/tmp/new-ccsm-daemon \
#                             --install-root=/opt/ccsm \
#                             --state-dir=/var/lib/ccsm \
#                             --healthz=http://localhost:9876/healthz
#
# Exit 0 = update succeeded OR rollback succeeded.
# Exit non-zero = catastrophic failure (rollback also failed).

set -euo pipefail

DRY_RUN=0
STAGED=""
INSTALL_ROOT="${INSTALL_ROOT:-}"
STATE_DIR="${STATE_DIR:-}"
HEALTHZ_URL="${HEALTHZ_URL:-http://localhost:9876/healthz}"
HEALTHZ_TIMEOUT_S=10
# Allow tests / dry-run to force the healthz outcome without spinning a
# real service (mirrors the structure of the PS1 -SimulateHealthz param).
SIMULATE_HEALTHZ=""  # one of: "", pass, fail

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --staged=*) STAGED="${arg#*=}" ;;
    --install-root=*) INSTALL_ROOT="${arg#*=}" ;;
    --state-dir=*) STATE_DIR="${arg#*=}" ;;
    --healthz=*) HEALTHZ_URL="${arg#*=}" ;;
    --simulate-healthz=*) SIMULATE_HEALTHZ="${arg#*=}" ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "update-flow: unknown arg: $arg" >&2; exit 2 ;;
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/update-flow/lib"

log() { echo "[update-flow] $*"; }

dry_or_run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: would run: $*"
    return 0
  fi
  "$@"
}

DRY_FLAG=""
if [ "$DRY_RUN" -eq 1 ]; then DRY_FLAG="--dry-run"; fi

# --- step 1: stop ---
step_stop() {
  log "step 1/4 — stop service"
  bash "$LIB_DIR/stop-with-escalation.sh" $DRY_FLAG
}

# --- step 2: rename existing -> .prev ---
step_rename() {
  log "step 2/4 — rename existing binary -> .prev"
  bash "$LIB_DIR/rename-prev.sh" $DRY_FLAG --install-root="$INSTALL_ROOT"
}

# --- step 3: stage + restart ---
step_stage_and_restart() {
  log "step 3/4 — move staged binary into place + restart"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: would move ${STAGED:-/tmp/staged-ccsm-daemon} -> $INSTALL_ROOT/ccsm-daemon"
    log "DRY-RUN: would start service via launchctl/systemctl"
    return 0
  fi
  if [ -z "$STAGED" ] || [ ! -e "$STAGED" ]; then
    log "ERROR: staged binary missing or unset: $STAGED"
    return 1
  fi
  mv -f "$STAGED" "$INSTALL_ROOT/ccsm-daemon"
  case "$(uname -s)" in
    Darwin) launchctl bootstrap system /Library/LaunchDaemons/com.ccsm.daemon.plist ;;
    Linux)  systemctl start ccsm-daemon ;;
  esac
}

# --- step 4: healthz + rollback decision ---
poll_healthz() {
  if [ -n "$SIMULATE_HEALTHZ" ]; then
    [ "$SIMULATE_HEALTHZ" = "pass" ]
    return $?
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: would poll $HEALTHZ_URL for ${HEALTHZ_TIMEOUT_S}s"
    return 0
  fi
  for _ in $(seq 1 "$HEALTHZ_TIMEOUT_S"); do
    if curl -fsS --max-time 1 "$HEALTHZ_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

step_healthz_or_rollback() {
  log "step 4/4 — poll /healthz (${HEALTHZ_TIMEOUT_S}s budget)"
  if poll_healthz; then
    log "healthz OK — update succeeded; deleting .prev"
    if [ "$DRY_RUN" -eq 1 ]; then
      log "DRY-RUN: would rm $INSTALL_ROOT/ccsm-daemon.prev and native.prev"
    else
      rm -f "$INSTALL_ROOT/ccsm-daemon.prev"
      rm -rf "$INSTALL_ROOT/native.prev"
    fi
    return 0
  fi

  log "healthz FAILED — initiating rollback"
  # Stop + restore + restart + log crash. Rollback continues even if its
  # healthz still fails (per spec — surface failure via crash_log).
  bash "$LIB_DIR/stop-with-escalation.sh" $DRY_FLAG || true
  rb_exit=0
  bash "$LIB_DIR/rollback.sh" $DRY_FLAG \
    --install-root="$INSTALL_ROOT" \
    --state-dir="$STATE_DIR" \
    --reason="post-update healthz failed within ${HEALTHZ_TIMEOUT_S}s" \
    || rb_exit=$?

  if [ "$DRY_RUN" -eq 0 ]; then
    case "$(uname -s)" in
      Darwin) launchctl bootstrap system /Library/LaunchDaemons/com.ccsm.daemon.plist || true ;;
      Linux)  systemctl start ccsm-daemon || true ;;
    esac
  fi

  return "$rb_exit"
}

main() {
  log "ccsm-daemon update flow start (dry-run=${DRY_RUN})"
  log "  install-root: $INSTALL_ROOT"
  log "  state-dir:    $STATE_DIR"
  log "  healthz:      $HEALTHZ_URL"
  step_stop
  step_rename
  step_stage_and_restart
  step_healthz_or_rollback
  log "update flow complete"
}

main
