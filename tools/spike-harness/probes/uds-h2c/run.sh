#!/usr/bin/env bash
# run.sh — launch UDS h2c server, run client soak, tear down.
#
# Spike T9.4: smoke (60s default) or 1h soak via SPIKE_DURATION_SEC=3600.
# Skips on win32 (UDS path semantics differ — use named-pipe spike instead).
#
# Forever-stable contract:
#
#   Usage:
#     run.sh
#
#   Env:
#     SPIKE_DURATION_SEC   default 60. Forwarded to client.mjs.
#     SPIKE_SOCKET         default /tmp/ccsm-spike.sock
#
#   Output:
#     - server stdout/stderr -> $SPIKE_LOG_DIR/server.log (default /tmp)
#     - client RTT NDJSON   -> $SPIKE_LOG_DIR/rtt.ndjson
#     - client summary JSON -> $SPIKE_LOG_DIR/summary.json + stdout
#     - rtt-histogram JSON  -> $SPIKE_LOG_DIR/histogram.json + stdout
#
#   Exit codes: 0 PASS; 3 FAIL (forwarded from client); 2 unsupported OS;
#               1 server start failure.

set -euo pipefail

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Linux|Darwin) ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    echo "uds-h2c spike: skipped on $OS_NAME (win32 — use named-pipe spike)" >&2
    exit 2
    ;;
  *)
    echo "uds-h2c spike: unsupported OS $OS_NAME" >&2
    exit 2
    ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="$(cd "$HERE/.." && pwd)"
SOCKET="${SPIKE_SOCKET:-/tmp/ccsm-spike.sock}"
LOG_DIR="${SPIKE_LOG_DIR:-/tmp}"
DURATION="${SPIKE_DURATION_SEC:-60}"

SERVER_LOG="$LOG_DIR/uds-h2c-server.log"
RTT_NDJSON="$LOG_DIR/uds-h2c-rtt.ndjson"
SUMMARY="$LOG_DIR/uds-h2c-summary.json"
HISTOGRAM="$LOG_DIR/uds-h2c-histogram.json"

# Teardown: kill server, unlink socket. Idempotent (also covered by server's
# own SIGTERM handler).
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    # Wait up to 2s for graceful exit.
    for _ in 1 2 3 4; do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
      sleep 0.5
    done
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      kill -KILL "$SERVER_PID" 2>/dev/null || true
    fi
  fi
  if [ -S "$SOCKET" ]; then
    rm -f "$SOCKET" || true
  fi
}
trap cleanup EXIT INT TERM

# Stale-socket guard (server unlinks too, belt-and-braces).
[ -S "$SOCKET" ] && rm -f "$SOCKET"

echo "starting server (socket=$SOCKET)" >&2
node "$HERE/server.mjs" --socket="$SOCKET" >"$SERVER_LOG" 2>&1 &
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
SPIKE_DURATION_SEC="$DURATION" node "$HERE/client.mjs" --socket="$SOCKET" --rate=10 \
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
