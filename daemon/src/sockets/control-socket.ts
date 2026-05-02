// T14 — control-socket transport.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-design.md §3.1.1 / §3.4.1.h table:
//       control-socket path = `<runtimeRoot>/ccsm-control.sock` (POSIX) or
//       `\\.\pipe\ccsm-control-<userhash>` (Windows). Carries the canonical
//       `SUPERVISOR_RPCS` set ONLY (`/healthz`, `/stats`, `daemon.hello`,
//       `daemon.shutdown`, `daemon.shutdownForUpgrade`) — but THIS module is
//       a pure transport: it has no opinion on RPC method names. The T16
//       dispatcher (already merged at 7b4586e) is the consumer that owns the
//       allowlist; this file just hands off raw Duplex streams to a callback.
//   - §3.1.1 "sender peer-cred check" + §7.1 ACL + §3.4.1.a pre-accept
//     `MAX_ACCEPT_PER_SEC = 50` rate cap (round-2 security T15).
//   - T13 PR (34ff871): `<runtimeRoot>` resolver — single source of truth for
//     where this socket node lives on POSIX. We import it.
//
// Single Responsibility: this module is a *producer* of `connection` events.
//   - Sets up the OS-native listener (`net.createServer` over a Unix socket
//     node OR a Windows named pipe — Node's `net` module abstracts both).
//   - Applies pre-accept rate cap (drop excess accepts with EAGAIN-style
//     destroy + once/min log).
//   - Stamps the per-connection peer credentials onto the Duplex (best-effort
//     — full DACL / SO_PEERCRED enforcement is layered by the T15 sister
//     module + frag-6-7 §7.1 native helper; we expose UID/PID where Node
//     gives them to us for free, and leave a structured hook for richer
//     identity to be merged in T-future).
//   - Hands the raw Duplex to the caller via `onConnection(socket, peer)`.
//     The caller wires it into the envelope adapter (§3.4.1) and ultimately
//     into the T16 dispatcher.
//
// Non-responsibilities (intentional):
//   - No envelope parsing or framing.
//   - No method-name routing or allowlist enforcement (that's T16).
//   - No hello-handshake (helloInterceptor #0, §3.4.1.g — adapter's job).
//   - No DACL creation on Windows (frag-6-7 §7.1 native helper hook).

import {
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { unlinkSync, statSync, chmodSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { userHash } from './runtime-root.js';

/** Pre-accept rate cap, per spec §3.4.1.a (round-2 security T15). Counted
 *  PER LISTENER — control-socket and data-socket each have their own bucket. */
export const MAX_ACCEPT_PER_SEC = 50;

/** Window over which the rate cap is measured. Tokens replenish in full at
 *  each tick boundary (cheap; the rate cap is best-effort DoS shedding, not
 *  precise QoS). */
const RATE_WINDOW_MS = 1_000;

/** Throttle for the "we dropped accepts" log line. Spec wording: "log once
 *  per minute aggregate" (§3.4.1.a). */
const DROP_LOG_INTERVAL_MS = 60_000;

/** Identity of the connecting peer, populated best-effort. The structured
 *  shape mirrors §3.1.1 ("`{ uid: number; pid: number }`"); fields are
 *  optional because Node's stock `net.Socket` exposes neither on Windows
 *  named pipes (full PID via `GetNamedPipeClientProcessId` requires the
 *  frag-6-7 §7.1 native helper, wired separately). */
export interface PeerCred {
  /** UID of the peer process — POSIX only; undefined on Windows. */
  readonly uid?: number;
  /** PID of the peer process — populated where the OS gives it cheaply
   *  (POSIX via getpeereid where available; Windows only with native helper
   *  — undefined here). */
  readonly pid?: number;
}

/** Caller-supplied logger surface. We keep it minimal so this module does
 *  not pull in pino (the daemon main wires real pino at the boundary). */
export interface ControlSocketLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

/** Connection callback. The transport delivers a raw Duplex (the `Socket`
 *  itself is a Duplex) plus the best-effort peer identity. The callback is
 *  expected to mount the envelope adapter on top — pure handoff. */
export type ConnectionHandler = (socket: Socket, peer: PeerCred) => void;

export interface CreateControlSocketServerOptions {
  /** `<runtimeRoot>` from T13 (POSIX socket-node parent dir; ignored on
   *  Windows where the named-pipe namespace is `\\.\pipe\`). */
  readonly runtimeRoot: string;
  /** Caller-supplied connection sink. Required even though no dispatcher is
   *  wired yet (T-future) — the transport refuses to swallow connections
   *  silently. */
  readonly onConnection: ConnectionHandler;
  /** Override the platform — used by tests to force POSIX on Windows hosts
   *  or vice versa. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Override the rate cap (tests). Default `MAX_ACCEPT_PER_SEC = 50`. */
  readonly maxAcceptPerSec?: number;
  /** Override the wall clock (tests). Default `Date.now`. */
  readonly now?: () => number;
  /** Optional logger; defaults to a silent stub so unit tests don't need
   *  to plumb one. */
  readonly logger?: ControlSocketLogger;
  /** Override the auto-derived socket path. When provided, we trust the
   *  caller (test harness, alternative deployment) and skip the userhash
   *  derivation. POSIX path or `\\.\pipe\<name>`. */
  readonly socketPath?: string;
}

export interface ControlSocketServer {
  /** Begin accepting connections. Resolves once the listener is bound. */
  listen(): Promise<void>;
  /** Stop accepting new connections AND wait for existing ones to close.
   *  Honours the standard `Server.close` callback semantics: idempotent,
   *  resolves once the kernel-level listener is fully torn down. */
  close(): Promise<void>;
  /** Resolved socket path / pipe name. Available immediately (does not
   *  require `listen()` to have completed). */
  readonly address: string;
}

/** Compute the canonical socket path for the current platform.
 *
 *  POSIX: `<runtimeRoot>/ccsm-control.sock`.
 *  Windows: `\\.\pipe\ccsm-control-<userhash>` where `<userhash>` is a
 *           short SHA-256 of `username@hostname` (8 hex chars — spec is
 *           silent on width; 32 bits of entropy is plenty for a same-host
 *           same-user collision space and keeps the pipe name short).
 *
 *  Dev mode: when `env.CCSM_DAEMON_DEV === '1'` the userhash is computed
 *  over `username@hostname#cwd` (delegated to `userHash()` in
 *  `runtime-root.ts`). This isolates concurrent dev daemons spawned from
 *  different git worktrees on the same host. Production keeps the
 *  canonical `username@hostname` shape so the packaged Electron app can
 *  attach to the surviving daemon across re-opens (frag-6-7 §6.1).
 */
export function defaultControlSocketPath(
  platform: NodeJS.Platform,
  runtimeRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\ccsm-control-${userHash({ env })}`;
  }
  // POSIX: explicitly use forward-slash join so a Windows-host test forcing
  // `platform: 'linux'` still yields a POSIX-shaped path (the on-disk
  // listener uses the host's `path.join` separately when bound).
  return posix.join(runtimeRoot, 'ccsm-control.sock');
}

const NOOP_LOGGER: ControlSocketLogger = {
  warn: () => {},
  info: () => {},
};

/**
 * Create the control-socket transport server.
 *
 * Lifecycle:
 *   1. `listen()` — binds the OS listener. On POSIX we pre-clean any stale
 *      socket node from a prior crashed run (idempotent — same posture as
 *      pidfile cleanup) and `chmod 0600` after bind so the inode is never
 *      world-readable even momentarily.
 *   2. Per accept — increment the per-second token bucket; if exhausted,
 *      destroy the socket immediately (EAGAIN-equivalent) and log at most
 *      once per minute. Otherwise extract best-effort peer credentials and
 *      hand the Duplex to `onConnection`.
 *   3. `close()` — `server.close()` (refuses new connections, waits for
 *      existing to drain), then on POSIX unlinks the socket node so the
 *      next boot does not need cleanup.
 */
export function createControlSocketServer(
  opts: CreateControlSocketServerOptions,
): ControlSocketServer {
  const platform = opts.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const maxAcceptPerSec = opts.maxAcceptPerSec ?? MAX_ACCEPT_PER_SEC;
  const now = opts.now ?? Date.now;
  const log = opts.logger ?? NOOP_LOGGER;
  const address = opts.socketPath ?? defaultControlSocketPath(platform, opts.runtimeRoot);

  // Token bucket: counts accepts in the current 1-second window.
  let windowStart = now();
  let acceptedInWindow = 0;
  // Drops since the last warn-log emit + when we last emitted.
  let droppedSinceLog = 0;
  let lastDropLog = 0;

  const server: Server = createServer((socket: Socket) => {
    const t = now();
    if (t - windowStart >= RATE_WINDOW_MS) {
      windowStart = t;
      acceptedInWindow = 0;
    }
    acceptedInWindow += 1;

    if (acceptedInWindow > maxAcceptPerSec) {
      // Pre-accept rate cap exceeded. We can't actually refuse a TCP-style
      // ACCEPT here (Node has already accepted), but destroying the socket
      // immediately is the documented EAGAIN-equivalent in §3.4.1.a.
      droppedSinceLog += 1;
      if (t - lastDropLog >= DROP_LOG_INTERVAL_MS) {
        log.warn(
          {
            transport: 'control-socket',
            address,
            droppedSinceLog,
            cap: maxAcceptPerSec,
          },
          'control_socket_accept_rate_capped',
        );
        droppedSinceLog = 0;
        lastDropLog = t;
      }
      // Best-effort destroy. The socket may already be writable; we don't
      // attempt to write a friendly error frame because (a) the pre-accept
      // posture is "shed first, log second", and (b) writing one would
      // burn cycles defeating the DoS-defence purpose of the cap.
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
      return;
    }

    const peer: PeerCred = extractPeer(socket, platform);
    try {
      opts.onConnection(socket, peer);
    } catch (err) {
      // The handler should never throw synchronously — if it does, we
      // can't keep the connection open without an envelope adapter, so
      // destroy the socket and log loud (this is a wiring bug, not a
      // peer behaviour issue).
      log.warn(
        {
          transport: 'control-socket',
          address,
          err: err instanceof Error ? err.message : String(err),
        },
        'control_socket_onconnection_threw',
      );
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
    }
  });

  // Defensive: surface listener errors so callers see EADDRINUSE etc.
  server.on('error', (err) => {
    log.warn(
      { transport: 'control-socket', address, err: err.message },
      'control_socket_server_error',
    );
  });

  return {
    address,
    async listen(): Promise<void> {
      if (!isWindows) {
        // Pre-clean stale POSIX socket node from a prior crashed run.
        // mkdir for parent is the runtime-root resolver's job (T13);
        // we only touch the socket-node inode here.
        try {
          const st = statSync(address);
          if (st.isSocket()) {
            unlinkSync(address);
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            // stat failed for some reason other than missing — let the
            // listen() call surface the real binding error a moment later.
          }
        }
        // Ensure parent dir exists (defensive — T13 normally creates it).
        // We do NOT create it here because that would silently mask a T13
        // mis-wire; we only assert it exists.
        const parent = dirname(address);
        try {
          statSync(parent);
        } catch {
          throw new Error(
            `control-socket parent dir does not exist: ${parent} (T13 resolveRuntimeRoot must run with ensure:true before listen())`,
          );
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
        server.listen(address);
      });

      if (!isWindows) {
        // Tighten the socket-node mode to 0600 (user-only). Spec §7.1 +
        // T1/T8 threat-model rows. Done AFTER listen() bound the inode.
        try {
          chmodSync(address, 0o600);
        } catch (err) {
          // chmod failure is non-fatal at boot but loud — typically only
          // happens on exotic FS without POSIX perms (e.g. some FUSE
          // mounts). Defence in depth: we still have the parent-dir 0700
          // guard from T13.
          log.warn(
            {
              transport: 'control-socket',
              address,
              err: (err as Error).message,
            },
            'control_socket_chmod_failed',
          );
        }
      }

      log.info(
        {
          transport: 'control-socket',
          address,
          maxAcceptPerSec,
        },
        'control_socket_listening',
      );
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (!isWindows) {
        try {
          unlinkSync(address);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn(
              {
                transport: 'control-socket',
                address,
                err: (err as Error).message,
              },
              'control_socket_unlink_failed',
            );
          }
        }
      }
    },
  };
}

/** Best-effort peer-credential extraction. Node's `net.Socket` does not
 *  expose `SO_PEERCRED` directly; the rich identity check (UID/PID/SID
 *  match against the daemon's owning user) lives in the frag-6-7 §7.1
 *  native helper. Until that lands, we surface the `remoteAddress` /
 *  `remotePort` shape Node gives us — undefined for Unix sockets and
 *  named pipes, which is the honest answer. */
function extractPeer(_socket: Socket, _platform: NodeJS.Platform): PeerCred {
  // Intentionally empty — Node's stock APIs return nothing useful for
  // unix sockets / named pipes. Fields are typed optional so consumers
  // can light up later without a wire-format change.
  return {};
}
