#!/usr/bin/env node
// server.mjs — minimal UDS echo server for cross-user reachability probe.
//
// Spike T9.2 (spec ch14 §1.2 phase 0.5): determine, on macOS, which UDS
// bind paths are reachable from a *different local user* WITHOUT Full Disk
// Access (FDA) being granted to the connecting process. Result feeds the
// listener-A wiring decision (peer-cred-trusted local socket) on darwin.
//
// This server intentionally does NOT speak h2c — the question being probed
// is "can the peer connect() at all" and "what does TCC do to it", not
// throughput. A trivial line protocol keeps the failure surface obvious:
// any non-OK exit is attributable to bind/permission/TCC, not framing.
//
// Forever-stable contract:
//
//   Usage:
//     server.mjs --socket=<path> [--mode=<octal>]
//
//   Behavior:
//     - bind(socket); on success, chmod to --mode (default 0666 so the
//       cross-user probe can isolate TCC effects from POSIX perms).
//     - For each connection: read one line, echo "ack:<line>\n", close.
//     - SIGTERM/SIGINT: close listener, unlink socket, exit 0.
//     - On bind failure: print one JSON line to stderr and exit 1.
//     - Prints "listening <path>\n" to stdout once ready.
//
//   Exit codes: 0 clean shutdown; 1 bind/listen failure; 2 bad arg or
//               unsupported OS.
//
// Layer-1: node: stdlib only (net, fs, util, os).

import { createServer } from 'node:net';
import { existsSync, unlinkSync, chmodSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { platform } from 'node:os';

if (platform() === 'win32') {
  process.stderr.write('macos-uds-cross-user server: win32 unsupported\n');
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    socket: { type: 'string' },
    mode:   { type: 'string', default: '0666' },
  },
  strict: true,
});

if (!values.socket) {
  process.stderr.write('--socket=<path> required\n');
  process.exit(2);
}

const socketPath = values.socket;
const mode = parseInt(values.mode, 8);
if (!Number.isFinite(mode)) {
  process.stderr.write(`bad --mode (expected octal, got "${values.mode}")\n`);
  process.exit(2);
}

if (existsSync(socketPath)) {
  try { unlinkSync(socketPath); } catch (e) {
    process.stderr.write(JSON.stringify({ stage: 'unlink-stale', errno: e.code, message: e.message }) + '\n');
    process.exit(1);
  }
}

const server = createServer((sock) => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    const i = buf.indexOf('\n');
    if (i >= 0) {
      const line = buf.slice(0, i);
      sock.end(`ack:${line}\n`);
    }
  });
  sock.on('error', () => { /* ignore peer reset */ });
});

server.on('error', (err) => {
  process.stderr.write(JSON.stringify({ stage: 'server-error', errno: err.code, message: err.message }) + '\n');
  process.exit(1);
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`got ${sig}, shutting down\n`);
  server.close(() => {
    try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

server.listen(socketPath, () => {
  try {
    chmodSync(socketPath, mode);
  } catch (e) {
    process.stderr.write(JSON.stringify({ stage: 'chmod', errno: e.code, message: e.message }) + '\n');
    process.exit(1);
  }
  process.stdout.write(`listening ${socketPath}\n`);
});
