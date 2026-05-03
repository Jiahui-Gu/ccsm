#!/usr/bin/env node
// server.mjs — Node 22 http2 (h2c) server bound to a Windows named pipe.
//
// Spike T9.5: confirm http2 over a Windows named pipe is viable for the
// v0.3 daemon-split transport on win32 (parallel to T9.4 UDS spike, which
// is the darwin/linux companion). Cross-link: spec ch14 §1.5 phase 0.5
// (must resolve before A4 transport pick on Windows) and
// docs/superpowers/specs/2026-05-02-final-architecture.md (Listener A =
// peer-cred-trusted local socket).
//
// Forever-stable contract (per spike-harness/README.md §"Forever-stable"):
//
//   Usage:
//     server.mjs [--pipe=<name>]   default ccsm-spike
//                                  Resolved to \\?\pipe\<name> internally;
//                                  pass either a bare name or a full
//                                  \\.\pipe\... / \\?\pipe\... path.
//
//   Behavior:
//     - createSecureServer is NOT used; this is plaintext h2c (cleartext)
//       since the transport is a same-user local pipe with DACL gating
//       (see set-pipe-dacl.ps1 for the Listener A hardening).
//     - net.createServer().listen(<pipe path>) — Node maps this to
//       CreateNamedPipe(W) via libuv on win32. The Duplex stream surfaced
//       to http2 is a net.Socket, just like the UDS case.
//     - Routes:
//         GET /ping  -> 200, body "pong"
//         anything else -> 404
//     - On SIGTERM / SIGINT / Ctrl+Break: graceful close, exit 0. Named
//       pipes do not leave a filesystem residue, so no unlink is needed.
//     - Prints "listening <pipe path>\n" to stdout once ready.
//
//   Exit codes: 0 clean shutdown; 2 unsupported OS / bad arg; 1 fatal
//               listen error.
//
// Layer-1: node: stdlib only (http2, net, util, os).

import { createServer as createHttp2Server } from 'node:http2';
import { createServer as createNetServer } from 'node:net';
import { parseArgs } from 'node:util';
import { platform } from 'node:os';

if (platform() !== 'win32') {
  process.stderr.write('win-h2-named-pipe server: only supported on win32 (use uds-h2c on darwin/linux)\n');
  process.exit(2);
}

const { values } = parseArgs({
  options: { pipe: { type: 'string', default: 'ccsm-spike' } },
  strict: true,
});

// Accept bare name, \\.\pipe\name, or \\?\pipe\name. Normalize to the
// \\?\pipe\ prefix Node + libuv expect on win32.
function resolvePipePath(input) {
  if (input.startsWith('\\\\?\\pipe\\') || input.startsWith('\\\\.\\pipe\\')) {
    return input;
  }
  return `\\\\?\\pipe\\${input}`;
}
const pipePath = resolvePipePath(values.pipe);

const h2 = createHttp2Server();

h2.on('stream', (stream, headers) => {
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

h2.on('error', (err) => {
  process.stderr.write(`http2 server error: ${err.message}\n`);
});

// Bridge a raw net server (which actually owns the named pipe) into the
// http2 server by handing each accepted Socket to http2 via emit('connection').
// This mirrors how http2.createServer().listen() works on TCP/UDS, but
// keeps us in full control of the underlying transport surface for the
// pipe case so we can confirm the Duplex contract is honored.
const net = createNetServer((sock) => {
  h2.emit('connection', sock);
});

net.on('error', (err) => {
  process.stderr.write(`pipe listen error: ${err.message}\n`);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`got ${sig}, shutting down\n`);
  net.close(() => {
    h2.close(() => process.exit(0));
  });
  // Hard timeout so a stuck client can't pin the spike.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
// Ctrl+Break on Windows surfaces as SIGBREAK.
process.on('SIGBREAK', () => shutdown('SIGBREAK'));

net.listen(pipePath, () => {
  process.stdout.write(`listening ${pipePath}\n`);
});
