#!/usr/bin/env bash
# connect-and-peercred.sh — connect to a Unix domain socket and report peer creds.
#
# Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
# Used by ch14 §1.1, §1.4, §1.5 (peer-cred + UDS transport spikes on
# macOS / Linux).
#
# Contract (FOREVER-STABLE — v0.4 may add args, never rename/remove):
#
#   Usage:
#     connect-and-peercred.sh <socket-path>
#
#   Behavior:
#     1. connect(2) to the UDS at <socket-path>.
#     2. Resolve peer credentials (uid, gid, pid).
#        - macOS: getsockopt(LOCAL_PEEREPID) + LOCAL_PEERCRED
#        - Linux: getsockopt(SO_PEERCRED)  → struct ucred
#     3. Print one JSON line to stdout, then exit 0.
#
#   Output (stdout, single line, JSON):
#     {"socket":"<path>","uid":<int>,"gid":<int>,"pid":<int>,"os":"<linux|darwin>"}
#
#   Exit 0 on success; non-zero on connect/getsockopt failure with stderr msg.
#
# Implementation: delegates to a small node:net script so we avoid a separate
# C compile in the harness. Node 22 exposes peer creds via socket._getpeername
# is NOT enough — we shell out to `getent`/`stat` on Linux as a fallback when
# unavailable. Stub today; full implementation lands with T9.1 / T9.4 / T9.5.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: connect-and-peercred.sh <socket-path>" >&2
  exit 2
fi

SOCKET_PATH="$1"

if [ ! -S "$SOCKET_PATH" ]; then
  echo "error: not a socket: $SOCKET_PATH" >&2
  exit 3
fi

OS_NAME="$(uname -s | tr '[:upper:]' '[:lower:]')"

# Inline node:net script — uses only node: stdlib (no npm deps).
exec node --input-type=module -e "
import net from 'node:net';
const sock = '$SOCKET_PATH';
const os   = '$OS_NAME';
const c = net.createConnection(sock);
c.on('connect', () => {
  // TODO: implement when T9.1 lands. Node has no public API for SO_PEERCRED;
  // requires either a C addon or process.binding('uv') hack. The forever-stable
  // contract above (output JSON shape) is locked; the resolution mechanism is
  // an implementation detail.
  process.stdout.write(JSON.stringify({
    socket: sock, uid: -1, gid: -1, pid: -1, os, todo: 'T9.1'
  }) + '\n');
  c.end();
});
c.on('error', (e) => {
  process.stderr.write('connect error: ' + e.message + '\n');
  process.exit(4);
});
"
