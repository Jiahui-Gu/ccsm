#!/bin/sh
# packages/daemon/build/install/linux/postinst.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5.3 (Linux deb + rpm) + ch10 §5 step list.
# Task: T7.4 (#81) — installer: per-OS service registration + state dir creation.
#
# Embedded into both the .deb (DEBIAN/postinst) and .rpm (%post) by
# build-pkg.sh / fpm. Runs as root after files are placed.
#
# Responsibilities:
#   3. Create ccsm:ccsm system user/group (systemd's StateDirectory= will
#      chown /var/lib/ccsm to ccsm:ccsm on first start, but the user/group
#      MUST exist beforehand or systemd refuses to start the unit).
#   5. systemctl daemon-reload (so the new unit is picked up).
#   6. systemctl enable --now ccsm-daemon (start now + enable at boot).
#
# POSIX sh, not bash — Debian postinst convention.

set -e

log()  { echo "[ccsm-postinst] $*"; }
warn() { echo "[ccsm-postinst] WARN: $*" >&2; }

# ---- 4. service account: ccsm ----
if ! getent group ccsm >/dev/null 2>&1; then
  log "creating group ccsm"
  groupadd --system ccsm
fi

if ! getent passwd ccsm >/dev/null 2>&1; then
  log "creating user ccsm"
  useradd --system \
          --gid ccsm \
          --home-dir /var/lib/ccsm \
          --shell /usr/sbin/nologin \
          --comment "CCSM Daemon" \
          ccsm
fi

# ---- 5/6. systemd unit ----
if command -v systemctl >/dev/null 2>&1; then
  log "systemctl daemon-reload"
  systemctl daemon-reload || warn "daemon-reload failed (continuing)"

  log "systemctl enable --now ccsm-daemon"
  if ! systemctl enable --now ccsm-daemon 2>&1; then
    warn "systemctl enable --now failed; service NOT started"
    warn "(post-install /healthz polling — T7.5 — will surface this as install failure)"
    # Don't exit non-zero from postinst on first install — the installer's
    # /healthz wait (T7.5) is the ship-gate, not the postinst exit code.
    # rpm/dpkg treat non-zero postinst as a hard error which complicates
    # the installer rollback semantics in ch10 §5 step 7.
  fi
else
  warn "systemctl not found; this distro is not systemd-based."
  warn "(ccsm-daemon expects systemd per ch07 §2 locked StateDirectory directives.)"
fi

log "OK — postinst complete"
exit 0
