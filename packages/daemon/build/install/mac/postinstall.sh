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
STATE_DIR="/Library/Application Support/ccsm"
UNINSTALL_SRC="/usr/local/ccsm/uninstall.sh"
UNINSTALL_DST="$STATE_DIR/ccsm-uninstall.command"

if [[ ! -f "$PLIST" ]]; then
  warn "plist missing: $PLIST — pkg payload broken?"
  exit 1
fi

# T7.6 (#84) — install the uninstaller script alongside ccsm.db so the
# operator can locate it the same way they locate state. Spec ch10 §5.2
# pins the path: "/Library/Application Support/ccsm/ccsm-uninstall.command".
if [[ -f "$UNINSTALL_SRC" ]]; then
  log "install uninstaller: $UNINSTALL_DST"
  cp "$UNINSTALL_SRC" "$UNINSTALL_DST"
  chmod 0755 "$UNINSTALL_DST"
  # State dir is owned by _ccsm but uninstall must be invokable by an
  # admin in Terminal.app, so leave the .command root-owned + world-rx.
  chown root:wheel "$UNINSTALL_DST"
else
  warn "uninstaller source missing: $UNINSTALL_SRC — pkg payload broken? (T7.6)"
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
