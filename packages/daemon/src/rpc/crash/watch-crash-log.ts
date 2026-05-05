// packages/daemon/src/rpc/crash/watch-crash-log.ts
//
// Wave-3 Task #335 (sub-task 4b of audit #228) — production
// CrashService.WatchCrashLog server-streaming Connect handler.
//
// Audit reference: docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md
// (sub-task 4b). Pre-#335 the WatchCrashLog method on CrashService was
// silently `Code.Unimplemented` — the stub baseline plus the partial
// `registerCrashService` overlay (Task #229 / PR #996) covered only
// `getCrashLog`; the router's "absent method -> Unimplemented" rule kept
// the streaming sibling stubbed despite a fully-wired emit hook in
// `crash/raw-appender.ts:appendCrashRaw -> defaultCrashEventBus.emitCrashAdded`
// (Task #340).
//
// This file ships the streaming handler. It consumes the `CrashEventBus`
// (Task #340 — packages/daemon/src/crash/event-bus.ts) and yields the
// proto `CrashEntry` shape for every event whose `owner_id` matches the
// caller's `OwnerFilter` policy (ch04 §5 OWN/ALL semantics).
//
// Spec refs:
//   - packages/proto/src/ccsm/v1/crash.proto:
//       service CrashService { rpc WatchCrashLog(WatchCrashLogRequest)
//         returns (stream CrashEntry); }
//       message WatchCrashLogRequest { RequestMeta meta = 1;
//         OwnerFilter owner_filter = 2; }
//       enum OwnerFilter { UNSPECIFIED = 0 (==OWN); OWN = 1; ALL = 2; }
//       message CrashEntry { id; ts_unix_ms; source; summary; detail;
//         labels; owner_id; }
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//       ch04 §5 (OwnerFilter contract), ch09 §1 (`'daemon-self'` sentinel
//       included in OWN by definition), ch12 §3 (crash-stream wire
//       coverage; OWN passes daemon-self, drops other principals).
//   - packages/daemon/test/integration/crash-stream.spec.ts already pins
//       the over-the-wire OWN/ALL/daemon-self semantics this handler
//       implements end-to-end against an in-test `CrashEventBus`-shaped
//       bus; this file is the production binding to the real
//       `defaultCrashEventBus` that `appendCrashRaw` emits on.
//
// SRP layering — three roles kept separate (dev.md §2):
//   * decider:  `decideOwnerScope(filter)` — pure enum verdict over
//               `OwnerFilter`. UNSPECIFIED/OWN → 'own'; ALL →
//               'reject_permission_denied' (spec ch15 §3 #14: ALL is
//               reserved for v0.4 admin principals; v0.3 daemon MUST
//               reject); unknown enum → 'reject_permission_denied'
//               (forward-compat conservative deny, same posture as
//               `sessions/watch-sessions.ts:decideWatchScope`).
//   * predicate: `isVisibleToCaller(entry, scope, callerKey)` — pure
//               function. OWN visibility = `entry.owner_id === callerKey
//               || entry.owner_id === DAEMON_SELF`. ALL visibility = true.
//   * producer: `subscribeAsAsyncIterable(bus, options)` — push (bus
//               callback) → pull (AsyncIterable) adapter with bounded
//               buffer + abort-signal teardown. Mirrors the
//               `sessions/watch-sessions.ts:subscribeAsAsyncIterable`
//               adapter exactly so reviewers see one shape across
//               subsystems. The visibility filter runs INSIDE the bus
//               callback so non-matching events never enter the buffer
//               (a noisy `daemon-self` storm can't pin memory for a
//               watcher that wouldn't have shown them anyway).
//   * sink:     `makeWatchCrashLogHandler(deps)` — Connect handler that
//               reads `PRINCIPAL_KEY` from the HandlerContext (the
//               `peerCredAuthInterceptor` deposited it before the handler
//               runs), runs the decider over the request, then either
//               subscribes to the bus and yields proto events, or throws
//               `Code.PermissionDenied` with the canonical
//               `session.not_owned` ErrorDetail (T2.5 single source of
//               truth — same code GetCrashLog uses for unknown enums).
//
// Layer 1 — alternatives checked:
//   - "Reuse `sessions/watch-sessions.ts:subscribeAsAsyncIterable`": the
//     two adapters are structurally identical but typed over different
//     bus shapes. SessionEventBus has principal-keyed `subscribe(key,
//     listener)` (security-boundary filter inside the bus);
//     CrashEventBus is a flat `onCrashAdded(listener)` (filter is the
//     handler's responsibility — by design, see event-bus.ts header).
//     Generifying over both would force an awkward predicate parameter
//     onto the sessions adapter purely to share 25 lines of buffer logic.
//     Re-implementing here keeps each subsystem's adapter independently
//     readable; both adapters share the same bounded-buffer +
//     abort-signal contract by inspection, not by type-magic.
//   - `node:events.EventEmitter.on(emitter, evt, { signal })`: rejected
//     for the same reason as in watch-sessions — the bus is not an
//     EventEmitter and wrapping it just to use the stdlib adapter is
//     more code than the 25-line bespoke pump.
//   - Drop events when buffer is full vs. error the stream: ERROR via
//     `Code.ResourceExhausted` so a stuck consumer gets a loud
//     reconnect signal rather than silent crash-event loss. Same policy
//     as WatchSessions (the operator viewing crashes has the same
//     "missing notifications are worse than a visible disconnect"
//     trade-off).
//   - Snapshot of historical rows before the live tail: out of scope
//     for v0.3 — the `WatchCrashLogRequest` wire shape carries no
//     `since_unix_ms` cursor (unlike `GetCrashLogRequest`); the spec
//     ch12 §3 contract is "events emitted AFTER subscribe surface".
//     Clients that need history call `GetCrashLog` first and then
//     `WatchCrashLog` for the tail (the same two-step pattern Electron
//     uses for `ListSessions` + `WatchSessions`).

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  CrashEntrySchema,
  type CrashService,
  OwnerFilter,
  type CrashEntry as ProtoCrashEntry,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, principalKey, type Principal } from '../../auth/index.js';
import { CrashEventBus } from '../../crash/event-bus.js';
import type { CrashRawEntry } from '../../crash/raw-appender.js';
import { DAEMON_SELF } from '../../crash/sources.js';
import { throwError } from '../errors.js';

// ---------------------------------------------------------------------------
// Decider
// ---------------------------------------------------------------------------

/**
 * Discriminated union: pure verdict over the request's `OwnerFilter`.
 *
 * - `own` — `OWNER_FILTER_UNSPECIFIED` (==OWN per crash.proto comment) or
 *   `OWNER_FILTER_OWN`. Visibility: `entry.owner_id === callerKey ||
 *   entry.owner_id === DAEMON_SELF` (ch04 §5 + ch09 §1 sentinel).
 * - `reject_permission_denied` — `OWNER_FILTER_ALL` on v0.3 (spec ch15 §3
 *   #14: ALL reserved for v0.4 admin principals; v0.3 daemon MUST reject
 *   with PermissionDenied + structured ErrorDetail), OR an unknown enum
 *   value the v0.3 daemon does not know (forward-compat conservative
 *   deny — same posture as `decideWatchScope`'s default branch). A v0.4
 *   client speaking a higher proto_version that sends a brand-new enum
 *   value gets a structured `(PermissionDenied, session.not_owned)` pair
 *   rather than silent acceptance.
 */
export type OwnerScopeVerdict =
  | { readonly kind: 'own' }
  | { readonly kind: 'reject_permission_denied' };

/**
 * Pure decider over `OwnerFilter`. v0.3 enum values:
 *   - UNSPECIFIED (0) → 'own' (treated as OWN per crash.proto comment)
 *   - OWN         (1) → 'own'
 *   - ALL         (2) → 'reject_permission_denied' (spec ch15 §3 #14:
 *                       OwnerFilter / SettingsScope / WatchScope MUST
 *                       reject the broadened values on v0.3; ALL is
 *                       reserved for v0.4 admin principals)
 *   - anything else → 'reject_permission_denied'
 */
export function decideOwnerScope(filter: OwnerFilter): OwnerScopeVerdict {
  switch (filter) {
    case OwnerFilter.UNSPECIFIED:
    case OwnerFilter.OWN:
      return { kind: 'own' };
    case OwnerFilter.ALL:
      return { kind: 'reject_permission_denied' };
    default:
      return { kind: 'reject_permission_denied' };
  }
}

// ---------------------------------------------------------------------------
// Visibility predicate (pure)
// ---------------------------------------------------------------------------

/**
 * True iff `entry` is visible to a caller subscribed under `scope`.
 *
 * OWN visibility (ch04 §5 OWNER_FILTER_OWN definition):
 *   `entry.owner_id === callerKey || entry.owner_id === DAEMON_SELF`.
 * The `DAEMON_SELF` arm surfaces daemon-side crashes (sqlite_op,
 * uncaught_exception, ...) to the local user even though no
 * principalKey will ever match the sentinel — see ch09 §1 + the
 * `event-bus.ts` Layer 1 note on why filtering is the handler's job.
 *
 * v0.3 has only one accepted scope verdict — `own` — because ALL is
 * rejected at the sink (spec ch15 §3 #14). The
 * `reject_permission_denied` branch is filtered out by the sink before
 * this helper is reached, but we be defensive — an unknown scope hides
 * everything rather than silently widening.
 *
 * Exported so unit tests can pin the predicate without spinning up a
 * Connect transport.
 */
export function isVisibleToCaller(
  entry: CrashRawEntry,
  scope: OwnerScopeVerdict,
  callerKey: string,
): boolean {
  if (scope.kind === 'own') {
    return entry.owner_id === callerKey || entry.owner_id === DAEMON_SELF;
  }
  // 'reject_permission_denied' is filtered out by the sink before this
  // helper is reached, but be defensive — an unknown scope hides
  // everything rather than silently widening.
  return false;
}

// ---------------------------------------------------------------------------
// Producer — bus → AsyncIterable adapter
// ---------------------------------------------------------------------------

/**
 * Bounded buffer used by the bus → AsyncIterable adapter. 1024 events
 * matches the WatchSessions adapter (`watch-sessions.ts:DEFAULT_WATCH_BUFFER_SIZE`)
 * for one shape across subsystems. Crashes happen at human-noticeable
 * speed — even a fatal-loop bounded by the retention pruner cannot
 * sustain >1024 events between consumer pulls. Hitting the limit is a
 * stuck consumer; the adapter signals `Code.ResourceExhausted` so the
 * client's reconnect path runs.
 *
 * Exported for unit tests so the slow-consumer scenario can be exercised
 * without queuing 1025+ real events.
 */
export const DEFAULT_WATCH_BUFFER_SIZE = 1024;

interface SubscribeAsAsyncIterableOptions {
  /** Pre-filter — only entries that pass are buffered. */
  readonly visible: (entry: CrashRawEntry) => boolean;
  /** Override the buffer size — tests use a small value to exercise overflow. */
  readonly bufferSize?: number;
  /**
   * AbortSignal used to tear down the subscription. Connect-ES passes
   * `HandlerContext.signal` which fires when the client disconnects or
   * the server is shutting down. The adapter detaches its listener and
   * resolves the iterator's pending `next()` with `done: true`.
   */
  readonly signal?: AbortSignal;
}

/**
 * Adapt the bus's push-based `onCrashAdded(listener)` API into a
 * pull-based `AsyncIterable<CrashRawEntry>` that Connect-ES v2's
 * server-streaming handler can `yield*` over.
 *
 * Single-slot promise queue, identical in shape to
 * `sessions/watch-sessions.ts:subscribeAsAsyncIterable`:
 *   - the listener fires synchronously from `bus.emitCrashAdded` and either
 *     fulfills a pending `next()` or appends to the buffer (after the
 *     visibility filter — non-matching events do NOT enter the buffer);
 *   - `next()` either consumes a buffered event or installs the resolver
 *     for the next emit to fire;
 *   - the `signal`'s `abort` event detaches the listener and resolves
 *     any pending `next()` with `done: true` so the for-await loop in
 *     the handler exits cleanly.
 *
 * Buffer-full policy: throw a `ConnectError(ResourceExhausted)` from
 * `next()`. The handler propagates it as the stream's terminal error so
 * the client sees a structured failure rather than silent event loss.
 *
 * Exported separately from the handler so unit tests can drive the
 * adapter against a fresh `new CrashEventBus()` without building a full
 * Connect transport.
 */
export function subscribeAsAsyncIterable(
  bus: CrashEventBus,
  options: SubscribeAsAsyncIterableOptions,
): AsyncIterable<CrashRawEntry> {
  const bufferSize = options.bufferSize ?? DEFAULT_WATCH_BUFFER_SIZE;
  const signal = options.signal;
  const visible = options.visible;

  return {
    [Symbol.asyncIterator](): AsyncIterator<CrashRawEntry> {
      const buffer: CrashRawEntry[] = [];
      let pendingResolve:
        | ((value: IteratorResult<CrashRawEntry>) => void)
        | null = null;
      let pendingReject: ((reason: unknown) => void) | null = null;
      let done = false;
      let bufferError: ConnectError | null = null;

      const unsubscribe = bus.onCrashAdded((entry) => {
        if (done) return;
        // Visibility filter — non-matching events are dropped at the
        // boundary; they never enter the buffer and cannot exhaust it.
        if (!visible(entry)) return;
        if (pendingResolve !== null) {
          const resolve = pendingResolve;
          pendingResolve = null;
          pendingReject = null;
          resolve({ value: entry, done: false });
          return;
        }
        if (buffer.length >= bufferSize) {
          bufferError = new ConnectError(
            `WatchCrashLog subscriber buffer overflow (>= ${bufferSize} events); ` +
              'consumer is too slow — stream terminated so client retries.',
            Code.ResourceExhausted,
          );
          done = true;
          unsubscribe();
          return;
        }
        buffer.push(entry);
      });

      const onAbort = (): void => {
        if (done) return;
        done = true;
        unsubscribe();
        if (pendingResolve !== null) {
          const resolve = pendingResolve;
          pendingResolve = null;
          pendingReject = null;
          resolve({ value: undefined as never, done: true });
        }
      };

      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      const detachAbort = (): void => {
        if (signal !== undefined) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      return {
        async next(): Promise<IteratorResult<CrashRawEntry>> {
          if (buffer.length > 0) {
            const value = buffer.shift() as CrashRawEntry;
            return { value, done: false };
          }
          if (bufferError !== null) {
            const err = bufferError;
            bufferError = null;
            detachAbort();
            throw err;
          }
          if (done) {
            detachAbort();
            return { value: undefined as never, done: true };
          }
          return new Promise<IteratorResult<CrashRawEntry>>((resolve, reject) => {
            pendingResolve = resolve;
            pendingReject = reject;
          });
        },
        async return(value?: unknown): Promise<IteratorResult<CrashRawEntry>> {
          done = true;
          unsubscribe();
          detachAbort();
          if (pendingReject !== null) {
            const resolve = pendingResolve;
            pendingResolve = null;
            pendingReject = null;
            resolve?.({ value: undefined as never, done: true });
          }
          return { value: value as never, done: true };
        },
        async throw(err?: unknown): Promise<IteratorResult<CrashRawEntry>> {
          done = true;
          unsubscribe();
          detachAbort();
          if (pendingReject !== null) {
            const reject = pendingReject;
            pendingResolve = null;
            pendingReject = null;
            reject(err);
          }
          throw err;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Sink — Connect handler
// ---------------------------------------------------------------------------

/**
 * Map a `CrashRawEntry` (NDJSON shape, raw-appender's domain type) to
 * the wire `CrashEntry` (proto). Mirrors the encoder in
 * `crash-stream.spec.ts:toProtoEntry` so the production handler emits
 * the exact shape the integration test pinned, AND the per-row mapper
 * in `get-crash-log.ts:rowToProto` for cross-method consistency.
 *
 * `labels` is copied (not aliased) so a downstream mutation of the proto
 * cannot mutate the bus event's frozen-by-convention labels map.
 *
 * Exported for unit tests.
 */
export function rawEntryToProto(raw: CrashRawEntry): ProtoCrashEntry {
  return create(CrashEntrySchema, {
    id: raw.id,
    tsUnixMs: BigInt(raw.ts_ms),
    source: raw.source,
    summary: raw.summary,
    detail: raw.detail,
    labels: { ...raw.labels },
    ownerId: raw.owner_id,
  });
}

export interface WatchCrashLogDeps {
  /**
   * Crash event bus. Production wiring passes the
   * `defaultCrashEventBus` singleton from
   * `packages/daemon/src/crash/event-bus.ts` — the SAME instance that
   * `crash/raw-appender.ts:appendCrashRaw` emits on after `fsync`. Tests
   * construct a fresh `new CrashEventBus()` so emitted events do not
   * cross-contaminate.
   */
  readonly bus: CrashEventBus;
}

/**
 * Build the Connect `ServiceImpl<typeof CrashService>['watchCrashLog']`
 * handler.
 *
 * Reads `PRINCIPAL_KEY` from the HandlerContext (the
 * `peerCredAuthInterceptor` deposited it before this handler runs),
 * runs the decider over `req.ownerFilter`, then either subscribes to
 * the bus and yields proto `CrashEntry` events, or throws
 * `Code.PermissionDenied` with the canonical `session.not_owned`
 * ErrorDetail (T2.5 single source of truth — matches the unknown-enum
 * posture in `get-crash-log.ts`).
 *
 * The handler returns an async generator (Connect-ES v2 server-streaming
 * shape). The generator's lifetime is bound to the HandlerContext's
 * `signal`: when the client disconnects or the server shuts down,
 * Connect aborts the signal, the producer's `subscribeAsAsyncIterable`
 * detaches the bus listener, and the generator returns cleanly.
 *
 * Mirrors the posture of `sessions/watch-sessions.ts:makeWatchSessionsHandler`:
 * a missing principal is a daemon wiring bug surfaced as `Internal`
 * rather than `Unauthenticated` (the auth interceptor would have
 * rejected the call before this handler ran if the caller were
 * unauthenticated).
 */
export function makeWatchCrashLogHandler(
  deps: WatchCrashLogDeps,
): ServiceImpl<typeof CrashService>['watchCrashLog'] {
  return async function* watchCrashLog(
    req,
    handlerContext: HandlerContext,
  ): AsyncGenerator<ProtoCrashEntry, void, undefined> {
    const principal: Principal | null = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      throw new ConnectError(
        'WatchCrashLog handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }

    const verdict = decideOwnerScope(req.ownerFilter);
    if (verdict.kind === 'reject_permission_denied') {
      // Spec ch15 §3 #14: OwnerFilter / SettingsScope / WatchScope MUST
      // reject the broadened values (ALL / PRINCIPAL) on v0.3 with
      // PermissionDenied. ALL is reserved for v0.4 admin principals.
      // Forward-compat conservative deny — also catches unknown enum
      // values from a v0.4 client speaking a higher proto_version. T2.5
      // single source of truth: `session.not_owned` →
      // `Code.PermissionDenied + ErrorDetail`.
      const requested =
        req.ownerFilter === OwnerFilter.ALL
          ? 'ALL'
          : String(req.ownerFilter);
      const message =
        req.ownerFilter === OwnerFilter.ALL
          ? 'OWNER_FILTER_ALL is not permitted on v0.3 (admin scope reserved for v0.4 — spec ch15 §3 #14)'
          : `unknown OwnerFilter enum value ${requested} — refusing to interpret`;
      throwError('session.not_owned', message, {
        requested_owner_filter: requested,
      });
    }

    const callerKey = principalKey(principal);
    const events = subscribeAsAsyncIterable(deps.bus, {
      visible: (entry) => isVisibleToCaller(entry, verdict, callerKey),
      signal: handlerContext.signal,
    });

    for await (const ev of events) {
      yield rawEntryToProto(ev);
    }
  };
}
