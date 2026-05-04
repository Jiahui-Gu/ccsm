#!/usr/bin/env bash
# packages/daemon/build/install/mac/postinstall.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5.2 (macOS pkg) + §5 steps 5-7.
# Task: T7.4 (#81) — installer: per-OS service registration + state dir creation.
#
# Runs as root inside the macOS .pkg installer AFTER files are placed.
# Responsibilities (ch10 §5 step list):
#   5. Register the daemon as a system service:
#      launchctl bootstrap system /Library/LaunchDaemons/com.ccsm.daemon.plist
#   6. Start it:
#      launchctl enable system/com.ccsm.daemon
#      launchctl kickstart -k system/com.ccsm.daemon
#   7. Health-check polling — owned by T7.5 (#83); this script exits as soon
#      as the service is kicked.
#
# Idempotent: re-runs on upgrade; bootstrap may fail if already loaded, in
# which case we fall through to bootout + bootstrap.

set -euo pipefail

log()  { echo "[ccsm-postinstall] $*"; }
warn() { echo "[ccsm-postinstall] WARN: $*" >&2; }

PLIST="/Library/LaunchDaemons/com.ccsm.daemon.plist"
LABEL="system/com.ccsm.daemon"

if [[ ! -f "$PLIST" ]]; then
  warn "plist missing: $PLIST — pkg payload broken?"
  exit 1
fi

# Force fresh registration: bootout (ignore failure if not loaded) then bootstrap.
log "launchctl bootout $LABEL (best-effort)"
launchctl bootout "$LABEL" 2>/dev/null || true

log "launchctl bootstrap system $PLIST"
launchctl bootstrap system "$PLIST"

log "launchctl enable $LABEL"
launchctl enable "$LABEL"

log "launchctl kickstart -k $LABEL"
launchctl kickstart -k "$LABEL"

log "OK — daemon service registered and kickstarted"
log "(post-install /healthz polling is owned by T7.5)"
exit 0
