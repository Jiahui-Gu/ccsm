// Daemon entry: parse env, pick port, mint token, start HTTP server, print URL.
// WS server + node-pty + real session lifecycle land in T4.
//
// Task #683 (wave-2 T1): when launched with `--handshake-stdout`, the daemon:
//   1. listens on port 0 (OS-assigned ephemeral) instead of DEFAULT_PORT;
//   2. mints a 16-byte hex token (unless CCSM_TOKEN is set);
//   3. emits a single line of JSON to stdout:
//      `{"ready":true,"port":<n>,"token":"<hex>"}\n`
//      and writes nothing else to stdout for the rest of the process lifetime.
//
// Without the flag, behaviour is unchanged: fixed DEFAULT_PORT (with EADDRINUSE
// retry), legacy `ccsm ready: http://...` line on stdout, base64url token from
// 32 bytes (back-compat with wave-1 launcher / e2e harness which greps that
// exact line shape).
//
// The whole daemon already routes its diagnostics through console.error /
// console.warn (greppable: `console.log` returns no hits in src/). This is
// intentional — stdout is reserved for the protocol contract above. New
// diagnostics MUST use console.error / console.warn so the handshake parser
// on the parent side never sees interleaved log noise.

import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { openDb } from './db.mjs';
import { createDaemonHttp } from './http.mjs';
import { createRuntimeRegistry } from './runtime.mjs';
import { attachWebSocket } from './ws.mjs';

const DEFAULT_PORT = 17832;
const PORT_RETRY_MAX = 20;
const SHUTDOWN_TIMEOUT_MS = 2000;

const HANDSHAKE_FLAG = '--handshake-stdout';

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_PORT;
  return n;
}

function generateLegacyToken(): string {
  // Back-compat token (32 bytes base64url, ~43 chars). Used by the wave-1
  // launcher / harness greps. Kept for the !handshake path to avoid breaking
  // unrelated downstream tooling that may have hard-coded URL shape.
  return randomBytes(32).toString('base64url');
}

function generateHandshakeToken(): string {
  // Wave-2 spec: 16-byte hex (32 chars). Tighter, easier to emit/parse from
  // the Rust side of the Tauri shell.
  return randomBytes(16).toString('hex');
}

interface ListenResult {
  port: number;
}

async function listenOnce(
  http: ReturnType<typeof createDaemonHttp>,
  port: number,
): Promise<ListenResult> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      http.server.removeListener('listening', onListening);
      rejectListen(err);
    };
    const onListening = (): void => {
      http.server.removeListener('error', onError);
      resolveListen();
    };
    http.server.once('error', onError);
    http.server.once('listening', onListening);
    http.server.listen(port, '127.0.0.1');
  });
  // address() is non-null after 'listening' on a TCP server.
  const addr = http.server.address() as AddressInfo;
  return { port: addr.port };
}

async function listenWithRetry(
  http: ReturnType<typeof createDaemonHttp>,
  startPort: number,
  retries: number,
): Promise<ListenResult> {
  for (let i = 0; i <= retries; i++) {
    const port = startPort + i;
    try {
      return await listenOnce(http, port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw err;
      // Try next port.
    }
  }
  throw new Error(
    `failed to bind any port in [${startPort}, ${startPort + retries}]`,
  );
}

async function main(): Promise<void> {
  const handshakeMode = process.argv.includes(HANDSHAKE_FLAG);
  const startPort = parsePort(process.env.PORT);
  const token =
    process.env.CCSM_TOKEN ||
    (handshakeMode ? generateHandshakeToken() : generateLegacyToken());
  // Persistence (#667). Open the SQLite KV before wiring HTTP so the in-memory
  // sessions Map is hydrated from disk before the server starts accepting
  // requests. CCSM_DB_PATH lets tests/lifecycle scripts point at a temp file.
  const dbPath = process.env.CCSM_DB_PATH;
  const db = openDb(dbPath ? { path: dbPath } : undefined);
  // T#668: HTTP needs the spawn registry, and the registry needs the sessions
  // Map that createDaemonHttp owns. We break the cycle by creating http
  // first, then the registry, then attaching it to http via setRegistry().
  const http = createDaemonHttp({ token, db });
  const registry = createRuntimeRegistry({ sessions: http.sessions });
  http.setRegistry(registry);
  attachWebSocket(http.server, { token, sessions: http.sessions, registry });

  // Handshake mode: bind port 0 (ephemeral) once, no retry — caller already
  // scopes the port via OS allocation, EADDRINUSE on port 0 is "out of ports"
  // and not recoverable by ++port.
  const { port } = handshakeMode
    ? await listenOnce(http, 0)
    : await listenWithRetry(http, startPort, PORT_RETRY_MAX);

  if (handshakeMode) {
    // Single-line JSON, no other stdout writes for the rest of the process.
    // Object key order is part of the contract checked by the unit test +
    // by the Rust BufReader in T8 (it does `serde_json::from_str` which is
    // order-insensitive, but humans grep this so we keep it stable).
    const payload = JSON.stringify({ ready: true, port, token });
    process.stdout.write(`${payload}\n`);
  } else {
    // The exact line the wave-1 launcher / harness greps for. Do not change
    // format without bumping the consumers.
    process.stdout.write(
      `ccsm ready: http://127.0.0.1:${port}/?token=${token}\n`,
    );
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[ccsm] received ${signal}, shutting down`);
    // Synchronously flush any pending sessions write BEFORE we close the
    // db handle. flushNow() also clears the debounce timer so the event
    // loop has nothing left holding it open.
    try {
      http.persist?.flushNow();
    } catch (err) {
      console.error('[ccsm] flushNow error:', err);
    }
    const timer = setTimeout(() => {
      console.error('[ccsm] shutdown timeout, forcing exit');
      try {
        db.close();
      } catch {
        // ignore — we're force-exiting anyway
      }
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    http.server.close((err) => {
      if (err) console.error('[ccsm] server.close error:', err);
      clearTimeout(timer);
      try {
        db.close();
      } catch (closeErr) {
        console.error('[ccsm] db.close error:', closeErr);
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // beforeExit fires when the event loop drains naturally (e.g. tests, or
  // an unforeseen graceful unwind). Best-effort flush so we don't lose the
  // last debounce window's worth of mutations.
  process.on('beforeExit', () => {
    try {
      http.persist?.flushNow();
    } catch {
      // ignore — already shutting down
    }
  });
}

main().catch((err) => {
  console.error('[ccsm] fatal:', err);
  process.exit(1);
});
