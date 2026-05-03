#!/usr/bin/env bash
# run.sh — launch Windows named-pipe h2c server, run client soak, tear down.
#
# Spike T9.5: smoke (60s default) or 1h soak via SPIKE_DURATION_SEC=3600.
# Win32-only (named pipes are a Windows kernel object). On non-win32 hosts
# the harness short-circuits with exit 2 (use uds-h2c spike there).
#
# Forever-stable contract:
#
#   Usage:
#     run.sh
#
#   Env:
#     SPIKE_DURATION_SEC   default 60. Forwarded to client.mjs.
#     SPIKE_PIPE           default ccsm-spike (resolved to \\?\pipe\<name>
#                          inside server.mjs / client.mjs).
#     SPIKE_LOG_DIR        default $TMP / $TEMP / /tmp.
#
#   Output:
#     - server stdout/stderr -> $SPIKE_LOG_DIR/win-h2-named-pipe-server.log
#     - client RTT NDJSON   -> $SPIKE_LOG_DIR/win-h2-named-pipe-rtt.ndjson
#     - client summary JSON -> $SPIKE_LOG_DIR/win-h2-named-pipe-summary.json + stdout
#     - rtt-histogram JSON  -> $SPIKE_LOG_DIR/win-h2-named-pipe-histogram.json + stdout
#
#   Exit codes: 0 PASS; 3 FAIL (forwarded from client); 2 unsupported OS;
#               1 server start failure.

set -euo pipefail

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) ;;
  Linux|Darwin)
    echo "win-h2-named-pipe spike: skipped on $OS_NAME (use uds-h2c spike instead)" >&2
    exit 2
    ;;
  *)
    echo "win-h2-named-pipe spike: unsupported OS $OS_NAME" >&2
    exit 2
    ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="$(cd "$HERE/../.." && pwd)"
PIPE_NAME="${SPIKE_PIPE:-ccsm-spike}"
LOG_DIR="${SPIKE_LOG_DIR:-${TMP:-${TEMP:-/tmp}}}"
DURATION="${SPIKE_DURATION_SEC:-60}"

SERVER_LOG="$LOG_DIR/win-h2-named-pipe-server.log"
RTT_NDJSON="$LOG_DIR/win-h2-named-pipe-rtt.ndjson"
SUMMARY="$LOG_DIR/win-h2-named-pipe-summary.json"
HISTOGRAM="$LOG_DIR/win-h2-named-pipe-histogram.json"

# Teardown: kill server. Named pipes have no FS residue to unlink.
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
}
trap cleanup EXIT INT TERM

echo "starting server (pipe=\\\\?\\pipe\\$PIPE_NAME)" >&2
node "$HERE/server.mjs" --pipe="$PIPE_NAME" >"$SERVER_LOG" 2>&1 &
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
SPIKE_DURATION_SEC="$DURATION" node "$HERE/client.mjs" --pipe="$PIPE_NAME" --rate=10 \
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
