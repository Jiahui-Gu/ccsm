// electron/daemonClient/connectClient.ts
//
// Electron-side Connect-RPC client over the daemon's "Listener A" data
// plane (Task #103, frag-3.5.1 §3.5.1.3 + frag-3.7 §3.7.4 + final-arch §2.4).
//
// Replaces the envelope `rpcClient.ts` semantically for the data plane
// (Listener A: POSIX UDS `<runtimeDir>/ccsm-daemon-data.sock`, Win named
// pipe `\\.\pipe\ccsm-daemon-data-<sid>`). The control plane (supervisor
// channel) stays on the envelope per ch02 §6 (data-socket Connect, control
// envelope) — call sites flip in #105 / #106 / #108; the envelope
// `rpcClient` is removed by #115.
//
// Spec citations:
//   - frag-3.5.1 §3.5.1.3 — bridge call timeout, AbortSignal.any, deadline
//     header, BridgeTimeoutError, handler.leaked.count, no-floating-cancellation
//     ESLint rule.
//   - frag-3.7   §3.7.4    — auto-reconnect schedule (exponential w/ ±25 %
//     jitter, capped 5s) + bounded reconnect queue (100 prod / 1000 dev) +
//     queue overflow rejects oldest.
//   - frag-3.7   §3.7.5    — stream resubscription on reconnect (the bridge
//     fires `onReconnected` so subscribers can re-attach; this module does
//     NOT itself re-subscribe).
//   - frag-6-7   §6.8      — surface registry slots (`reconnecting`,
//     `reconnected`); BridgeTimeoutError NEVER user-surfaced.
//   - daemon/src/listeners/listenerA.ts — path resolver (mirrored here).
//
// Single Responsibility:
//   - PRODUCER: socket lifecycle (connect / disconnect events).
//   - DECIDER: backoff schedule + queue cap + per-call timeout + abort
//     merge are all pure deciders living in helper modules
//     (`reconnectQueue.ts`, `bridgeTimeout.ts`).
//   - SINK: `defaultDaemonSurfaceRegistry.set(...)` is the published
//     status sink; `Promise.resolve / reject` of the per-call promise is
//     the data sink.
//
// What this module does NOT do (per task brief):
//   - It does NOT register call sites (those flip in #105 / #106 / #108).
//   - It does NOT delete envelope `rpcClient.ts` (#115 owns cleanup).
//   - It does NOT own the `daemon.hello` handshake (T08 lands the real
//     JWT path; pre-handshake allowlist already enforced server-side).

import * as http2 from 'node:http2';
import * as net from 'node:net';
import { posix as posixPath } from 'node:path';
import { ulid } from 'ulid';
import {
  Code,
  ConnectError,
  type CallOptions,
  type Transport,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import {
  BridgeTimeoutError,
  anyAbortSignal,
  createTimeoutMap,
  type TimeoutMap,
} from './bridgeTimeout';
import {
  createReconnectQueue,
  QUEUE_OVERFLOW_MESSAGE,
  type ReconnectQueue,
} from './reconnectQueue';
import {
  defaultDaemonSurfaceRegistry,
  type DaemonSurfaceRegistry,
} from './surfaceRegistry';

// ---------------------------------------------------------------------------
// Listener A path resolver — mirrors `daemon/src/listeners/listenerA.ts`
// ---------------------------------------------------------------------------

/** Mirrors `LISTENER_A_BASENAME` in daemon/src/listeners/listenerA.ts. */
export const LISTENER_A_BASENAME = 'ccsm-daemon-data' as const;
export const LISTENER_A_POSIX_FILENAME = `${LISTENER_A_BASENAME}.sock` as const;
export const LISTENER_A_WIN_PIPE_PREFIX = `\\\\.\\pipe\\${LISTENER_A_BASENAME}-` as const;

export interface ResolveListenerAPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly runtimeDir?: string;
  readonly sid?: string;
}

/**
 * Resolve the Listener A endpoint path. MUST stay byte-for-byte
 * compatible with `daemon/src/listeners/listenerA.ts:resolveListenerAPath`
 * — drift breaks the local-IPC handshake.
 *
 * We duplicate rather than import because the daemon module is ESM
 * (.js suffix imports) and the Electron main bundle is CommonJS via
 * tsconfig.electron.json — pulling in the daemon module would force
 * either a `--moduleResolution` flip or a build-time copy step. Both
 * are out of scope for #103.
 */
export function resolveListenerAPath(opts: ResolveListenerAPathOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    if (typeof opts.sid !== 'string' || opts.sid.length === 0) {
      throw new Error(
        'resolveListenerAPath: win32 requires { sid: string }. ' +
          'Cache the daemon SID at boot via the ccsm_native shim and pass it here.',
      );
    }
    return `${LISTENER_A_WIN_PIPE_PREFIX}${opts.sid}`;
  }
  if (typeof opts.runtimeDir !== 'string' || opts.runtimeDir.length === 0) {
    throw new Error(
      `resolveListenerAPath: ${platform} requires { runtimeDir: string }.`,
    );
  }
  return posixPath.join(opts.runtimeDir, LISTENER_A_POSIX_FILENAME);
}

// ---------------------------------------------------------------------------
// Backoff schedule (frag-3.7 §3.7.4)
// ---------------------------------------------------------------------------

/** Base delays in ms (no jitter). Index = attempt-1; clamp to last. */
export const RECONNECT_BASE_DELAYS_MS: readonly number[] = [
  200, 400, 800, 1600, 3200, 5000,
] as const;

/** Cap for any attempt past the last entry. */
export const RECONNECT_MAX_DELAY_MS = 5000 as const;

/**
 * Apply ±25 % full jitter to a base delay. Pure: caller passes a `rand` in
 * `[0, 1)` for determinism in tests.
 */
export function jitterDelay(baseMs: number, rand: number): number {
  // Jitter range = ±25 % of base. `rand` in [0,1) maps to the open
  // interval (-0.25, 0.25); we then multiply by base.
  const span = 0.5 * baseMs; // total window
  const offset = rand * span - 0.25 * baseMs;
  return Math.max(1, Math.round(baseMs + offset));
}

/**
 * Compute the next backoff delay for `attempt` (1-indexed).
 */
export function nextBackoffMs(attempt: number, rand: number = Math.random()): number {
  const i = Math.max(0, Math.min(attempt - 1, RECONNECT_BASE_DELAYS_MS.length - 1));
  const base = RECONNECT_BASE_DELAYS_MS[i] ?? RECONNECT_MAX_DELAY_MS;
  return jitterDelay(base, rand);
}

// ---------------------------------------------------------------------------
// ConnectClient public surface
// ---------------------------------------------------------------------------

export interface ConnectClientOptions {
  /** Listener A path (UDS / named pipe). Resolved by the caller via
   *  {@link resolveListenerAPath}. */
  readonly socketPath: string;
  /** Default per-call timeout in ms. Frag-3.5.1 §3.5.1.3 default = 5000. */
  readonly defaultTimeoutMs?: number;
  /** Per-method override map. Frag-3.5.1 §3.5.1.3: e.g. `getBufferSnapshot`
   *  is given 30000 ms because snapshots are large. Lookup is by
   *  `MethodInfo.name`. */
  readonly perMethodTimeoutMs?: Readonly<Record<string, number>>;
  /** Override the auto-reconnect schedule. Defaults to
   *  {@link RECONNECT_BASE_DELAYS_MS}. Pass `[]` to DISABLE auto-reconnect
   *  (one-shot — close on first disconnect). */
  readonly reconnectBaseDelaysMs?: readonly number[];
  /** Inject `Math.random` for deterministic jitter in tests. */
  readonly rand?: () => number;
  /** Inject a structured logger. Defaults to console.warn. */
  readonly log?: (line: string, extras?: Record<string, unknown>) => void;
  /** Inject the surface registry. Defaults to the module-level singleton. */
  readonly surfaceRegistry?: DaemonSurfaceRegistry;
  /** Inject the reconnect queue. Defaults to a fresh queue with prod/dev
   *  cap as resolved by `CCSM_DAEMON_DEV`. */
  readonly reconnectQueue?: ReconnectQueue;
  /** Inject the timeout map. Defaults to a fresh in-process map. */
  readonly timeoutMap?: TimeoutMap;
  /** Test seam: factory for the underlying `net.Socket`. Defaults to
   *  `net.connect(socketPath)`. */
  readonly netConnect?: (socketPath: string) => net.Socket;
  /** Threshold (ms) past which a still-in-map call is "leaked" and counted
   *  toward `handler.leaked.count`. Defaults to 30_000 per
   *  frag-3.5.1 §3.5.1.3. */
  readonly handlerLeakedThresholdMs?: number;
}

/**
 * Snapshot of the bridge state for callers that don't want to subscribe
 * to the full surface registry.
 */
export interface ConnectClientStatus {
  readonly state: 'connecting' | 'connected' | 'reconnecting' | 'closed';
  readonly reconnectAttempt: number;
  readonly queuedCalls: number;
  readonly inFlightCalls: number;
  readonly leakedCount: number;
}

export interface ConnectClient {
  /** Underlying Connect transport. Pass to generated `createClient(Service, transport)`
   *  to build a typed promise client per spec ch02 §3. */
  readonly transport: Transport;
  /** The merged-AbortSignal helper for callers that want to overlay their
   *  own `AbortSignal` on top of the bridge's per-call deadline. Use this
   *  to build the `signal` field of `CallOptions`. */
  buildCallOptions(opts: {
    readonly method: string;
    readonly userSignal?: AbortSignal | undefined;
    readonly traceId?: string;
    readonly perMethodTimeoutMs?: number;
  }): CallOptions & { __callId: string };
  /** Run a Connect call through the reconnect queue: if disconnected, the
   *  call is queued; if connected, the thunk runs immediately. The thunk
   *  receives the timeout-aware `CallOptions` (with merged AbortSignal).
   *  Throws `Error('daemon-reconnect-queue-overflow')` if the cap is hit
   *  (the OLDEST queued call is the one that's actually rejected; this
   *  method never throws — but the OLDEST call's promise will reject). */
  enqueueCall<T>(opts: {
    readonly method: string;
    readonly userSignal?: AbortSignal | undefined;
    readonly traceId?: string;
    readonly run: (callOpts: CallOptions) => Promise<T>;
  }): Promise<T>;
  /** Mark a previously-issued call as completed (success or failure). The
   *  bridge calls this internally; exported for advanced callers that
   *  build their own enqueue-shape. */
  endCall(callId: string): void;
  /** Subscribe to "the daemon disconnected and we are now in reconnect
   *  loop" events. Used by stream subscribers (frag-3.7 §3.7.5) so they
   *  can tear down stale stream handles before the new connection lands.
   *  Listener fires synchronously after each socket close. */
  onDisconnected(listener: () => void): () => void;
  /** Subscribe to "the daemon socket is back". Used by §3.7.5 stream
   *  resubscription. Fires AFTER the queue has drained, so a subscriber
   *  that issues a new call inside the listener does NOT race ahead of
   *  queued calls. */
  onReconnected(listener: () => void): () => void;
  /** Snapshot of liveness for tests / debug overlays. */
  status(): ConnectClientStatus;
  /** Close the socket, stop reconnecting, reject pending+queued calls. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_HANDLER_LEAKED_THRESHOLD_MS = 30_000;

const NOOP_LOG = (_line: string, _extras?: Record<string, unknown>): void => {
  /* default silent */
};

export function createConnectClient(opts: ConnectClientOptions): ConnectClient {
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const perMethodTimeoutMs = opts.perMethodTimeoutMs ?? {};
  const baseDelays = opts.reconnectBaseDelaysMs ?? RECONNECT_BASE_DELAYS_MS;
  const reconnectEnabled = baseDelays.length > 0;
  const rand = opts.rand ?? Math.random;
  const log = opts.log ?? NOOP_LOG;
  const surfaceRegistry = opts.surfaceRegistry ?? defaultDaemonSurfaceRegistry;
  const queue = opts.reconnectQueue ?? createReconnectQueue({ log });
  const tmap = opts.timeoutMap ?? createTimeoutMap();
  const netConnect = opts.netConnect ?? ((p: string) => net.connect(p));
  const leakedThresholdMs = opts.handlerLeakedThresholdMs ?? DEFAULT_HANDLER_LEAKED_THRESHOLD_MS;

  // Connection liveness — we don't pre-emptively connect a socket here
  // because Connect-Node's transport opens HTTP/2 sessions lazily on
  // first call. Instead, we listen for HTTP/2 session events on the
  // shared session manager (built by createConnectTransport) and flip
  // surface state from there.
  let connected = false;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let activeSession: http2.ClientHttp2Session | null = null;
  // Set of in-flight call-ids — also tracked by the timeout map but kept
  // as a separate Set so .size() is O(1) for the status snapshot without
  // walking the map.
  const inFlight = new Set<string>();

  const disconnectedListeners = new Set<() => void>();
  const reconnectedListeners = new Set<() => void>();

  // Build the Connect transport. The HTTP/2 layer is configured to call
  // `net.connect(socketPath)` for each new session — this is the seam
  // that lets us speak HTTP/2 over a UDS / named pipe with no external
  // proxy. Connect-Node's session manager will tear down + recreate on
  // session-error / GOAWAY.
  const transport = createConnectTransport({
    httpVersion: '2',
    // baseUrl Authority is used as the `:authority` pseudo-header.
    // Connect doesn't care about the scheme for routing once we
    // override createConnection; we use http://localhost for clarity
    // in error messages.
    baseUrl: 'http://ccsm-daemon-data.local',
    nodeOptions: {
      // http2.connect's createConnection seam: bypasses TCP/TLS and
      // hands HTTP/2 a pre-built duplex (a UDS Socket in our case).
      createConnection: (): net.Socket => {
        const sock = netConnect(opts.socketPath);
        // Track session liveness via the socket. The HTTP/2 session
        // wrapper will emit `connect` on the socket once the preface
        // exchange completes; we treat the socket-level `connect` as
        // "Listener A bind succeeded" and flip surface state.
        sock.once('connect', () => {
          connected = true;
          reconnectAttempt = 0;
          surfaceRegistry.set('idle');
          log('daemon_socket_connected', { path: opts.socketPath });
        });
        sock.on('error', (err: Error) => {
          log('daemon_socket_error', { message: err.message });
          // Don't flip state here — `close` is the canonical signal.
        });
        sock.once('close', () => {
          if (closed) return;
          if (connected) {
            connected = false;
            log('daemon_socket_closed', {});
            for (const l of disconnectedListeners) {
              try { l(); } catch (e) {
                log('disconnected_listener_threw', { message: (e as Error).message });
              }
            }
            scheduleReconnect();
          }
        });
        return sock;
      },
    },
    // Connect-side default deadline. We override per-call via
    // `CallOptions.timeoutMs` so this only fires for callers that
    // somehow bypass enqueueCall.
    defaultTimeoutMs,
    // JSON over Connect protocol — easier to wire-tap during dogfood
    // than the binary format. Switch to binary once stable (low-prio).
    useBinaryFormat: false,
  });

  // Capture the http2 session by tapping the session manager at first use.
  // Connect-Node creates the session lazily; we reach in by issuing a
  // no-op probe? — No: we instead capture the session via the
  // createConnection callback above (the socket carries the session
  // lifetime). That's sufficient; activeSession remains unused as a
  // direct read but is reserved for future Ping wiring.
  void activeSession;

  function scheduleReconnect(): void {
    if (closed || !reconnectEnabled) return;
    if (reconnectTimer) return;
    reconnectAttempt += 1;
    const delay = nextBackoffMs(reconnectAttempt, rand());
    log('daemon_reconnect_attempt', { attempt: reconnectAttempt, delayMs: delay });
    surfaceRegistry.set('reconnecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // Try to drain the queue — the next call inside the queue will
      // open a fresh HTTP/2 session via the createConnection seam,
      // which either connects (→ flips connected = true) or fails
      // synchronously (→ thunk rejects, drain swallows, scheduleReconnect
      // fires again).
      void queue.drain().then(async (count) => {
        if (connected) {
          surfaceRegistry.set('reconnected');
          log('daemon_reconnect_success', { drained: count });
          for (const l of reconnectedListeners) {
            try { l(); } catch (e) {
              log('reconnected_listener_threw', { message: (e as Error).message });
            }
          }
          // Slot self-clears after the renderer-side TTL (3s, frag-6-7
          // §6.8). We don't own that timer here.
        } else if (!closed) {
          // Drain happened but socket still flapping → schedule another.
          scheduleReconnect();
        }
      });
    }, delay);
    (reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  function buildCallOptions(b: {
    readonly method: string;
    readonly userSignal?: AbortSignal | undefined;
    readonly traceId?: string;
    readonly perMethodTimeoutMs?: number;
  }): CallOptions & { __callId: string } {
    const callId = ulid();
    const timeoutMs =
      b.perMethodTimeoutMs ?? perMethodTimeoutMs[b.method] ?? defaultTimeoutMs;
    // Build a per-call AbortController whose abort fires either on
    // user-signal abort OR on bridge-level timeout. Connect's CallOptions
    // accepts both `signal` and `timeoutMs`; we pass the merged signal
    // and let our own `setTimeout` race it so we own the BridgeTimeoutError
    // throw shape (Connect would otherwise throw a ConnectError with
    // Code.DeadlineExceeded which the renderer would receive untyped).
    const deadlineCtrl = new AbortController();
    const merged = anyAbortSignal(
      b.userSignal ? [b.userSignal, deadlineCtrl.signal] : [deadlineCtrl.signal],
    );
    tmap.startCall({ callId, method: b.method, timeoutMs });
    inFlight.add(callId);
    const timer = setTimeout(() => {
      tmap.markFired(callId);
      deadlineCtrl.abort(
        new BridgeTimeoutError({
          method: b.method,
          timeoutMs,
          traceId: b.traceId,
        }),
      );
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    // Stash the timer on the merged signal so endCall can clear it. We
    // attach as a property on the controller for symmetry.
    (deadlineCtrl as unknown as { __timer: ReturnType<typeof setTimeout> }).__timer = timer;
    const headers = new Headers();
    headers.set('x-ccsm-deadline-ms', String(timeoutMs));
    if (b.traceId !== undefined) headers.set('x-ccsm-trace-id', b.traceId);
    return {
      signal: merged,
      headers,
      __callId: callId,
    };
  }

  function endCall(callId: string): void {
    inFlight.delete(callId);
    tmap.endCall(callId);
  }

  async function enqueueCall<T>(b: {
    readonly method: string;
    readonly userSignal?: AbortSignal | undefined;
    readonly traceId?: string;
    readonly run: (callOpts: CallOptions) => Promise<T>;
  }): Promise<T> {
    const issue = async (): Promise<T> => {
      const callOpts = buildCallOptions({
        method: b.method,
        userSignal: b.userSignal,
        traceId: b.traceId,
      });
      try {
        const result = await b.run(callOpts);
        return result;
      } catch (err) {
        // If Connect itself raised DEADLINE_EXCEEDED before our local
        // timer fired (e.g. server-side deadline header echoed back),
        // upgrade to BridgeTimeoutError so callers see ONE shape.
        if (err instanceof ConnectError && err.code === Code.DeadlineExceeded) {
          throw new BridgeTimeoutError({
            method: b.method,
            timeoutMs:
              perMethodTimeoutMs[b.method] ?? defaultTimeoutMs,
            traceId: b.traceId,
          });
        }
        throw err;
      } finally {
        endCall(callOpts.__callId);
      }
    };
    if (connected || closed) {
      // closed → still issue (it'll fail fast inside the transport with
      // a clean error rather than hanging in the queue forever).
      return issue();
    }
    return queue.enqueue<T>({ method: b.method, traceId: b.traceId, thunk: issue });
  }

  function onDisconnected(listener: () => void): () => void {
    disconnectedListeners.add(listener);
    return () => {
      disconnectedListeners.delete(listener);
    };
  }
  function onReconnected(listener: () => void): () => void {
    reconnectedListeners.add(listener);
    return () => {
      reconnectedListeners.delete(listener);
    };
  }

  function status(): ConnectClientStatus {
    let state: ConnectClientStatus['state'];
    if (closed) state = 'closed';
    else if (connected) state = 'connected';
    else if (reconnectAttempt > 0) state = 'reconnecting';
    else state = 'connecting';
    return {
      state,
      reconnectAttempt,
      queuedCalls: queue.size(),
      inFlightCalls: inFlight.size,
      leakedCount: tmap.leakedSince(leakedThresholdMs),
    };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    queue.rejectAll(new Error('daemon-client-closed'));
    if (activeSession && !activeSession.destroyed) {
      try { activeSession.destroy(); } catch { /* ignore */ }
    }
    activeSession = null;
    surfaceRegistry.set('idle');
  }

  return {
    transport,
    buildCallOptions,
    enqueueCall,
    endCall,
    onDisconnected,
    onReconnected,
    status,
    close,
  };
}
