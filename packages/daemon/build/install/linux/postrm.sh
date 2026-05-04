#!/bin/sh
# packages/daemon/build/install/linux/postrm.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5.3 (Linux deb + rpm) — uninstall step list.
# Task: T7.4 (#81) — installer: per-OS service registration + state dir creation.
#
# Runs AFTER files are removed. Reloads systemd to drop the now-deleted
# unit, optionally userdel ccsm in purge mode, optionally remove state
# directory based on CCSM_REMOVE_USER_DATA env (ch10 §5 step 4).
#
# Action arg ($1):
#   .deb: remove | purge | upgrade | failed-upgrade | abort-install | abort-upgrade | disappear
#   .rpm: integer ('0' = uninstall, '1' = upgrade, etc.)
#
# We userdel on purge/0 only; on plain remove we leave the user so any
# state files keep their ownership for a future reinstall.

set -e

log()  { echo "[ccsm-postrm] $*"; }
warn() { echo "[ccsm-postrm] WARN: $*" >&2; }

ACTION="${1:-purge}"

if command -v systemctl >/dev/null 2>&1; then
  log "systemctl daemon-reload"
  systemctl daemon-reload || warn "daemon-reload failed"
fi

# Purge or rpm uninstall (0)?
case "$ACTION" in
  purge|0)
    if [ "${CCSM_REMOVE_USER_DATA:-0}" = "1" ]; then
      log "CCSM_REMOVE_USER_DATA=1 — removing /var/lib/ccsm and /run/ccsm"
      rm -rf /var/lib/ccsm /run/ccsm 2>/dev/null || true
    else
      log "keeping /var/lib/ccsm (set CCSM_REMOVE_USER_DATA=1 to remove)"
    fi

    if getent passwd ccsm >/dev/null 2>&1; then
      log "userdel ccsm"
      userdel ccsm 2>/dev/null || warn "userdel failed (user may have running processes)"
    fi
    if getent group ccsm >/dev/null 2>&1; then
      log "groupdel ccsm"
      groupdel ccsm 2>/dev/null || warn "groupdel failed"
    fi
    ;;
  *)
    log "non-purge action ($ACTION) — leaving user/group/state in place"
    ;;
esac

log "OK — postrm complete"
exit 0
