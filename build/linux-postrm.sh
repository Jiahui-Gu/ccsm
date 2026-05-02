#!/bin/sh
# build/linux-postrm.sh — task #133, frag-11 §11.6.3
#
# electron-builder injects this as:
#   - linux.deb.postrm           (Debian/Ubuntu .deb)
#   - linux.rpm.scripts.preUninstall  (.rpm; rpm has no `purge` mode)
#
# Responsibilities:
#   1. Stop the running daemon (TERM, then KILL after 5 s grace).
#   2. On `purge` (or rpm uninstall), remove the per-user data root
#      `<dataRoot>/ccsm/` honouring $XDG_DATA_HOME, falling back to
#      $HOME/.local/share/ccsm.
#   3. Honour CCSM_KEEP_USERDATA=1 to preserve user data even on purge.
#
# Round-3 P0-4 (frag-11 §11.6.3): postrm runs as root with HOME=/root, so
# blindly expanding $HOME would target /root/.local/share/ccsm — never the
# real user's data. We resolve the invoking user's $HOME via SUDO_USER +
# `getent passwd` when available; otherwise we skip data-root removal and
# leave it for the documented manual cleanup step (release notes).
#
# Lowercase `ccsm/` path matches the daemon's resolveDataRoot()
# (daemon/src/db/ensure-data-dir.ts; task #132 lowercase fix).
#
# This script must remain shellcheck-clean (POSIX sh, not bash).

set -eu

DAEMON_BIN_PATH="/usr/lib/ccsm/resources/daemon/ccsm-daemon"
TERM_GRACE_SECONDS=5

log() {
  # postrm is silent on success per Debian policy; log to stderr only on
  # interesting events so apt/dnf still show a clean uninstall line.
  printf 'ccsm-postrm: %s\n' "$1" >&2
}

# ---------------------------------------------------------------------------
# Resolve the invoking user's HOME. postrm runs as root; HOME=/root is a
# tautology that never touches real user data (frag-11 §11.6.3 Round-3 P0-4).
# ---------------------------------------------------------------------------
resolve_user_home() {
  if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
    if command -v getent >/dev/null 2>&1; then
      getent passwd "${SUDO_USER}" | cut -d: -f6
      return 0
    fi
  fi
  # No SUDO_USER (apt/dnf invoked as root directly): we cannot safely
  # enumerate users from a maintainer script. Caller treats empty as
  # "skip data-root removal".
  printf ''
}

# ---------------------------------------------------------------------------
# Resolve <dataRoot> for a given user home, honouring XDG_DATA_HOME if it
# is set AND absolute (XDG Base Directory spec). Mirrors
# daemon/src/db/ensure-data-dir.ts resolveDataRoot() for Linux.
# ---------------------------------------------------------------------------
resolve_data_root() {
  user_home="$1"
  # XDG_DATA_HOME from the maintainer-script env (rarely set on root) takes
  # precedence; otherwise default to <user_home>/.local/share.
  xdg="${XDG_DATA_HOME:-}"
  case "${xdg}" in
    /*) printf '%s/ccsm' "${xdg}" ;;
    *)  printf '%s/.local/share/ccsm' "${user_home}" ;;
  esac
}

# ---------------------------------------------------------------------------
# Stop the daemon. Strategy:
#   1. If <dataRoot>/daemon.lock is a regular file containing a PID,
#      `kill -TERM` that PID, wait up to TERM_GRACE_SECONDS, then KILL.
#   2. Fall back to `pkill -f` on the installed daemon binary path so a
#      SIGKILLed daemon (proper-lockfile dir, no PID file) still gets
#      cleaned up.
# ---------------------------------------------------------------------------
stop_daemon() {
  data_root="$1"
  lock_path="${data_root}/daemon.lock"
  pid=""
  if [ -f "${lock_path}" ] && [ -r "${lock_path}" ]; then
    # Some daemons write a bare PID into the lockfile; proper-lockfile
    # uses a directory, in which case `-f` is false and we skip this branch.
    pid=$(cat "${lock_path}" 2>/dev/null | tr -dc '0-9')
  fi

  if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
    log "sending TERM to daemon pid ${pid}"
    kill -TERM "${pid}" 2>/dev/null || true
    i=0
    while [ "${i}" -lt "${TERM_GRACE_SECONDS}" ]; do
      if ! kill -0 "${pid}" 2>/dev/null; then
        return 0
      fi
      sleep 1
      i=$((i + 1))
    done
    if kill -0 "${pid}" 2>/dev/null; then
      log "daemon pid ${pid} did not exit within ${TERM_GRACE_SECONDS}s; sending KILL"
      kill -KILL "${pid}" 2>/dev/null || true
    fi
    return 0
  fi

  # Fallback: no PID-bearing lockfile. Best-effort pkill on the install
  # path. Suppress "no process found" exit code (1).
  if command -v pkill >/dev/null 2>&1; then
    pkill -TERM -f "${DAEMON_BIN_PATH}" 2>/dev/null || true
    sleep 1
    pkill -KILL -f "${DAEMON_BIN_PATH}" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# Remove the per-user data root. Honours CCSM_KEEP_USERDATA=1 (skip).
# ---------------------------------------------------------------------------
remove_user_data() {
  data_root="$1"
  if [ "${CCSM_KEEP_USERDATA:-0}" = "1" ]; then
    log "CCSM_KEEP_USERDATA=1 set; preserving ${data_root}"
    return 0
  fi
  if [ -d "${data_root}" ]; then
    log "removing data root ${data_root}"
    # Defensive guard: never `rm -rf /` or anything <5 chars deep.
    case "${data_root}" in
      /|/root|/home|/usr|/etc|/var)
        log "refusing to remove suspicious data root ${data_root}"
        return 0
        ;;
    esac
    rm -rf -- "${data_root}"
  fi
}

# ---------------------------------------------------------------------------
# Main: dispatch on the maintainer-script action ($1).
#
# .deb postrm receives: remove | purge | upgrade | failed-upgrade | abort-*
# .rpm %preun receives: numeric upgrade count (1 = uninstall, 2+ = upgrade)
#
# We treat both shapes:
#   - "remove" / "purge" / "0" -> stop daemon; data removal only on purge/0
#   - "upgrade" / "1+" -> stop daemon (binary about to be replaced) but
#                         keep user data
#   - anything else -> no-op (abort/failed-upgrade should not destroy data)
# ---------------------------------------------------------------------------
action="${1:-remove}"

# Resolve paths up-front for both stop + remove phases.
USER_HOME="$(resolve_user_home)"
if [ -z "${USER_HOME}" ]; then
  USER_HOME="${HOME:-/root}"
fi
DATA_ROOT="$(resolve_data_root "${USER_HOME}")"

case "${action}" in
  remove|upgrade|0|1)
    stop_daemon "${DATA_ROOT}"
    if [ "${action}" = "0" ] || [ "${action}" = "remove" ]; then
      # rpm uninstall (0) and deb remove: stop daemon, preserve data.
      :
    fi
    ;;
  purge)
    stop_daemon "${DATA_ROOT}"
    if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
      remove_user_data "${DATA_ROOT}"
    else
      log "purge invoked without SUDO_USER; per-user data preserved (run: rm -rf ~/.local/share/ccsm)"
    fi
    ;;
  *)
    # failed-upgrade, abort-install, abort-upgrade, etc. — no-op.
    ;;
esac

exit 0
