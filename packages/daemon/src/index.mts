// Daemon entry: parse env, pick port, mint token, start HTTP server, print URL.
// WS server + node-pty + real session lifecycle land in T4.

import { randomBytes } from 'node:crypto';

import { openDb } from './db.mjs';
import { createDaemonHttp } from './http.mjs';
import { attachWebSocket } from './ws.mjs';

const DEFAULT_PORT = 17832;
const PORT_RETRY_MAX = 20;
const SHUTDOWN_TIMEOUT_MS = 2000;

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_PORT;
  return n;
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

interface ListenResult {
  port: number;
}

async function listenWithRetry(
  http: ReturnType<typeof createDaemonHttp>,
  startPort: number,
  retries: number,
): Promise<ListenResult> {
  for (let i = 0; i <= retries; i++) {
    const port = startPort + i;
    try {
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
      return { port };
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
  const startPort = parsePort(process.env.PORT);
  const token = process.env.CCSM_TOKEN || generateToken();
  // Persistence (#667). Open the SQLite KV before wiring HTTP so the in-memory
  // sessions Map is hydrated from disk before the server starts accepting
  // requests. CCSM_DB_PATH lets tests/lifecycle scripts point at a temp file.
  const dbPath = process.env.CCSM_DB_PATH;
  const db = openDb(dbPath ? { path: dbPath } : undefined);
  const http = createDaemonHttp({ token, db });
  attachWebSocket(http.server, { token, sessions: http.sessions });

  const { port } = await listenWithRetry(http, startPort, PORT_RETRY_MAX);

  // The exact line the launcher / harness greps for. Do not change format.
  process.stdout.write(
    `ccsm ready: http://127.0.0.1:${port}/?token=${token}\n`,
  );

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
