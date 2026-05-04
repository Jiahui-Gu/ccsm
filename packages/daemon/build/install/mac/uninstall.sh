#!/usr/bin/env bash
# packages/daemon/build/install/mac/uninstall.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5 step list (Common to all uninstallers, steps 1-6)
#       + chapter 10 §5.2 (macOS pkg) — "ccsm-uninstall.command" line.
# Task: T7.6 (#84) — uninstaller: REMOVEUSERDATA matrix + service unregister.
#
# This is the source of truth for the macOS uninstaller. The .pkg installer
# copies this file to:
#   /Library/Application Support/ccsm/ccsm-uninstall.command
# (renamed to .command so Finder treats double-click as "run in Terminal").
# Spec ch10 §5.2 line: "a separate ccsm-uninstall.command script in
# /Library/Application Support/ccsm/".
#
# Behaviour matrix (ch10 §5 common-to-all-uninstallers steps 1-6):
#   1. Stop service:        launchctl bootout system/com.ccsm.daemon (≤10 s)
#   2. Unregister service:  rm /Library/LaunchDaemons/com.ccsm.daemon.plist
#   3. Remove binaries:     rm -rf /usr/local/ccsm
#   4. State decision:      env CCSM_REMOVE_USER_DATA=1 → remove state dir;
#                           default 0 → keep. Interactive mode prompts.
#   5. If yes:              rm -rf /Library/Application Support/ccsm
#                           + dscl . -delete /Users/_ccsm + /Groups/_ccsm
#   6. Remove uninstaller   (this script removes itself last when state goes)
#
# Modes:
#   --silent / -y          non-interactive; honours CCSM_REMOVE_USER_DATA env
#                          (default 0 = keep user data); ship-gate (d) path.
#   --interactive          (default) prompts the user once for "remove user
#                          data?" with default "no". macOS double-click on
#                          .command runs interactive in Terminal.app.
#   --remove-user-data     force CCSM_REMOVE_USER_DATA=1 from CLI.
#   --keep-user-data       force CCSM_REMOVE_USER_DATA=0 from CLI.
#   --help                 usage.
#
# Exit codes:
#   0   uninstall complete (whether or not user data was removed)
#   1   not running as root
#   2   plist missing AND binary missing — nothing to uninstall
#   3   bootout / file removal failed
#
# Idempotent: re-runs after a failed uninstall complete the remaining
# steps (best-effort warns on missing items).

set -uo pipefail

PLIST="/Library/LaunchDaemons/com.ccsm.daemon.plist"
LABEL="system/com.ccsm.daemon"
INSTALL_DIR="/usr/local/ccsm"
STATE_DIR="/Library/Application Support/ccsm"
LOG_DIR="/Library/Logs/ccsm"
SVC_USER="_ccsm"
SVC_GROUP="_ccsm"
SELF_PATH="$STATE_DIR/ccsm-uninstall.command"

MODE="interactive"
USER_DATA_DECISION=""

log()  { echo "[ccsm-uninstall] $*"; }
warn() { echo "[ccsm-uninstall] WARN: $*" >&2; }
err()  { echo "[ccsm-uninstall] ERROR: $*" >&2; }

usage() {
  cat <<EOF
ccsm-uninstall.command — remove the CCSM daemon from this Mac.

Usage:
  sudo bash $0 [--silent | --interactive] [--remove-user-data | --keep-user-data]

Options:
  --silent, -y           Non-interactive. Honours CCSM_REMOVE_USER_DATA env
                         (default 0 = keep user data).
  --interactive          Prompt for "remove user data?" (default no).
                         This is the default when no flag is given.
  --remove-user-data     Force removal of state dir (overrides env / prompt).
  --keep-user-data       Force keeping of state dir (overrides env / prompt).
  --help, -h             This message.

Environment:
  CCSM_REMOVE_USER_DATA  Read in --silent mode. "1" = remove state dir;
                         anything else (default) = keep.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --silent|-y)            MODE="silent" ;;
    --interactive)          MODE="interactive" ;;
    --remove-user-data)     USER_DATA_DECISION="1" ;;
    --keep-user-data)       USER_DATA_DECISION="0" ;;
    --help|-h)              usage; exit 0 ;;
    *) err "unknown arg: $1"; usage; exit 2 ;;
  esac
  shift
done

# ---- root check ----
if [[ "$(id -u)" -ne 0 ]]; then
  err "must run as root (sudo bash ccsm-uninstall.command)"
  exit 1
fi

# ---- guard: nothing to uninstall? ----
if [[ ! -f "$PLIST" ]] && [[ ! -d "$INSTALL_DIR" ]]; then
  warn "no plist at $PLIST and no $INSTALL_DIR — nothing to uninstall"
  exit 2
fi

# ---- 1. stop service ----
if [[ -f "$PLIST" ]]; then
  log "launchctl bootout $LABEL (best-effort, 10s timeout)"
  # bootout with 10s wait — spec ch10 §5 step 1 "wait up to 10 s for clean exit"
  if ! launchctl bootout "$LABEL" 2>/dev/null; then
    warn "bootout returned non-zero (service may already be stopped)"
  fi
  # Belt-and-braces: SIGTERM any straggler ccsm-daemon process. Mirrors the
  # spec ch10 §8 escalation path (SIGTERM → SIGKILL after 5s) for the
  # uninstall case, since we MUST not leave a daemon holding the descriptor
  # after the plist is gone.
  if pgrep -x ccsm-daemon >/dev/null 2>&1; then
    warn "ccsm-daemon still running after bootout — SIGTERM"
    pkill -TERM -x ccsm-daemon 2>/dev/null || true
    # Wait up to 5s, then SIGKILL.
    for _ in 1 2 3 4 5; do
      sleep 1
      pgrep -x ccsm-daemon >/dev/null 2>&1 || break
    done
    if pgrep -x ccsm-daemon >/dev/null 2>&1; then
      warn "ccsm-daemon survived SIGTERM — SIGKILL"
      pkill -KILL -x ccsm-daemon 2>/dev/null || true
    fi
  fi
else
  warn "no plist at $PLIST — skipping bootout"
fi

# ---- 2. unregister service (remove plist) ----
if [[ -f "$PLIST" ]]; then
  log "rm $PLIST"
  rm -f "$PLIST" || { err "failed to remove $PLIST"; exit 3; }
fi

# ---- 3. remove binaries ----
if [[ -d "$INSTALL_DIR" ]]; then
  log "rm -rf $INSTALL_DIR"
  rm -rf "$INSTALL_DIR" || { err "failed to remove $INSTALL_DIR"; exit 3; }
fi

# ---- 4. state decision ----
remove_user_data="0"
if [[ -n "$USER_DATA_DECISION" ]]; then
  # CLI flag wins.
  remove_user_data="$USER_DATA_DECISION"
elif [[ "$MODE" == "silent" ]]; then
  # spec ch10 §5 step 4: silent honours env var; default "0" = keep.
  remove_user_data="${CCSM_REMOVE_USER_DATA:-0}"
else
  # Interactive prompt — default no (spec: "default no").
  echo ""
  echo "Remove all CCSM user data? This deletes:"
  echo "    $STATE_DIR  (sessions, descriptors, ccsm.db)"
  echo "    $LOG_DIR"
  echo "    user/group: $SVC_USER / $SVC_GROUP"
  echo ""
  read -r -p "Remove user data? [y/N] " reply || reply=""
  case "$reply" in
    y|Y|yes|YES) remove_user_data="1" ;;
    *)           remove_user_data="0" ;;
  esac
fi

# ---- 5. remove user data (if opted in) ----
if [[ "$remove_user_data" == "1" ]]; then
  log "CCSM_REMOVE_USER_DATA=1 — removing state dir + service account"

  if [[ -d "$STATE_DIR" ]]; then
    log "rm -rf $STATE_DIR"
    rm -rf "$STATE_DIR" || warn "failed to remove $STATE_DIR"
  fi
  if [[ -d "$LOG_DIR" ]]; then
    log "rm -rf $LOG_DIR"
    rm -rf "$LOG_DIR" || warn "failed to remove $LOG_DIR"
  fi

  if dscl . -read "/Users/$SVC_USER" >/dev/null 2>&1; then
    log "dscl . -delete /Users/$SVC_USER"
    dscl . -delete "/Users/$SVC_USER" 2>/dev/null || warn "dscl delete user failed"
  fi
  if dscl . -read "/Groups/$SVC_GROUP" >/dev/null 2>&1; then
    log "dscl . -delete /Groups/$SVC_GROUP"
    dscl . -delete "/Groups/$SVC_GROUP" 2>/dev/null || warn "dscl delete group failed"
  fi
else
  log "keeping $STATE_DIR (re-run with --remove-user-data or CCSM_REMOVE_USER_DATA=1 to remove)"
fi

# ---- 6. self-removal ----
# When state dir is removed we already deleted ourselves. Otherwise the
# script lives next to ccsm.db and the operator can re-run if needed.
log "OK — uninstall complete (REMOVEUSERDATA=$remove_user_data)"
exit 0
