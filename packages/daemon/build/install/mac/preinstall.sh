#!/usr/bin/env bash
# packages/daemon/build/install/mac/preinstall.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5.2 + §5 step 3 (state dir) + step 4 (service account).
# Task: T7.4 (#81) — installer: per-OS service registration + state dir creation.
#
# Runs as root inside the macOS .pkg installer BEFORE files are placed.
# Responsibilities (ch10 §5 install step list):
#   3. Create state directory /Library/Application Support/ccsm with mode
#      0700 owned by _ccsm:_ccsm.
#   4. Create _ccsm service account if it doesn't exist (UID/GID in the
#      200-499 service range; per Apple convention).
#
# This script is intentionally idempotent — pkg upgrades re-run preinstall.

set -euo pipefail

log()  { echo "[ccsm-preinstall] $*"; }
warn() { echo "[ccsm-preinstall] WARN: $*" >&2; }

# ---- 4. service account: _ccsm ----
SVC_USER="_ccsm"
SVC_GROUP="_ccsm"

create_service_user() {
  if dscl . -read "/Users/$SVC_USER" >/dev/null 2>&1; then
    log "user $SVC_USER already exists — skipping"
    return 0
  fi

  # Pick the next free UID/GID in the 200-499 system service range.
  local uid=200
  while dscl . -list /Users UniqueID 2>/dev/null | awk '{print $2}' | grep -qx "$uid"; do
    uid=$((uid + 1))
    if [[ $uid -ge 500 ]]; then
      warn "no free UID in 200-499 range — falling back to 499"
      uid=499
      break
    fi
  done

  local gid="$uid"
  if ! dscl . -read "/Groups/$SVC_GROUP" >/dev/null 2>&1; then
    log "creating group $SVC_GROUP gid=$gid"
    dscl . -create "/Groups/$SVC_GROUP"
    dscl . -create "/Groups/$SVC_GROUP" PrimaryGroupID "$gid"
    dscl . -create "/Groups/$SVC_GROUP" RealName "CCSM Daemon"
  else
    gid="$(dscl . -read "/Groups/$SVC_GROUP" PrimaryGroupID | awk '{print $2}')"
  fi

  log "creating user $SVC_USER uid=$uid gid=$gid"
  dscl . -create "/Users/$SVC_USER"
  dscl . -create "/Users/$SVC_USER" UniqueID "$uid"
  dscl . -create "/Users/$SVC_USER" PrimaryGroupID "$gid"
  dscl . -create "/Users/$SVC_USER" UserShell /usr/bin/false
  dscl . -create "/Users/$SVC_USER" RealName "CCSM Daemon"
  dscl . -create "/Users/$SVC_USER" NFSHomeDirectory /var/empty
  dscl . -create "/Users/$SVC_USER" IsHidden 1
  dscl . -create "/Users/$SVC_USER" Password '*'
}

create_service_user

# ---- 3. state directory ----
STATE_DIR="/Library/Application Support/ccsm"
DESCRIPTORS_DIR="$STATE_DIR/descriptors"
LOG_DIR="/Library/Logs/ccsm"

log "mkdir -p $STATE_DIR (mode 0700, owner $SVC_USER:$SVC_GROUP)"
mkdir -p "$STATE_DIR" "$DESCRIPTORS_DIR" "$LOG_DIR"
chown -R "$SVC_USER:$SVC_GROUP" "$STATE_DIR" "$LOG_DIR"
chmod 0700 "$STATE_DIR" "$DESCRIPTORS_DIR"
chmod 0750 "$LOG_DIR"

log "OK — preinstall complete"
exit 0
