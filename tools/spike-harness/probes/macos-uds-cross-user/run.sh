#!/usr/bin/env bash
# run.sh — iterate macOS UDS bind-path candidates, classify cross-user
# reachability with and without Full Disk Access (FDA).
#
# Spike T9.2 (spec ch14 §1.2 phase 0.5): must resolve before listener-A
# wiring on macOS. The question: does v0.3's daemon need to bind its
# Listener-A UDS under a path that requires the *connecting* process to
# hold an FDA grant, and conversely which paths are reachable cross-user
# WITHOUT FDA at all?
#
# Forever-stable contract:
#
#   Usage:
#     run.sh
#
#   Env:
#     SPIKE_SECONDARY_USER   if set, run client.mjs as this local user via
#                            `sudo -n -u <user>` for the cross-user leg.
#                            Required for the cross-user verdict; if unset
#                            the script still emits the same-user matrix
#                            and marks every cross-user row as SKIPPED.
#     SPIKE_LOG_DIR          default /tmp. Where matrix.ndjson + server
#                            logs land.
#     SPIKE_BIND_MODE        chmod applied to the UDS after bind. Default
#                            0666 (perm-permissive, so EPERM in the
#                            cross-user leg is attributable to TCC/FDA
#                            rather than POSIX).
#
#   Output:
#     - $SPIKE_LOG_DIR/macos-uds-cross-user-matrix.ndjson  one row per
#       (path, leg) combination. Schema:
#         {"path":<str>,"leg":"same-user"|"cross-user","tccProtected":
#          <bool>,"outcome":<see client.mjs>,"errno":<str|null>,
#          "rttMs":<int|null>,"verdict":"FDA-FREE"|"FDA-REQUIRED"|
#          "UNREACHABLE"|"SKIPPED"}
#     - $SPIKE_LOG_DIR/macos-uds-cross-user-summary.json  aggregate
#       counts grouped by verdict; printed to stdout too.
#
#   Exit codes:
#     0  matrix collected; PROBE-RESULT.md should be regenerated from it.
#     2  unsupported OS (only darwin is in scope; linux exits 2 because
#        the FDA question doesn't apply, win32 exits 2 because UDS path
#        semantics differ — see uds-h2c probe).
#     1  server failed to start at any path (real bug, not a verdict).

set -euo pipefail

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Darwin) ;;
  Linux)
    echo "macos-uds-cross-user: skipped on Linux (FDA is a darwin TCC concept)" >&2
    exit 2
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    echo "macos-uds-cross-user: skipped on $OS_NAME (UDS path semantics differ)" >&2
    exit 2
    ;;
  *)
    echo "macos-uds-cross-user: unsupported OS $OS_NAME" >&2
    exit 2
    ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${SPIKE_LOG_DIR:-/tmp}"
SECONDARY_USER="${SPIKE_SECONDARY_USER:-}"
BIND_MODE="${SPIKE_BIND_MODE:-0666}"

MATRIX="$LOG_DIR/macos-uds-cross-user-matrix.ndjson"
SUMMARY="$LOG_DIR/macos-uds-cross-user-summary.json"
SERVER_LOG="$LOG_DIR/macos-uds-cross-user-server.log"

: > "$MATRIX"
: > "$SERVER_LOG"

PRIMARY_USER="$(id -un)"
HOME_DIR="$HOME"

# Candidate matrix. Each row is "path|tccProtected".
# tccProtected reflects Apple's documented TCC scopes (per
# developer.apple.com/documentation/security/protecting-user-data-with-app-
# sandbox + sandbox-exec(1) man page): ~/Library/{Application Support,
# Containers,Preferences,Caches} are TCC-fenced; ~/Documents,Downloads,
# Desktop are TCC-fenced for Application Data; /Users/Shared, /tmp,
# /private/tmp, /var/run (= /private/var/run) are NOT TCC-fenced for
# UDS connect() in the documented sandbox profile.
#
# /var/run is noted but skipped at runtime if not writable as $PRIMARY_USER
# (it requires root to bind on default macOS).
TS="$(date +%s)"
SUFFIX="ccsm-spike-$TS-$$"

CANDIDATES=(
  "/tmp/$SUFFIX.sock|false"
  "/private/tmp/$SUFFIX.sock|false"
  "/Users/Shared/$SUFFIX.sock|false"
  "$HOME_DIR/Library/Caches/$SUFFIX.sock|true"
  "$HOME_DIR/Library/Application Support/$SUFFIX.sock|true"
  "$HOME_DIR/Documents/$SUFFIX.sock|true"
)

# Pre-create parent dirs we own. /tmp + /private/tmp + /Users/Shared exist
# system-wide. ~/Library/Caches and ~/Library/Application Support exist for
# any account; ~/Documents likewise. We only mkdir -p the .sock's parent
# defensively in case a fresh user account is missing one.
for row in "${CANDIDATES[@]}"; do
  path="${row%%|*}"
  parent="$(dirname "$path")"
  if [ ! -d "$parent" ]; then
    mkdir -p "$parent" 2>/dev/null || true
  fi
done

# server_pid for cleanup.
SERVER_PID=""
ACTIVE_SOCKET=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -0 "$SERVER_PID" 2>/dev/null && kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$ACTIVE_SOCKET" ] && [ -S "$ACTIVE_SOCKET" ]; then
    rm -f "$ACTIVE_SOCKET" || true
  fi
}
trap cleanup EXIT INT TERM

start_server() {
  local socket="$1"
  ACTIVE_SOCKET="$socket"
  [ -S "$socket" ] && rm -f "$socket"
  echo "=== starting server at $socket ===" >>"$SERVER_LOG"
  node "$HERE/server.mjs" --socket="$socket" --mode="$BIND_MODE" \
    >>"$SERVER_LOG" 2>>"$SERVER_LOG" &
  SERVER_PID=$!
  # Wait up to 3s for "listening" on this path.
  for _ in $(seq 1 30); do
    if grep -q "^listening $socket\$" "$SERVER_LOG" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      return 1
    fi
    sleep 0.1
  done
  return 1
}

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -0 "$SERVER_PID" 2>/dev/null && kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
  if [ -n "$ACTIVE_SOCKET" ] && [ -S "$ACTIVE_SOCKET" ]; then
    rm -f "$ACTIVE_SOCKET" || true
  fi
  ACTIVE_SOCKET=""
}

# verdict_for tccProtected outcome (echo to stdout)
verdict_for() {
  local tcc="$1"
  local outcome="$2"
  if [ "$outcome" = "OK" ]; then
    echo "FDA-FREE"
  elif [ "$tcc" = "true" ] && { [ "$outcome" = "EPERM" ] || [ "$outcome" = "EACCES" ] || [ "$outcome" = "ENOENT" ]; }; then
    # TCC-fenced parent + permission/visibility denial = FDA needed for the
    # connecting process. ENOENT shows up here because TCC can hide the
    # path from a non-granted peer rather than return EPERM (per Apple's
    # sandbox-exec docs on file-read-data deny-with-no-such-file).
    echo "FDA-REQUIRED"
  else
    echo "UNREACHABLE"
  fi
}

run_client_leg() {
  local path="$1"
  local leg="$2"      # same-user|cross-user
  local tcc="$3"      # true|false
  local raw=""
  if [ "$leg" = "same-user" ]; then
    raw="$(node "$HERE/client.mjs" --socket="$path" --timeout-ms=3000 --message="probe-$leg" 2>/dev/null || true)"
  else
    if [ -z "$SECONDARY_USER" ]; then
      printf '{"path":%s,"leg":"cross-user","tccProtected":%s,"outcome":"SKIPPED","errno":null,"rttMs":null,"verdict":"SKIPPED"}\n' \
        "$(json_str "$path")" "$tcc" >>"$MATRIX"
      return
    fi
    # sudo -n: never prompt. -u: target user. We do NOT use -H so HOME
    # stays the *primary* user's home — the probe is checking whether
    # user-B can connect to user-A's socket, not whether user-B's own
    # ~/Library is reachable.
    raw="$(sudo -n -u "$SECONDARY_USER" node "$HERE/client.mjs" --socket="$path" --timeout-ms=3000 --message="probe-$leg" 2>/dev/null || true)"
  fi

  if [ -z "$raw" ]; then
    printf '{"path":%s,"leg":%s,"tccProtected":%s,"outcome":"OTHER","errno":"NO_OUTPUT","rttMs":null,"verdict":"UNREACHABLE"}\n' \
      "$(json_str "$path")" "$(json_str "$leg")" "$tcc" >>"$MATRIX"
    return
  fi

  # Parse JSON via node (jq not assumed present in spike-harness Layer-1).
  local enriched
  enriched="$(node -e '
    const raw = process.argv[1];
    const tcc = process.argv[2] === "true";
    const leg = process.argv[3];
    let row;
    try { row = JSON.parse(raw); } catch (e) {
      console.log(JSON.stringify({ outcome: "OTHER", errno: "PARSE", rttMs: null }));
      process.exit(0);
    }
    function verdict(tcc, outcome) {
      if (outcome === "OK") return "FDA-FREE";
      if (tcc && (outcome === "EPERM" || outcome === "EACCES" || outcome === "ENOENT")) return "FDA-REQUIRED";
      return "UNREACHABLE";
    }
    console.log(JSON.stringify({
      path: row.socket,
      leg,
      tccProtected: tcc,
      outcome: row.outcome,
      errno: row.errno,
      rttMs: row.rttMs,
      verdict: verdict(tcc, row.outcome),
    }));
  ' "$raw" "$tcc" "$leg")"
  echo "$enriched" >>"$MATRIX"
}

# Tiny JSON string encoder (handles backslash + double-quote; paths on
# darwin don't contain control chars in our matrix).
json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

echo "primary user: $PRIMARY_USER" >&2
if [ -n "$SECONDARY_USER" ]; then
  echo "secondary user: $SECONDARY_USER (cross-user leg ENABLED)" >&2
else
  echo "secondary user: <unset> (cross-user leg SKIPPED — set SPIKE_SECONDARY_USER to enable)" >&2
fi

for row in "${CANDIDATES[@]}"; do
  path="${row%%|*}"
  tcc="${row##*|}"

  echo "--- candidate: $path (tccProtected=$tcc) ---" >&2

  if ! start_server "$path"; then
    echo "  server bind failed — recording UNREACHABLE for both legs" >&2
    bind_err="$(tail -n 5 "$SERVER_LOG" | tr '\n' ' ' | sed 's/"/\\"/g')"
    printf '{"path":%s,"leg":"same-user","tccProtected":%s,"outcome":"OTHER","errno":"BIND_FAIL","rttMs":null,"verdict":"UNREACHABLE","bindError":"%s"}\n' \
      "$(json_str "$path")" "$tcc" "$bind_err" >>"$MATRIX"
    printf '{"path":%s,"leg":"cross-user","tccProtected":%s,"outcome":"OTHER","errno":"BIND_FAIL","rttMs":null,"verdict":"UNREACHABLE","bindError":"%s"}\n' \
      "$(json_str "$path")" "$tcc" "$bind_err" >>"$MATRIX"
    stop_server
    continue
  fi

  run_client_leg "$path" "same-user" "$tcc"
  run_client_leg "$path" "cross-user" "$tcc"
  stop_server
done

# Aggregate.
node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
  const counts = { "FDA-FREE": 0, "FDA-REQUIRED": 0, "UNREACHABLE": 0, "SKIPPED": 0 };
  const byPath = {};
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
    byPath[r.path] = byPath[r.path] ?? {};
    byPath[r.path][r.leg] = { outcome: r.outcome, errno: r.errno, verdict: r.verdict };
  }
  const summary = { rows: lines.length, counts, byPath };
  fs.writeFileSync(process.argv[2], JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
' "$MATRIX" "$SUMMARY"

echo "matrix:  $MATRIX" >&2
echo "summary: $SUMMARY" >&2
exit 0
