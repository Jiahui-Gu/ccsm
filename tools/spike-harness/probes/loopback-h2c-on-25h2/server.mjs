#!/usr/bin/env node
// server.mjs — Node 22 http2 (h2c) server bound to 127.0.0.1 (loopback TCP).
//
// Spike T9.3 (ch14 §1.3 phase 0.5): confirm Win 11 25H2 still allows plaintext
// HTTP/2 (h2c) on a loopback TCP listener with no third-party LSP/firewall
// hook breaking it. This unblocks the transport pick row in ch14 §1.A matrix
// (Listener B = `127.0.0.1:PORT_TUNNEL`, h2c upstream of cloudflared) by
// retiring the "what if 25H2's new networking stack drops h2c on loopback"
// risk before we commit to that wire format.
//
// This probe is the Windows counterpart to the uds-h2c spike (T9.4): same
// server/client/run shape, swapping UDS for loopback TCP, and gating on
// win32.
//
// Forever-stable contract (per spike-harness/README.md §"Forever-stable"):
//
//   Usage:
//     server.mjs [--host=<addr>] [--port=<int>] [--port-file=<path>]
//                  default host 127.0.0.1; port 0 (ephemeral); port-file
//                  defaults to $TMP/ccsm-loopback-h2c-port.
//
//   Behavior:
//     - createSecureServer is NOT used; this is plaintext h2c (cleartext)
//       per ch14 §1.3 phase 0.5 — the loopback TCP listener is consumed
//       only by the local cloudflared sidecar (Listener B) and gated by
//       JWT validation at the listener boundary.
//     - Listens on host:port (port 0 → kernel-assigned).
//     - Writes the chosen port to <port-file> as a single line, then prints
//       "listening <host>:<port>\n" to stdout.
//     - Routes:
//         GET  /ping     -> 200, body "pong"           (unary RTT probe)
//         GET  /stream?n=<int>&hz=<int>  -> 200, server-streaming NDJSON
//             frames (one per line) of the form
//                 {"seq":<int>,"ts":<unix-ms>,"len":<int>}
//             until n frames sent at hz frames/sec, then end. Defaults
//             n=1000, hz=100. Compatible with stream-truncation-detector.mjs.
//         anything else  -> 404
//     - On SIGTERM / SIGINT: graceful close, remove port-file, exit 0.
//
//   Exit codes: 0 clean shutdown; 2 bad arg / unsupported OS; 1 fatal listen
//               error.
//
// Layer-1: node: stdlib only (http2, fs, util, os, path).

import { createServer } from 'node:http2';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

if (platform() !== 'win32') {
  process.stderr.write(`loopback-h2c-on-25h2 server: non-win32 (${platform()}) — skipped\n`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    host:        { type: 'string', default: '127.0.0.1' },
    port:        { type: 'string', default: '0' },
    'port-file': { type: 'string', default: join(tmpdir(), 'ccsm-loopback-h2c-port') },
  },
  strict: true,
});

const host = values.host;
const port = Number(values.port);
const portFile = values['port-file'];
if (!Number.isFinite(port) || port < 0 || port > 65535) {
  process.stderr.write('bad --port\n');
  process.exit(2);
}

const server = createServer();

server.on('stream', (stream, headers) => {
  const path = headers[':path'] ?? '';
  const method = headers[':method'];
  if (method === 'GET' && path === '/ping') {
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    stream.end('pong');
    return;
  }
  if (method === 'GET' && path.startsWith('/stream')) {
    const qs = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    const n  = Math.max(1, Math.min(1_000_000, Number(params.get('n')  ?? '1000') | 0));
    const hz = Math.max(1, Math.min(100_000,   Number(params.get('hz') ?? '100')  | 0));
    stream.respond({ ':status': 200, 'content-type': 'application/x-ndjson' });
    let seq = 0;
    const intervalMs = 1000 / hz;
    const tick = setInterval(() => {
      if (stream.destroyed || stream.closed) { clearInterval(tick); return; }
      const line = JSON.stringify({ seq, ts: Date.now(), len: 0 }) + '\n';
      stream.write(line);
      seq++;
      if (seq >= n) {
        clearInterval(tick);
        stream.end();
      }
    }, intervalMs);
    stream.on('close', () => clearInterval(tick));
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
    try { if (existsSync(portFile)) unlinkSync(portFile); } catch { /* ignore */ }
    process.exit(0);
  });
  // Hard timeout so a stuck client can't pin the spike.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

server.listen({ host, port }, () => {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    process.stderr.write('failed to read server address\n');
    process.exit(1);
  }
  try {
    writeFileSync(portFile, String(addr.port));
  } catch (e) {
    process.stderr.write(`failed to write port-file ${portFile}: ${e.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`listening ${addr.address}:${addr.port}\n`);
});
