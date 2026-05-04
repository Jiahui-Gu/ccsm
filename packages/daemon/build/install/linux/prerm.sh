#!/bin/sh
# packages/daemon/build/install/linux/prerm.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5.3 (Linux deb + rpm) — uninstall step list.
# Task: T7.4 (#81) — installer: per-OS service registration + state dir creation.
#
# Runs BEFORE files are removed. Stops + disables the service so the unit
# file deletion in postrm doesn't race with a running daemon.
#
# Common to both upgrade ($1 = "upgrade" on .deb / >= 1 on .rpm) and
# uninstall ($1 = "remove" / "purge" on .deb / 0 on .rpm). On upgrade we
# skip stop/disable — postinst on the new version will restart.

set -e

log()  { echo "[ccsm-prerm] $*"; }
warn() { echo "[ccsm-prerm] WARN: $*" >&2; }

ACTION="${1:-remove}"
case "$ACTION" in
  upgrade|1|2)
    log "upgrade — leaving service running, postinst on new version will restart"
    exit 0
    ;;
esac

if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet ccsm-daemon 2>/dev/null; then
    log "systemctl stop ccsm-daemon (10s timeout enforced by unit's TimeoutStopSec)"
    systemctl stop ccsm-daemon || warn "systemctl stop returned non-zero"
  fi
  if systemctl is-enabled --quiet ccsm-daemon 2>/dev/null; then
    log "systemctl disable ccsm-daemon"
    systemctl disable ccsm-daemon || warn "systemctl disable returned non-zero"
  fi
else
  warn "systemctl not found; nothing to stop"
fi

log "OK — prerm complete"
exit 0
