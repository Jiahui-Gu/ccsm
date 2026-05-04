#!/usr/bin/env bash
# packages/daemon/build/install/post-install-healthz.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5 step 7 (post-install /healthz wait + 10s failure rollback).
# Task: T7.5 (#78) — installer: post-install /healthz wait + 10s failure rollback.
#
# Used by:
#   - linux/postinst.sh   (.deb DEBIAN/postinst + .rpm %post)
#   - mac/postinstall.sh  (pkg postinstall script)
#
# Responsibilities (ch10 §5 step 7):
#   - After service start, poll Supervisor /healthz over UDS for HTTP 200,
#     wait up to 10s.
#   - On timeout / non-200: capture last 200 lines of platform service log,
#     emit via stderr, then run platform-specific rollback (scripted
#     uninstall) and exit non-zero. State directory is ALWAYS preserved
#     across rollback (per spec: "state dir UNTOUCHED").
#   - On 200: log success and exit 0.
#
# Per ch03 §7 the Supervisor address is UDS-only on every OS:
#   linux: /run/ccsm/supervisor.sock
#   mac:   /var/run/com.ccsm.daemon/supervisor.sock
#
# Curl is used with --unix-socket which is available in curl >=7.40
# (ubuntu-22.04 ships 7.81; macOS 14 ships 8.x). The Host: header value
# is irrelevant for UDS but curl requires SOMETHING, so we use "localhost".
#
# Exit codes:
#   0   /healthz returned 200 within 10s
#   10  /healthz timeout (10s, no 200)
#   11  /healthz returned non-200 status
#   12  curl missing on PATH
#   13  unsupported OS (script invoked from a non-mac/non-linux host)
#   14  rollback failed (operator intervention required; state dir intact)

set -u

SCRIPT_NAME="ccsm-healthz"
TIMEOUT_SECONDS="${CCSM_HEALTHZ_TIMEOUT_SECONDS:-10}"
POLL_INTERVAL_SECONDS="${CCSM_HEALTHZ_POLL_INTERVAL_SECONDS:-1}"
LOG_TAIL_LINES="${CCSM_HEALTHZ_LOG_TAIL_LINES:-200}"

# CCSM_HEALTHZ_DRY_RUN=1 short-circuits the polling loop and the rollback
# branch — used by unit tests so the spec file can run on any host without
# a live daemon. The script still exits 0/10/11 paths but skips actual
# curl + rollback I/O.
DRY_RUN="${CCSM_HEALTHZ_DRY_RUN:-}"

# CCSM_HEALTHZ_FORCE_OUTCOME=success|timeout|non200 — used by the unit
# spec to force a specific exit branch in dry-run mode.
FORCE_OUTCOME="${CCSM_HEALTHZ_FORCE_OUTCOME:-}"

log()  { echo "[${SCRIPT_NAME}] $*"; }
warn() { echo "[${SCRIPT_NAME}] WARN: $*" >&2; }
err()  { echo "[${SCRIPT_NAME}] ERROR: $*" >&2; }

# ---- detect OS + Supervisor UDS path (ch03 §7) ----
detect_os() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Linux)  echo linux ;;
    Darwin) echo mac ;;
    *)      echo unsupported ;;
  esac
}

supervisor_socket_path() {
  case "$1" in
    linux) echo "/run/ccsm/supervisor.sock" ;;
    mac)   echo "/var/run/com.ccsm.daemon/supervisor.sock" ;;
    *)     return 1 ;;
  esac
}

service_log_capture_cmd() {
  # Returns the locked spec command (ch10 §5 step 7) for capturing the
  # platform service log on /healthz failure.
  case "$1" in
    linux) echo "journalctl -u ccsm-daemon.service -n ${LOG_TAIL_LINES} --no-pager" ;;
    mac)   echo "log show --predicate 'process == \"ccsm-daemon\"' --last 5m" ;;
    *)     return 1 ;;
  esac
}

rollback_cmd() {
  # Scripted uninstall on rollback. STATE DIR IS NOT TOUCHED — only the
  # service registration + binaries are reversed. The state dir
  # (/var/lib/ccsm on linux, /Library/Application Support/ccsm on mac) is
  # left in place per ch10 §5 step 7 explicit clause: "state dir UNTOUCHED".
  case "$1" in
    linux)
      # systemctl disable + stop is enough to back out the service
      # registration; the package manager (dpkg/rpm) finishes the file
      # rollback when this script returns non-zero AND the postinst
      # contract is "non-zero on healthz fail" (we don't return non-zero
      # from postinst itself per T7.4 commentary, so the explicit
      # disable+stop here IS the rollback). State dir untouched.
      echo "systemctl disable --now ccsm-daemon"
      ;;
    mac)
      # launchctl bootout reverses bootstrap. State dir untouched —
      # we do NOT rm /Library/Application\ Support/ccsm.
      echo "launchctl bootout system/com.ccsm.daemon"
      ;;
    *)
      return 1
      ;;
  esac
}

# ---- main ----
OS="$(detect_os)"

# In DRY-RUN with FORCE_OUTCOME (unit-test mode), default to linux when
# the host OS is unsupported — the test only cares that the exit-code
# branch fires + the spec-literal commands surface in stderr.
if [ "$OS" = "unsupported" ] && [ -n "$DRY_RUN" ] && [ -n "$FORCE_OUTCOME" ]; then
  OS="linux"
fi

if [ "$OS" = "unsupported" ]; then
  err "unsupported OS: $(uname -s 2>/dev/null || echo unknown)"
  exit 13
fi

SOCK="$(supervisor_socket_path "$OS")"
log "OS=${OS} Supervisor UDS=${SOCK} timeout=${TIMEOUT_SECONDS}s interval=${POLL_INTERVAL_SECONDS}s"

# ---- forced-outcome short-circuit (unit-test only) ----
if [ -n "$DRY_RUN" ] && [ -n "$FORCE_OUTCOME" ]; then
  case "$FORCE_OUTCOME" in
    success)
      log "DRY-RUN forced outcome=success"
      log "OK — /healthz returned 200 (simulated)"
      exit 0
      ;;
    timeout)
      log "DRY-RUN forced outcome=timeout"
      err "/healthz did not return 200 within ${TIMEOUT_SECONDS}s"
      err "service log (would run): $(service_log_capture_cmd "$OS")"
      err "rollback (would run): $(rollback_cmd "$OS")"
      err "state dir preserved (per ch10 §5 step 7)"
      exit 10
      ;;
    non200)
      log "DRY-RUN forced outcome=non200"
      err "/healthz returned non-200 (simulated)"
      err "service log (would run): $(service_log_capture_cmd "$OS")"
      err "rollback (would run): $(rollback_cmd "$OS")"
      err "state dir preserved (per ch10 §5 step 7)"
      exit 11
      ;;
    *)
      err "unknown CCSM_HEALTHZ_FORCE_OUTCOME=${FORCE_OUTCOME}"
      exit 1
      ;;
  esac
fi

# ---- live path: poll /healthz ----
if ! command -v curl >/dev/null 2>&1; then
  err "curl missing on PATH; cannot probe /healthz"
  exit 12
fi

start_epoch="$(date +%s)"
deadline_epoch=$((start_epoch + TIMEOUT_SECONDS))
last_status=""
attempts=0

while :; do
  attempts=$((attempts + 1))
  now_epoch="$(date +%s)"
  if [ "$now_epoch" -ge "$deadline_epoch" ]; then
    break
  fi

  # -s silent, -o /dev/null discard body, -w '%{http_code}' print status,
  # --max-time 1 cap each probe so a hung daemon doesn't blow the budget,
  # --unix-socket talk to the Supervisor UDS, host header is dummy.
  status="$(curl -s -o /dev/null \
                -w '%{http_code}' \
                --max-time 1 \
                --unix-socket "$SOCK" \
                http://localhost/healthz 2>/dev/null || echo "000")"
  last_status="$status"

  if [ "$status" = "200" ]; then
    log "OK — /healthz returned 200 after ${attempts} attempt(s)"
    exit 0
  fi

  log "attempt ${attempts}: /healthz status=${status}, retrying in ${POLL_INTERVAL_SECONDS}s"
  sleep "$POLL_INTERVAL_SECONDS"
done

# ---- failure path: capture log, rollback, exit non-zero ----
err "/healthz did not return 200 within ${TIMEOUT_SECONDS}s (last status=${last_status})"

LOG_CMD="$(service_log_capture_cmd "$OS")"
err "capturing last ${LOG_TAIL_LINES} log lines: ${LOG_CMD}"
# Run the capture; do not let a missing journalctl/log abort us.
sh -c "$LOG_CMD" 2>&1 | tail -n "$LOG_TAIL_LINES" >&2 || warn "log capture failed (continuing)"

ROLLBACK_CMD="$(rollback_cmd "$OS")"
err "rolling back service registration: ${ROLLBACK_CMD}"
err "(state directory preserved per ch10 §5 step 7)"
if ! sh -c "$ROLLBACK_CMD" 2>&1 >&2; then
  err "rollback command failed; operator intervention required"
  exit 14
fi

# Distinguish timeout (no http response ever) from non-200 (response came
# but wrong status). last_status="000" means curl failed every probe.
if [ "$last_status" = "000" ] || [ -z "$last_status" ]; then
  exit 10
else
  exit 11
fi
