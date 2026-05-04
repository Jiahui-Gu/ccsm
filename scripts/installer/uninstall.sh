#!/usr/bin/env bash
# scripts/installer/uninstall.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5 step list (Common to all uninstallers, steps 1-6).
# Task: T7.6 (#84) — uninstaller: REMOVEUSERDATA matrix + service unregister.
#
# Top-level entry point that dispatches to the per-OS uninstall path:
#
#   macOS  → invokes the on-disk /Library/Application Support/ccsm/ccsm-uninstall.command
#            (placed by mac/postinstall.sh from build/install/mac/uninstall.sh).
#   linux  → invokes dpkg -P ccsm  /  rpm -e ccsm  driven by package
#            manager auto-detection. The .deb/.rpm prerm + postrm hooks
#            (see build/install/linux/) handle stop / disable / userdel /
#            CCSM_REMOVE_USER_DATA gating.
#
# Both interactive + silent variants are exposed (spec ch10 §5 step 4):
#
#   --interactive    (default) prompt user for "remove user data?".
#   --silent / -y    non-interactive; reads CCSM_REMOVE_USER_DATA env
#                    (default 0 = keep). This is the ship-gate (d) path
#                    invoked by tools/installer-roundtrip.sh.
#   --remove-user-data  force CCSM_REMOVE_USER_DATA=1 from CLI.
#   --keep-user-data    force CCSM_REMOVE_USER_DATA=0 from CLI.
#   --help              usage.
#
# State dir is left untouched unless CCSM_REMOVE_USER_DATA=1 OR the user
# answers yes at the interactive prompt OR --remove-user-data is passed.
# Spec ch10 §5 step 4 line: "Default: keep state on uninstall".
#
# Exit codes:
#   0   uninstall complete
#   1   not running as root (mac/linux uninstall always needs root)
#   2   no installation detected (nothing to uninstall)
#   3   per-OS dispatch returned non-zero
#   4   unknown OS
#
# This script does NOT itself drive the Windows uninstall — Windows uses
# scripts/installer/uninstall.ps1 (msiexec /x wrapper). Calling this on
# Windows (Git Bash etc.) detects the environment and exits 4 with a
# pointer to the .ps1 script.

set -uo pipefail

MAC_UNINSTALL="/Library/Application Support/ccsm/ccsm-uninstall.command"
LINUX_PKG_NAME="${CCSM_PKG_NAME:-ccsm}"

MODE="interactive"
USER_DATA_DECISION=""

log()  { echo "[ccsm-uninstall] $*"; }
warn() { echo "[ccsm-uninstall] WARN: $*" >&2; }
err()  { echo "[ccsm-uninstall] ERROR: $*" >&2; }

usage() {
  cat <<EOF
ccsm uninstall — remove the CCSM daemon from this machine.

Usage:
  sudo bash scripts/installer/uninstall.sh [--silent | --interactive] [--remove-user-data | --keep-user-data]

Options:
  --silent, -y           Non-interactive. Honours CCSM_REMOVE_USER_DATA env
                         (default 0 = keep user data). Used by ship-gate (d).
  --interactive          Prompt for "remove user data?" (default no).
                         This is the default mode when no flag is given.
  --remove-user-data     Force removal of state dir (overrides env / prompt).
  --keep-user-data       Force keeping of state dir (overrides env / prompt).
  --help, -h             This message.

Environment:
  CCSM_REMOVE_USER_DATA  Read in --silent mode. "1" = remove state dir;
                         anything else (default) = keep.
  CCSM_PKG_NAME          Linux package name. Default: ccsm.

OS dispatch:
  macOS  → /Library/Application Support/ccsm/ccsm-uninstall.command
  linux  → dpkg -P ${LINUX_PKG_NAME}  OR  rpm -e ${LINUX_PKG_NAME}
  win    → use scripts/installer/uninstall.ps1 (this script exits 4)
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

# ---- decide CCSM_REMOVE_USER_DATA early so per-OS branches can read it. ----
remove_user_data="0"
if [[ -n "$USER_DATA_DECISION" ]]; then
  remove_user_data="$USER_DATA_DECISION"
elif [[ "$MODE" == "silent" ]]; then
  remove_user_data="${CCSM_REMOVE_USER_DATA:-0}"
else
  # Interactive: prompt once, propagate to per-OS scripts via env.
  echo ""
  echo "Remove all CCSM user data? This deletes the state directory."
  echo "(Default: no, keep user data so a reinstall preserves sessions.)"
  read -r -p "Remove user data? [y/N] " reply || reply=""
  case "$reply" in
    y|Y|yes|YES) remove_user_data="1" ;;
    *)           remove_user_data="0" ;;
  esac
fi
export CCSM_REMOVE_USER_DATA="$remove_user_data"

# ---- per-OS dispatch ----
OS_NAME="$(uname -s 2>/dev/null || echo unknown)"

case "$OS_NAME" in
  Darwin)
    if [[ "$(id -u)" -ne 0 ]]; then
      err "must run as root (sudo bash scripts/installer/uninstall.sh)"
      exit 1
    fi
    if [[ ! -x "$MAC_UNINSTALL" ]]; then
      warn "no installed uninstaller at $MAC_UNINSTALL — nothing to uninstall"
      exit 2
    fi
    log "dispatch → $MAC_UNINSTALL --silent (mode=$MODE, REMOVEUSERDATA=$remove_user_data)"
    # Always invoke the on-disk uninstaller in --silent mode: we already
    # captured the user's choice above and propagated via env, so the
    # downstream script must NOT prompt again.
    if [[ "$remove_user_data" == "1" ]]; then
      bash "$MAC_UNINSTALL" --silent --remove-user-data
    else
      bash "$MAC_UNINSTALL" --silent --keep-user-data
    fi
    rc=$?
    [[ $rc -eq 0 ]] || { err "mac uninstall returned $rc"; exit 3; }
    ;;

  Linux)
    if [[ "$(id -u)" -ne 0 ]]; then
      err "must run as root (sudo bash scripts/installer/uninstall.sh)"
      exit 1
    fi
    # Detect package manager. dpkg first (debian/ubuntu); rpm second
    # (fedora/rhel/suse). Both honour the postrm scripts under
    # build/install/linux/, which read CCSM_REMOVE_USER_DATA.
    if command -v dpkg >/dev/null 2>&1 && dpkg -s "$LINUX_PKG_NAME" >/dev/null 2>&1; then
      log "dispatch → dpkg -P $LINUX_PKG_NAME (REMOVEUSERDATA=$remove_user_data)"
      # -P (purge) triggers postrm with action=purge so the
      # CCSM_REMOVE_USER_DATA branch in postrm.sh fires. Plain -r (remove)
      # would skip the purge branch entirely (postrm action=remove).
      CCSM_REMOVE_USER_DATA="$remove_user_data" dpkg -P "$LINUX_PKG_NAME"
      rc=$?
    elif command -v rpm >/dev/null 2>&1 && rpm -q "$LINUX_PKG_NAME" >/dev/null 2>&1; then
      log "dispatch → rpm -e $LINUX_PKG_NAME (REMOVEUSERDATA=$remove_user_data)"
      CCSM_REMOVE_USER_DATA="$remove_user_data" rpm -e "$LINUX_PKG_NAME"
      rc=$?
    else
      warn "neither dpkg nor rpm reports $LINUX_PKG_NAME installed — nothing to uninstall"
      exit 2
    fi
    [[ $rc -eq 0 ]] || { err "linux uninstall returned $rc"; exit 3; }
    ;;

  MINGW*|MSYS*|CYGWIN*)
    err "Windows host detected ($OS_NAME)."
    err "use: powershell -ExecutionPolicy Bypass -File scripts\\installer\\uninstall.ps1"
    exit 4
    ;;

  *)
    err "unsupported OS: $OS_NAME"
    exit 4
    ;;
esac

log "OK — uninstall complete (REMOVEUSERDATA=$remove_user_data)"
exit 0
