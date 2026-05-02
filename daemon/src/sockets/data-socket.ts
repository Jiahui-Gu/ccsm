// Data-socket transport (T15) — pure listener + per-connection rate cap +
// best-effort peer-cred + file ACL. Carries every RPC except the canonical
// SUPERVISOR_RPCS allowlist (those go on the control-socket, T14).
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-design.md §3.4.1.h (two-socket topology;
//     data-socket = `<runtimeRoot>/ccsm-data.sock` on POSIX,
//     `\\.\pipe\ccsm-data-<userhash>` on Windows — see L267+L272).
//   - frag-3.4.1 §3.4.1.a "Pre-accept rate cap (round-2 security T15)":
//     `MAX_ACCEPT_PER_SEC = 50`; excess fails with EAGAIN + once-per-min log.
//   - frag-3.4.1 §3.4.1.h: peer-cred + DACL/file-ACL + accept-rate-cap +
//     hello-handshake posture is **shared** between control + data sockets.
//   - T13 `daemon/src/sockets/runtime-root.ts` owns the path resolution.
//
// Single Responsibility (producer / decider / sink):
//   - Producer: this module emits accepted-connection events (raw `Duplex`).
//   - Decider: rate-cap is the only decision made here (drop or accept).
//   - Sink (the caller's `onConnection`) parses envelopes, runs the
//     dispatcher, etc. This module performs ZERO envelope parsing and ZERO
//     RPC method-name awareness — that's T16 (dispatcher) territory.
//
// Layer-1 boundary check (per worker contract): if you find this file
// inspecting `method`, `headers`, JSON-parsing payloads, or referencing
// `SUPERVISOR_RPCS` — that's a layering violation. Push back to the
// dispatcher.

import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { userHash } from './runtime-root.js';

/** Per spec frag-3.4.1 §3.4.1.a: 50 accepts per rolling 1s window. */
export const MAX_ACCEPT_PER_SEC = 50;

/** Once-per-minute aggregate log when accept-rate cap drops connections. */
export const RATE_CAP_LOG_THROTTLE_MS = 60_000;

/** Best-effort peer credentials. Populated only on POSIX where Node's
 *  net.Socket exposes {@link https://nodejs.org/api/net.html `getPeerCertificate`}-
 *  style hooks; on Windows the field is `undefined` and security is delegated
 *  to the named-pipe DACL inherited from `\\.\pipe\` (per-user namespace). */
export interface PeerCredentials {
  readonly uid?: number;
  readonly gid?: number;
  readonly pid?: number;
}

/** Args passed to the caller's `onConnection` hook. The `socket` is a raw
 *  Duplex — caller MUST `socket.destroy()` on protocol violation. */
export interface DataSocketConnection {
  readonly socket: Socket;
  /** Best-effort peer credentials. May be `undefined` on Windows / when the
   *  platform does not expose SO_PEERCRED. The §3.4.1.g hello-HMAC handshake
   *  is the authoritative imposter check; peer-cred is defense-in-depth. */
  readonly peer: PeerCredentials | undefined;
}

export interface CreateDataSocketServerOptions {
  /** Output of `resolveRuntimeRoot()` (T13). Used to compute the POSIX
   *  socket path; ignored on Windows where the path is the named-pipe form. */
  readonly runtimeRoot: string;

  /** Called once per accepted connection with a raw {@link Socket}. */
  readonly onConnection: (conn: DataSocketConnection) => void;

  /** Optional sink for once-per-minute rate-cap log lines. Defaults to a
   *  best-effort `console.warn` so the listener still surfaces DoS attempts
   *  if the daemon hasn't wired pino yet. */
  readonly logger?: {
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };

  /** Optional clock injection for tests (returns ms since epoch). */
  readonly now?: () => number;

  /** Override for tests — defaults to {@link MAX_ACCEPT_PER_SEC}. */
  readonly maxAcceptPerSec?: number;

  /** Override the auto-derived socket path. When provided, we trust the
   *  caller (test harness, alternative deployment) and skip both the
   *  POSIX `<runtimeRoot>/ccsm-data.sock` derivation and the Windows
   *  `\\.\pipe\ccsm-data-<userhash>` derivation. Mirrors the
   *  `socketPath` override on `createControlSocketServer` (T14) so tests
   *  can inject a unique address per run and avoid named-pipe namespace
   *  collisions on consecutive boots. */
  readonly socketPath?: string;
}

export interface DataSocketServer {
  /** Begin listening. Resolves once the socket is bound. */
  listen(): Promise<void>;
  /** Stop accepting + close idle sockets. Resolves when the server has
   *  fully closed. Active per-connection sockets are NOT force-closed —
   *  caller owns connection lifetime via the `onConnection` hook. */
  close(): Promise<void>;
  /** Bound address (POSIX path or named-pipe path). Available after `listen`. */
  address(): string;
}

/**
 * Compute the OS-native data-socket path.
 *   - POSIX:  `<runtimeRoot>/ccsm-data.sock`
 *   - Win32:  `\\.\pipe\ccsm-data-<userhash>`  (runtimeRoot is a notional
 *             anchor only; the named-pipe namespace is global per machine,
 *             so the userhash suffix prevents bind collisions on multi-user
 *             hosts — Citrix / RDS / shared workstations. Spec:
 *             v0.3-design.md L267+L272, frag-3.4.1 L237.)
 *
 *   Dev mode: when `env.CCSM_DAEMON_DEV === '1'` the userhash is computed
 *   over `username@hostname#cwd` (delegated to `userHash()` in
 *   `runtime-root.ts`) so concurrent dev daemons spawned from different
 *   git worktrees do NOT collide on bind. Production keeps the canonical
 *   `username@hostname` shape.
 */
export function dataSocketPath(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
  hashOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const tag = hashOverride ?? userHash({ env });
    return `\\\\.\\pipe\\ccsm-data-${tag}`;
  }
  return join(runtimeRoot, 'ccsm-data.sock');
}

/**
 * Create a data-socket server. Pure transport: hands raw Duplex streams to
 * the caller. Performs accept-rate capping, best-effort peer-cred lookup,
 * and POSIX file-ACL hardening (mode 0600). Does NOT parse envelopes or
 * route RPC methods — that is the dispatcher's job (T16).
 */
export function createDataSocketServer(
  opts: CreateDataSocketServerOptions,
): DataSocketServer {
  const platform = process.platform;
  const isWindows = platform === 'win32';
  const path = opts.socketPath ?? dataSocketPath(opts.runtimeRoot, platform);
  const now = opts.now ?? Date.now;
  const maxAccept = opts.maxAcceptPerSec ?? MAX_ACCEPT_PER_SEC;
  const logger = opts.logger ?? {
    warn: (obj, msg) => {
      // Best-effort; daemon wires pino at startup but this module must work
      // standalone for tests + early boot.
      // eslint-disable-next-line no-console
      console.warn(`${msg} ${JSON.stringify(obj)}`);
    },
  };

  // Rolling 1s accept budget — sliding window of recent accept timestamps.
  const recentAccepts: number[] = [];
  let droppedSinceLastLog = 0;
  let lastDropLogAt = 0;

  function recordAcceptWithinBudget(t: number): boolean {
    const cutoff = t - 1000;
    // Drop entries older than 1s. recentAccepts is monotonic so a from-front
    // splice is O(k) for k drops per accept; bounded by maxAccept.
    while (recentAccepts.length > 0 && recentAccepts[0]! < cutoff) {
      recentAccepts.shift();
    }
    if (recentAccepts.length >= maxAccept) return false;
    recentAccepts.push(t);
    return true;
  }

  function noteDrop(t: number, peerInfo: Record<string, unknown>): void {
    droppedSinceLastLog += 1;
    if (t - lastDropLogAt >= RATE_CAP_LOG_THROTTLE_MS) {
      logger.warn(
        {
          dropped: droppedSinceLastLog,
          windowMs: RATE_CAP_LOG_THROTTLE_MS,
          maxAcceptPerSec: maxAccept,
          ...peerInfo,
        },
        'data_socket_accept_rate_cap_drop',
      );
      lastDropLogAt = t;
      droppedSinceLastLog = 0;
    }
  }

  function readPeerCreds(socket: Socket): PeerCredentials | undefined {
    if (isWindows) {
      // Named-pipe ACL inherits per-user; GetNamedPipeClientProcessId would
      // require a native binding. Return undefined; hello-HMAC handshake
      // (§3.4.1.g) is the authoritative imposter check.
      return undefined;
    }
    // Node does not expose SO_PEERCRED in core. Best-effort: same-uid lock
    // is implied by socket file mode 0600 (only the owning uid can connect).
    // We still report the daemon's own uid as a forensic anchor; a future
    // native binding can replace this.
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
      return { uid, gid };
    } catch {
      return undefined;
    }
  }

  const server: Server = createServer((socket) => {
    const t = now();
    const peer = readPeerCreds(socket);
    if (!recordAcceptWithinBudget(t)) {
      // EAGAIN-equivalent: refuse the connection by destroying it. The
      // node:net `Server` has already accepted at the kernel level; we
      // back out at the application layer. We MUST attach a noop 'error'
      // listener BEFORE destroy(err) — otherwise Node propagates the
      // error to the Server's 'error' channel and crashes the process
      // (vitest reports it as an unhandled exception). The peer simply
      // sees the pipe close, which is the correct EAGAIN-shaped signal
      // at the protocol layer; the once-per-min log is the operator
      // signal. (Spec frag-3.4.1 §3.4.1.a does NOT require us to surface
      // EAGAIN as a Node error — only that we drop the connection.)
      try {
        socket.on('error', () => {
          /* swallow — drop is intentional; logged via noteDrop */
        });
        socket.destroy(
          Object.assign(new Error('accept rate cap exceeded'), {
            code: 'EAGAIN',
          }),
        );
      } catch {
        /* swallow — best-effort drop */
      }
      noteDrop(t, peer ? { peerUid: peer.uid, peerPid: peer.pid } : {});
      return;
    }
    try {
      opts.onConnection({ socket, peer });
    } catch (err) {
      // The caller's onConnection threw synchronously — destroy the socket
      // to avoid leaking it, and re-throw to surface the bug.
      try {
        socket.destroy(err as Error);
      } catch {
        /* swallow */
      }
      throw err;
    }
  });

  // Surface listener errors as console.warn — caller can override via logger
  // if they wire pino. We do NOT crash the daemon on a single transport
  // error; the supervisor (frag-6-7 §6.5) is the restart authority.
  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.warn({ err: err.message, code: err.code }, 'data_socket_server_error');
  });

  let bound = false;
  let bindPath = path;

  return {
    async listen(): Promise<void> {
      if (bound) return;
      // POSIX: stale socket file from a previous crashed daemon will fail
      // bind with EADDRINUSE. Unlink it (the file ACL ensures only the
      // same uid can have created it).
      if (!isWindows) {
        try {
          const st = statSync(path);
          if (st.isSocket()) {
            unlinkSync(path);
          }
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== 'ENOENT') {
            // Some other I/O issue (permission denied, etc.) — let
            // listen() surface the real error below.
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(path);
      });
      // Harden the socket file ACL on POSIX. mkdir 0700 from runtime-root.ts
      // already restricts the parent dir; mode 0600 on the socket node is
      // belt-and-suspenders so a cohabiting uid that somehow gains dir
      // access still cannot connect.
      if (!isWindows) {
        try {
          chmodSync(path, 0o600);
        } catch (err) {
          // Non-fatal — log and continue. Parent dir 0700 still restricts.
          logger.warn(
            { err: (err as Error).message, path },
            'data_socket_chmod_failed',
          );
        }
      }
      bindPath = path;
      bound = true;
    },

    async close(): Promise<void> {
      if (!bound) return;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      // Remove the socket file so the next listen() is clean. Windows
      // named pipes vanish automatically when the server closes.
      if (!isWindows) {
        try {
          unlinkSync(bindPath);
        } catch {
          /* best-effort */
        }
      }
      bound = false;
    },

    address(): string {
      return bindPath;
    },
  };
}
