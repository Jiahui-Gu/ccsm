#!/usr/bin/env bash
# run.sh — launch loopback-h2c (h2c on 127.0.0.1) server, run client soak, tear down.
#
# Spike T9.3 (ch14 §1.3 phase 0.5): smoke (60s default) or 1h soak via
# SPIKE_DURATION_SEC=3600. **win32 only** — this probe exists to catch
# Win 11 25H2 networking-stack regressions on loopback h2c. On non-win32
# the harness short-circuits with exit 2 (uds-h2c covers darwin/linux per
# T9.4).
#
# Forever-stable contract:
#
#   Usage:
#     run.sh
#
#   Env:
#     SPIKE_DURATION_SEC   default 60. Forwarded to client.mjs.
#     SPIKE_HOST           default 127.0.0.1.
#     SPIKE_PORT_FILE      default $TMP/ccsm-loopback-h2c-port.
#     SPIKE_LOG_DIR        default $TMP.
#
#   Output:
#     - server stdout/stderr -> $SPIKE_LOG_DIR/loopback-h2c-server.log
#     - client RTT NDJSON   -> $SPIKE_LOG_DIR/loopback-h2c-rtt.ndjson
#     - client summary JSON -> $SPIKE_LOG_DIR/loopback-h2c-summary.json + stdout
#     - rtt-histogram JSON  -> $SPIKE_LOG_DIR/loopback-h2c-histogram.json + stdout
#
#   Exit codes: 0 PASS; 3 FAIL (forwarded from client); 2 unsupported OS;
#               1 server start failure.

set -euo pipefail

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) ;;
  *)
    echo "loopback-h2c-on-25h2 spike: skipped on $OS_NAME (win32-only probe; darwin/linux use uds-h2c)" >&2
    exit 2
    ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="$(cd "$HERE/../.." && pwd)"

# Normalize $TMP across MSYS/Git Bash/Cygwin.
DEFAULT_TMP="${TMP:-${TEMP:-/tmp}}"
HOST="${SPIKE_HOST:-127.0.0.1}"
PORT_FILE="${SPIKE_PORT_FILE:-$DEFAULT_TMP/ccsm-loopback-h2c-port}"
LOG_DIR="${SPIKE_LOG_DIR:-$DEFAULT_TMP}"
DURATION="${SPIKE_DURATION_SEC:-60}"

mkdir -p "$LOG_DIR"

SERVER_LOG="$LOG_DIR/loopback-h2c-server.log"
RTT_NDJSON="$LOG_DIR/loopback-h2c-rtt.ndjson"
SUMMARY="$LOG_DIR/loopback-h2c-summary.json"
HISTOGRAM="$LOG_DIR/loopback-h2c-histogram.json"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4; do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
      sleep 0.5
    done
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      kill -KILL "$SERVER_PID" 2>/dev/null || true
    fi
  fi
  if [ -f "$PORT_FILE" ]; then
    rm -f "$PORT_FILE" || true
  fi
}
trap cleanup EXIT INT TERM

# Stale port-file guard (server overwrites too, belt-and-braces).
[ -f "$PORT_FILE" ] && rm -f "$PORT_FILE"

echo "starting server (host=$HOST, ephemeral port -> $PORT_FILE)" >&2
node "$HERE/server.mjs" --host="$HOST" --port=0 --port-file="$PORT_FILE" \
  >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Wait up to 5s for "listening" line.
for _ in $(seq 1 50); do
  if grep -q "^listening " "$SERVER_LOG" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server died during startup; log:" >&2
    cat "$SERVER_LOG" >&2
    exit 1
  fi
  sleep 0.1
done

if ! grep -q "^listening " "$SERVER_LOG" 2>/dev/null; then
  echo "server did not become ready in 5s; log:" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi

echo "running client (duration=${DURATION}s, rate=10/s)" >&2
set +e
SPIKE_DURATION_SEC="$DURATION" node "$HERE/client.mjs" \
  --host="$HOST" --port-file="$PORT_FILE" --rate=10 \
  >"$SUMMARY" 2>"$RTT_NDJSON"
CLIENT_EXIT=$?
set -e

echo "--- summary ---"
cat "$SUMMARY"

# Feed RTT lines through the existing histogram helper.
if [ -s "$RTT_NDJSON" ]; then
  node "$HARNESS_DIR/rtt-histogram.mjs" <"$RTT_NDJSON" >"$HISTOGRAM"
  echo "--- histogram ---"
  cat "$HISTOGRAM"
fi

exit "$CLIENT_EXIT"
