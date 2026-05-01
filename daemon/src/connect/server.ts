// daemon/src/connect/server.ts — T05.1 Connect-RPC server scaffold for the
// daemon's data-socket. Dormant: no service handlers are registered (T06
// lands the first one); JWT verification is a placeholder (T08 lands the
// real one); storage-full predicate is a stub (T15 lands the real one).
//
// Spec citations (canonical):
//   - docs/superpowers/specs/2026-05-01-v0.4-web-design.md ch02 §1 (wire = Connect)
//   - …                                                    ch02 §6 (data socket = HTTP/2 + Connect; control socket stays envelope)
//   - …                                                    ch02 §7 (Ping handshake RPC, no native wire-version negotiation)
//   - …                                                    ch02 §8 (interceptor inheritances from v0.3; HMAC daemon.hello REPLACED)
//   - …                                                    ch05 §4 (JWT interceptor; transport-tag positive enum; fail-closed)
//   - …                                                    ch05 §5 line 3144 — chain order LOCK:
//        transport-tag → JWT → migration-gate → storage-full → deadline → trace-id → handler
//
// Single Responsibility (producer / decider / sink):
//   - This module is the WIRING: it composes pure deciders (interceptors) into
//     a Connect router and exposes a Node HTTP/2 server lifecycle. It does NOT
//     own the migration-pending flag, the storage-full flag, JWT verification,
//     or session state — all of these are caller-injected predicates / future
//     module replacements.

import * as http2 from 'node:http2';
import type { Duplex } from 'node:stream';
import {
  type ConnectRouter,
  type Interceptor,
} from '@connectrpc/connect';
import {
  connectNodeAdapter,
  universalRequestFromNodeRequest,
} from '@connectrpc/connect-node';

// Re-export context keys + helpers for downstream consumers.
export {
  transportTypeKey,
  traceIdKey,
  requestStartKey,
  resolveTransportTag,
  transportTagForLog,
} from './interceptors/context-keys.js';

// Re-export per-route message size config (T06 will use these when registering
// services with `router.service(svc, impl, { readMaxBytes })`).
export {
  DEFAULT_READ_MAX_BYTES,
  READ_MAX_BYTES_PER_ROUTE,
  readMaxBytesForRoute,
  NEAR_CAP_RATIO,
  READ_MAX_NEAR_CAP_SLOT_NAME,
  createReadMaxNearCapInterceptor,
} from './interceptors/read-max.js';

// Re-export rate-cap config + factory.
export {
  DEFAULT_MAX_REQUESTS_PER_SEC,
  RATE_CAP_SLOT_NAME,
  createRateCapInterceptor,
} from './interceptors/rate-cap.js';

// Re-export pino reject log helper for callers wiring a child pino.
export {
  logReject,
  type RejectLogger,
  type RejectLogFields,
} from './interceptors/pino-reject-log.js';

// Re-export individual interceptor factories so unit tests + future wiring
// can compose alternative chains (e.g. dev-mode chains with extra taps).
export { createTransportTagInterceptor, TRANSPORT_TAG_SLOT_NAME } from './interceptors/transport-tag.js';
export { createJwtInterceptor, JWT_SLOT_NAME } from './interceptors/jwt.js';
export { createMigrationGateInterceptor, MIGRATION_GATE_SLOT_NAME } from './interceptors/migration-gate.js';
export { createStorageFullInterceptor, STORAGE_FULL_SLOT_NAME } from './interceptors/storage-full.js';
export { createDeadlineInterceptor, DEADLINE_SLOT_NAME } from './interceptors/deadline.js';
export { createTraceIdInterceptor, TRACE_ID_SLOT_NAME } from './interceptors/trace-id.js';

import { createTransportTagInterceptor } from './interceptors/transport-tag.js';
import { createJwtInterceptor } from './interceptors/jwt.js';
import { createMigrationGateInterceptor } from './interceptors/migration-gate.js';
import { createStorageFullInterceptor } from './interceptors/storage-full.js';
import { createDeadlineInterceptor } from './interceptors/deadline.js';
import { createTraceIdInterceptor } from './interceptors/trace-id.js';
import { createRateCapInterceptor } from './interceptors/rate-cap.js';
import { createReadMaxNearCapInterceptor } from './interceptors/read-max.js';
import { transportTypeKey } from './interceptors/context-keys.js';
import type { RejectLogger } from './interceptors/pino-reject-log.js';
import { createContextValues } from '@connectrpc/connect';

// ---------------------------------------------------------------------------
// Spec-amendment / drift note for PR #752 → T05.1
// ---------------------------------------------------------------------------
//
// PR #752 (T05) shipped a `hello-gate` interceptor between `migration-gate`
// and `deadline`, motivated by ch02 §8's v0.3 inheritance row for
// `helloInterceptor`. That row, on careful re-read, says "HMAC daemon.hello
// handshake | **Replaced** by Connect TLS-or-local-trust + Cloudflare Access
// JWT for remote." (line 386). The handshake was DROPPED, not inherited:
// the local-pipe transport tag is the local trust boundary; the JWT
// interceptor is the remote trust boundary. There is no v0.4 daemon-side
// handshake message that gates RPC admission.
//
// T05.1 therefore REMOVES `hello-gate` from the chain and aligns to the
// canonical ch05 §5 lock (line 3144):
//
//   transport-tag → JWT → migration-gate → storage-full → deadline → trace-id
//
// `helloAckKey` is intentionally NOT exported any more; downstream code that
// referenced it (none in tree as of T05.1) should rely on the JWT/transport
// boundary instead. `Ping` is unconditionally accessible (no allowlist),
// matching ch02 §7 line 357 ("clients call it on connect") — the Connect
// transport itself is the handshake.
//
// The pre-accept rate cap is re-implemented BOTH at the listener layer
// (data-socket.ts MAX_ACCEPT_PER_SEC; per ch02 §8 row "Pre-accept rate cap")
// AND as a Connect interceptor here (per-RPC bucket; defends against burst
// spam on a single accepted connection). This is belt-and-suspenders; the
// listener cap is the canonical spec implementation.

// ---------------------------------------------------------------------------
// Chain assembly
// ---------------------------------------------------------------------------

export interface InterceptorChainOptions {
  readonly isMigrationPending: () => boolean;
  /**
   * Storage-full marker predicate. Defaults to `() => false` until T15 lands
   * the real SQLITE_FULL handler.
   */
  readonly isStorageFull?: () => boolean;
  /**
   * Pino logger (or compatible) for structured rejection logs. Defaults to a
   * console.warn fallback so tests + early-boot paths still surface signal.
   */
  readonly logger?: RejectLogger;
  /** Test injection. */
  readonly now?: () => number;
  /** Override the per-RPC rate cap. Defaults to {@link DEFAULT_MAX_REQUESTS_PER_SEC}. */
  readonly rateCapPerSec?: number;
}

/**
 * Build the canonical interceptor stack in the spec-locked order
 * (ch05 §5 line 3144):
 *
 *     [0] transport-tag     (ch05 §4 — positive enum tag; stamps requestStart)
 *     [1] jwt               (ch05 §4 — placeholder; T08 lands real verify)
 *     [2] migration-gate    (ch02 §8 — block data-plane during migration)
 *     [3] storage-full      (ch07 §1 — block writes when SQLITE_FULL marker set; T15 wires real predicate)
 *     [4] deadline          (ch02 §8 — placeholder; T08+ lands real reader)
 *     [5] trace-id          (ch02 §8 — ULID per request)
 *
 * Connect applies SERVER interceptors outermost-first per array order
 * (i.e. element 0 wraps element 1 wraps the handler).
 *
 * Two non-numbered observability interceptors are appended AFTER trace-id:
 *
 *     [6] rate-cap          (ch02 §8 — belt-and-suspenders for listener cap)
 *     [7] read-max-near-cap (ch02 §8 — log requests within 10% of per-route cap)
 *
 * These do not appear in ch05 §5's lock because the spec places the rate cap
 * at the listener layer and the readMaxBytes hard cap inside Connect-Node
 * native code. They are wired here so trace-id is set before they log.
 */
export function buildInterceptorChain(opts: InterceptorChainOptions): Interceptor[] {
  return [
    createTransportTagInterceptor({ now: opts.now }),
    createJwtInterceptor({ logger: opts.logger, now: opts.now }),
    createMigrationGateInterceptor({
      isMigrationPending: opts.isMigrationPending,
      logger: opts.logger,
      now: opts.now,
    }),
    createStorageFullInterceptor({
      isStorageFull: opts.isStorageFull,
      logger: opts.logger,
      now: opts.now,
    }),
    createDeadlineInterceptor(),
    createTraceIdInterceptor(),
    createRateCapInterceptor({
      maxPerSec: opts.rateCapPerSec,
      logger: opts.logger,
      now: opts.now,
    }),
    createReadMaxNearCapInterceptor({
      logger: opts.logger,
      now: opts.now,
    }),
  ];
}

/**
 * Names of the interceptor slots in declared order. Useful for tests asserting
 * the chain composition without importing every factory.
 *
 * The first 6 entries match the ch05 §5 chain-order lock; entries [6]+ are
 * the appended observability interceptors (see {@link buildInterceptorChain}).
 */
export const INTERCEPTOR_SLOT_NAMES: readonly string[] = [
  'transport-tag',
  'jwt',
  'migration-gate',
  'storage-full',
  'deadline',
  'trace-id',
  'rate-cap',
  'read-max-near-cap',
] as const;

/** First N entries == ch05 §5 canonical chain (transport-tag through trace-id). */
export const SPEC_CH05_S5_CANONICAL_ORDER: readonly string[] = [
  'transport-tag',
  'jwt',
  'migration-gate',
  'storage-full',
  'deadline',
  'trace-id',
] as const;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface CreateConnectDataServerOptions {
  /**
   * Caller registers Connect services on the router. T05.1 PR ships this with
   * an empty function (no services); T06 will land `router.service(CcsmService, {…})`
   * here, passing per-route `readMaxBytes` from {@link readMaxBytesForRoute}.
   */
  readonly registerRoutes: (router: ConnectRouter) => void;

  /** Migration-gate predicate. */
  readonly isMigrationPending: () => boolean;

  /** Storage-full predicate. Defaults to `() => false`. */
  readonly isStorageFull?: () => boolean;

  /** Structured-log sink for interceptor rejections. */
  readonly logger?: RejectLogger;

  /** Test injection. */
  readonly now?: () => number;

  /** Override per-RPC rate cap (default: 50/sec per spec). */
  readonly rateCapPerSec?: number;
}

export interface ConnectDataServer {
  /** The Node-style HTTP/2 request handler produced by `connectNodeAdapter`. */
  readonly handler: ReturnType<typeof connectNodeAdapter>;

  /**
   * Bind the Connect router to a fresh HTTP/2 server on the given address.
   * Returns the bound port (useful when `port: 0` requests an ephemeral one).
   */
  listen(opts: { host: string; port: number }): Promise<number>;

  /**
   * Hand a pre-accepted Duplex socket to the underlying HTTP/2 server. The
   * data-socket integration calls this AFTER it has peeked the HTTP/2 preface
   * on the connection. The `transportType` argument is stamped on every
   * request's `contextValues` via the adapter's `contextValues` factory so
   * the JWT interceptor can apply the local bypass.
   */
  attachSocket(socket: Duplex, transportType: 'local-pipe' | 'remote-tcp'): void;

  /** Close the HTTP/2 server (if `listen()` was called) and stop accepting new sockets. */
  close(): Promise<void>;
}

/**
 * Create a Connect-RPC server bound to the daemon data-socket surface.
 */
export function createConnectDataServer(
  opts: CreateConnectDataServerOptions,
): ConnectDataServer {
  // Per-socket transport-tag stash. The adapter's contextValues factory looks
  // up the originating socket and reads its tag. This avoids reading any
  // header (per ch05 §4 — header reads would let an attacker spoof the tag).
  const socketTags = new WeakMap<Duplex, 'local-pipe' | 'remote-tcp'>();

  const interceptors = buildInterceptorChain({
    isMigrationPending: opts.isMigrationPending,
    isStorageFull: opts.isStorageFull,
    logger: opts.logger,
    now: opts.now,
    rateCapPerSec: opts.rateCapPerSec,
  });

  const handler = connectNodeAdapter({
    routes: opts.registerRoutes,
    interceptors,
    contextValues: (req) => {
      const values = createContextValues();
      const sock = (req as unknown as { socket?: Duplex }).socket;
      const tag = sock ? socketTags.get(sock) : undefined;
      if (tag !== undefined) {
        values.set(transportTypeKey, tag);
      }
      return values;
    },
  });

  let httpServer: http2.Http2Server | undefined;

  return {
    handler,

    async listen({ host, port }: { host: string; port: number }): Promise<number> {
      if (httpServer) {
        throw new Error('Connect data server already listening');
      }
      httpServer = http2.createServer();
      httpServer.on('request', handler);
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          httpServer!.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          httpServer!.removeListener('error', onError);
          resolve();
        };
        httpServer!.once('error', onError);
        httpServer!.once('listening', onListening);
        httpServer!.listen(port, host);
      });
      const addr = httpServer.address();
      if (typeof addr === 'object' && addr !== null && 'port' in addr) {
        return addr.port;
      }
      return port;
    },

    attachSocket(socket: Duplex, transportType: 'local-pipe' | 'remote-tcp'): void {
      socketTags.set(socket, transportType);
      if (httpServer) {
        // Hand the pre-accepted socket to the HTTP/2 server. Node will run
        // the HTTP/2 preface check and dispatch streams to the 'request' handler.
        httpServer.emit('connection', socket);
      }
      // attach-before-listen: tag is stashed; future listen() will not pick
      // up the socket automatically (caller must re-attach after listen).
      // T19 wave will lock the lifecycle ordering.
    },

    async close(): Promise<void> {
      if (!httpServer) return;
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = undefined;
    },
  };
}

// Suppress unused-import warning for re-exported helper used by the eventual
// data-socket dispatch wiring.
void universalRequestFromNodeRequest;
