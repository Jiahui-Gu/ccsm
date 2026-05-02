#!/usr/bin/env node
// sea-hello/index.mjs — minimal Node 22 SEA hello-world for the SEA / notarization spike.
//
// Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
// Used by ch14 §1.10 (Node 22 SEA bring-up) and ch14 §1.13 (macOS notarization).
//
// Contract (FOREVER-STABLE — v0.4 may add behavior, never rename/remove):
//
//   Usage:
//     node index.mjs <port-file-path>
//     # or, after `node --experimental-sea-config sea-config.json`:
//     ./sea-hello <port-file-path>
//
//   Behavior:
//     1. Bind a TCP server on an ephemeral port (127.0.0.1, port 0).
//     2. Every accepted connection writes "OK\n" and closes.
//     3. Write the assigned port to <port-file-path> as JSON:
//          {"port": <int>}
//     4. Run until SIGINT / SIGTERM.
//
//   Output (port-file): {"port":<int>}
//   Output (stdout):    none in steady state.
//
//   Exit 0 on clean shutdown; non-zero on bind failure.
//
// Why no proto / peer-cred / Listener-A code: this script is the smallest
// runnable Node binary used to validate the SEA build pipeline + macOS
// codesign + notarization path. It MUST stay dependency-free and small so
// the SEA blob bytes are dominated by Node itself, not by user code.
//
// Layer-1: node: stdlib only (net, fs).

import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';

const portFile = process.argv[2];
if (!portFile) {
  process.stderr.write('usage: sea-hello <port-file-path>\n');
  process.exit(2);
}

const server = createServer((socket) => {
  socket.end('OK\n');
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (typeof addr === 'object' && addr) {
    writeFileSync(portFile, JSON.stringify({ port: addr.port }));
  }
});

server.on('error', (e) => {
  process.stderr.write('listen error: ' + e.message + '\n');
  process.exit(3);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
