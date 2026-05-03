#!/usr/bin/env node
// server.mjs — Node 22 http2 (h2c) server bound to a Unix Domain Socket.
//
// Spike T9.4: confirm http2 over UDS is viable on darwin + linux for the
// v0.3 daemon-split transport (per spec ch03 §4 transport options A1-A4,
// option "h2c-UDS"). Cross-link: docs/superpowers/specs/2026-05-02-final-
// architecture.md (Listener A = peer-cred-trusted local socket).
//
// Forever-stable contract (per spike-harness/README.md §"Forever-stable"):
//
//   Usage:
//     server.mjs [--socket=<path>]   default /tmp/ccsm-spike.sock
//
//   Behavior:
//     - createSecureServer is NOT used; this is plaintext h2c (cleartext)
//       since the transport is a same-UID local socket.
//     - Listens on the UDS path. Removes any stale socket file first.
//     - Routes:
//         GET /ping  -> 200, body "pong"
//         anything else -> 404
//     - On SIGTERM / SIGINT: graceful close, unlink socket, exit 0.
//     - Prints "listening <path>\n" to stdout once ready.
//
//   Exit codes: 0 clean shutdown; 2 bad arg; 1 fatal listen error.
//
// Layer-1: node: stdlib only (http2, fs, net, util).

import { createServer } from 'node:http2';
import { existsSync, unlinkSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { platform } from 'node:os';

if (platform() === 'win32') {
  process.stderr.write('uds-h2c server: win32 unsupported (use named pipe spike instead)\n');
  process.exit(2);
}

const { values } = parseArgs({
  options: { socket: { type: 'string', default: '/tmp/ccsm-spike.sock' } },
  strict: true,
});

const socketPath = values.socket;

if (existsSync(socketPath)) {
  try { unlinkSync(socketPath); } catch (e) {
    process.stderr.write(`failed to unlink stale socket: ${e.message}\n`);
    process.exit(1);
  }
}

const server = createServer();

server.on('stream', (stream, headers) => {
  const path = headers[':path'];
  const method = headers[':method'];
  if (method === 'GET' && path === '/ping') {
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    stream.end('pong');
    return;
  }
  stream.respond({ ':status': 404 });
  stream.end();
});

server.on('error', (err) => {
  process.stderr.write(`server error: ${err.message}\n`);
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
  // Hard timeout so a stuck client can't pin the spike.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

server.listen(socketPath, () => {
  process.stdout.write(`listening ${socketPath}\n`);
});
