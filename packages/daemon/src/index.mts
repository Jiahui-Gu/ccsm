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
import { TunnelClient } from './tunnel.mjs';
import {
  TunnelRefreshClient,
  readCredsFile,
} from './tunnel-refresh.mjs';
import { attachFrameRouter, attachWebSocket } from './ws.mjs';

const DEFAULT_PORT = 17832;
const PORT_RETRY_MAX = 20;
const SHUTDOWN_TIMEOUT_MS = 2000;
// R-53 (Task #175): production host moved from the cc-sm Pages project
// (`cc-sm.pages.dev`, deleted) to the cf-worker on the account workers.dev
// subdomain (`ccsm-worker.jiahuigu.workers.dev`). Same script now serves
// the SPA + the tunnel + the OAuth callback path on a single origin.
const DEFAULT_TUNNEL_URL = 'wss://ccsm-worker.jiahuigu.workers.dev/tunnel/default';
const TUNNEL_CONNECT_POLL_MS = 100;

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

  // Dual-listen (Task #777, S3-T4): in addition to loopback HTTP, kick off an
  // outbound WS tunnel to the Cloudflare Worker so cloud browsers can reach
  // this daemon. Tunnel init is fire-and-forget — its failure must NEVER
  // abort the loopback path. Set CCSM_TUNNEL_DISABLE=1 to skip entirely
  // (tests + offline dev). T4 only verifies link-up; real frame routing into
  // sessions lands in T6. Task #787 (S3-C) adds HTTP-over-tunnel mux: the
  // tunnel client now owns a daemonLoopbackPort so it can fetch
  // http://127.0.0.1:<port><path> on receipt of http_req control frames —
  // hence we construct it AFTER listen so we have the bound port.
  const tunnelDisabled = process.env.CCSM_TUNNEL_DISABLE === '1';
  const tunnelUrl = process.env.CCSM_TUNNEL_URL || DEFAULT_TUNNEL_URL;

  // Handshake mode: bind port 0 (ephemeral) once, no retry — caller already
  // scopes the port via OS allocation, EADDRINUSE on port 0 is "out of ports"
  // and not recoverable by ++port.
  const { port } = handshakeMode
    ? await listenOnce(http, 0)
    : await listenWithRetry(http, startPort, PORT_RETRY_MAX);

  let tunnel: TunnelClient | null = null;
  let tunnelStatePoll: ReturnType<typeof setInterval> | null = null;
  let tunnelRefresh: TunnelRefreshClient | null = null;
  if (tunnelDisabled) {
    console.error('[ccsm] tunnel: disabled (CCSM_TUNNEL_DISABLE)');
  } else {
    console.error(`[ccsm] tunnel: connecting ${tunnelUrl}`);
    // S4-T8 (Task #141): when the Tauri shell has injected CCSM_TUNNEL_JWT
    // (after the user completes device-flow login from the main UI), encode
    // the JWT as the `ccsm.<jwt>` ws subprotocol so the cf-worker can
    // authenticate the daemon side of the tunnel against its JWT signing
    // key. Absence of the env var keeps the legacy unauth dial path.
    //
    // Task #153 (R-45 audit-P0 F-T-13): the cloud-issued tunnel JWT has a
    // 24h TTL; without an in-process refresh loop the daemon's tunnel ws
    // would close hard at exp+ε. We stand up a TunnelRefreshClient that
    // schedules a refresh 1h before exp (read from the persisted creds
    // file the Tauri shell wrote). On successful refresh we stop the
    // current TunnelClient and dial a new one with the new
    // `ccsm.<newJwt>` subprotocol — same identity, fresh credential.
    let currentJwt: string | undefined =
      typeof process.env.CCSM_TUNNEL_JWT === 'string' && process.env.CCSM_TUNNEL_JWT.length > 0
        ? process.env.CCSM_TUNNEL_JWT
        : undefined;

    const startTunnel = (jwtForSubprotocol: string | undefined): TunnelClient => {
      const subprotocols =
        typeof jwtForSubprotocol === 'string' && jwtForSubprotocol.length > 0
          ? [`ccsm.${jwtForSubprotocol}`]
          : undefined;
      if (subprotocols !== undefined) {
        console.error('[ccsm] tunnel: dialing with cloud-issued JWT subprotocol');
      }
      const t = new TunnelClient({
        url: tunnelUrl,
        token,
        daemonLoopbackPort: port,
        ...(subprotocols !== undefined ? { subprotocols } : {}),
        onFrame: (data) => {
          const len = typeof data === 'string'
            ? Buffer.byteLength(data, 'utf8')
            : data.length;
          // Frames that arrive before any browser pairing (no hello+sid yet)
          // land here. Once the browser sends hello with sid, onBrowserAttach
          // takes over and routes binary frames into the per-session PTY.
          console.error(`[ccsm] tunnel: rx frame len=${len}`);
        },
        // Task #793 (S3-G): wire the paired browser ws into the runtime
        // registry's per-session fan-out. The router owns replay + subscribe
        // + INPUT/RESIZE forwarding for the rest of this connection; we tear
        // it down via the returned handle when the tunnel ws drops.
        onBrowserAttach: ({ sid, lastSeq, send }) => {
          // R-17 log #10 (Task #45): record browser-attach entry pre-routing so
          // we can diff against tunnel.mts log #8 (hello received) and the DO
          // log #2 (browser ws accepted) on the cloud side.
          console.error('[ccsm] tunnel: browser attach sid=' + sid + ' lastSeq=' + lastSeq);
          const router = attachFrameRouter({
            sid,
            lastSeq,
            registry,
            send: (data) => send(data),
          });
          if (!router.attached) {
            console.warn(`[ccsm] tunnel: attach failed sid=${JSON.stringify(sid)} (not_spawned or exited)`);
            return null;
          }
          console.error(`[ccsm] tunnel: attached sid=${sid} lastSeq=${lastSeq}`);
          return {
            onFrame: (data) => router.onFrame(data),
            onClose: () => router.close(),
          };
        },
      });
      t.start();
      return t;
    };

    tunnel = startTunnel(currentJwt);
    // TunnelClient does not emit a 'connected' event; poll state until we
    // observe the first transition (or the client is stopped). Cheap timer,
    // unref'd so it never holds the loop open. Logged once per connect.
    let lastState = tunnel.getState();
    tunnelStatePoll = setInterval(() => {
      if (tunnel === null) return;
      const s = tunnel.getState();
      if (s !== lastState) {
        if (s === 'connected') console.error('[ccsm] tunnel: connected');
        lastState = s;
      }
      if (s === 'stopped') {
        if (tunnelStatePoll !== null) {
          clearInterval(tunnelStatePoll);
          tunnelStatePoll = null;
        }
      }
    }, TUNNEL_CONNECT_POLL_MS);
    tunnelStatePoll.unref?.();

    // Task #153: bring up the refresh loop iff CCSM_TUNNEL_JWT was injected
    // (i.e. the Tauri shell did device-flow). In legacy / unauth deployments
    // there's no JWT to refresh and no creds file to consult — leave
    // tunnelRefresh null. The creds file MUST exist when the env var is set
    // (the Tauri shell writes it before spawning daemon); a missing file is
    // logged but not fatal — the existing tunnel keeps running until exp.
    if (currentJwt !== undefined) {
      void readCredsFile().then((creds) => {
        if (creds === null) {
          console.warn(
            '[ccsm/tunnel-refresh] creds file missing or malformed, refresh disabled for this run',
          );
          return;
        }
        tunnelRefresh = new TunnelRefreshClient({
          authBase: process.env.CCSM_AUTH_BASE ?? 'https://ccsm-worker.jiahuigu.workers.dev',
          creds,
          onRefreshed: (newJwt) => {
            currentJwt = newJwt;
            // Stop the existing tunnel synchronously, then dial a new one
            // with the new subprotocol. The old ws may still be mid-frame;
            // tunnel.stop() closes 1000 cleanly, the DO will see normal
            // close, and the new dial reuses the same loopback port +
            // browser routing wiring.
            console.error('[ccsm] tunnel: refreshed JWT, redialing');
            if (tunnel !== null) {
              try {
                tunnel.stop();
              } catch (err) {
                console.warn('[ccsm] tunnel.stop on refresh:', (err as Error).message);
              }
            }
            tunnel = startTunnel(newJwt);
            // The old state-poll interval still references this binding via
            // the outer `tunnel` variable, which we just reassigned — the
            // poll closure reads `tunnel` afresh each tick so it picks up
            // the new client automatically.
          },
        });
        tunnelRefresh.start();
      }).catch((err: unknown) => {
        console.warn(
          '[ccsm/tunnel-refresh] init failed:',
          (err as Error).message,
        );
      });
    }
  }

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
    // Stop the outbound tunnel first so we don't reconnect while the HTTP
    // server is closing. tunnel.stop() is synchronous + idempotent.
    if (tunnelRefresh !== null) {
      try {
        tunnelRefresh.stop();
      } catch (err) {
        console.error('[ccsm] tunnelRefresh.stop error:', err);
      }
    }
    if (tunnel !== null) {
      try {
        tunnel.stop();
      } catch (err) {
        console.error('[ccsm] tunnel.stop error:', err);
      }
    }
    if (tunnelStatePoll !== null) {
      clearInterval(tunnelStatePoll);
      tunnelStatePoll = null;
    }
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
