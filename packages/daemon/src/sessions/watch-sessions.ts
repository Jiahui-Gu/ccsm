// SessionService.WatchSessions handler — server-streaming subscription to
// the in-memory SessionEventBus, scoped to the caller's Principal.
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-02-final-architecture.md
//     ch04 §3 (WatchScope enum: UNSPECIFIED == OWN, OWN, ALL)
//     ch05 §5 (per-RPC enforcement matrix; WatchSessions is double-scoped:
//             principal filter is unconditional, scope enum widens to ALL
//             only for v0.4 admin principals; v0.3 daemon MUST reject ALL
//             with PermissionDenied carrying ErrorDetail).
//   - T2.5 (PR #926) — `throwError('session.not_owned', ...)` is the
//             single source of truth for `Code.PermissionDenied + ErrorDetail`
//             emission. WatchSessions reuses that mapping.
//   - T3.2 (PR #933) — SessionManager exposes `subscribe(caller, listener)`
//             which delegates to `SessionEventBus`; the bus does the
//             principal-key fanout filter (security boundary).
//
// SRP layering — three roles, kept separate (dev.md §2):
//   - decider:  `decideWatchScope(req)` — pure function, no I/O. Returns
//               `{ kind: 'accept' } | { kind: 'reject_permission_denied' }`.
//               UNSPECIFIED is treated as OWN per session.proto comment;
//               OWN is accepted; ALL is rejected with PermissionDenied.
//   - producer: `subscribeAsAsyncIterable(manager, principal, signal)` —
//               adapts the manager's push-based `subscribe(listener)` API
//               into the AsyncIterable<SessionEvent> shape Connect-ES v2
//               server-streaming handlers must return. Bounded buffer per
//               subscriber (slow-consumer protection); abort signal tears
//               down the subscription deterministically.
//   - sink:     `makeWatchSessionsHandler(deps)` — wraps the decider +
//               producer into the Connect handler signature, reading
//               `PRINCIPAL_KEY` from the HandlerContext (the
//               peerCredAuthInterceptor deposited it before this handler
//               runs), mapping each in-memory `SessionEvent` to the proto
//               `SessionEvent` shape.
//
// Why we map to proto here (not in the manager):
//   - The manager owns DB rows and is proto-agnostic by design (see
//     `sessions/types.ts` header comment + dev.md §2 SRP — manager is a
//     persistence sink, the RPC handler is a wire sink). Putting the
//     row → proto translation in the handler keeps the manager's test
//     fixtures free of @ccsm/proto and lets v0.4 add new fields to the
//     proto Session without churning the manager.
//
// Layer 1 — alternatives checked:
//   - Use `node:events.EventEmitter.on(emitter, evt, { signal })` (the
//     stdlib's built-in EventEmitter -> AsyncIterable adapter). Rejected:
//     SessionEventBus is NOT an EventEmitter (it's a 30-line bespoke bus
//     with principal-key filtering — see `event-bus.ts` Layer 1 note).
//     Wrapping the bus to look like an EventEmitter just to use the
//     stdlib adapter is more code than the 25-line adapter below.
//   - Use `rxjs` / `it-pushable` / `eventemitter3`: zero of these are
//     daemon deps, and adding a dep for one adapter is the dep-creep
//     anti-pattern dev.md §1 calls out.
//   - Have the handler call `manager.list()` once and stream a synthetic
//     "snapshot" set of `created` events before subscribing. Rejected:
//     spec ch05 §5 wording is "the bus delivers post-subscribe events" —
//     adding a snapshot would change the wire semantics from "events
//     since subscribe" to "current state + tail". v0.4 may add an
//     explicit `include_snapshot` field; v0.3 ships the tail-only shape.
//   - Drop events when the buffer is full vs. error the stream. We choose
//     ERROR (Code.ResourceExhausted via ConnectError) because a watcher
//     that misses created/destroyed events without notice would silently
//     desync the client's session list — worse than a loud disconnect
//     that the client retries (the Electron Sidebar has reconnect logic
//     in T8.x). Buffer size is generous (1024 events) so legitimate
//     workloads never hit the limit.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  LocalUserSchema,
  PrincipalSchema,
  SessionEventSchema,
  SessionSchema,
  WatchScope,
  type SessionEvent as ProtoSessionEvent,
  type SessionService,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../auth/index.js';
import { throwError } from '../rpc/errors.js';

import type { ISessionManager } from './SessionManager.js';
import type { SessionEvent, SessionRow } from './types.js';

// ---------------------------------------------------------------------------
// Decider
// ---------------------------------------------------------------------------

/**
 * Discriminated union representing the decider's verdict for a
 * WatchSessions request. Pure data; the sink is the only layer that
 * translates a `reject` verdict into a thrown ConnectError.
 *
 * `accept` is the v0.3 happy path — both `WATCH_SCOPE_UNSPECIFIED` and
 * `WATCH_SCOPE_OWN` resolve here (per session.proto comment "default
 * UNSPECIFIED == OWN"). The principal-key filter applied by the bus is
 * the security boundary in either case.
 *
 * `reject_permission_denied` is `WATCH_SCOPE_ALL` on v0.3. The spec
 * (ch05 §5 + session.proto F1) reserves `ALL` for v0.4 admin principals
 * and REQUIRES v0.3 daemons to emit PermissionDenied with structured
 * ErrorDetail so Electron / future iOS clients can branch deterministically
 * on `(code, error_detail.code)` rather than parsing free-form strings.
 */
export type WatchScopeVerdict =
  | { readonly kind: 'accept' }
  | { readonly kind: 'reject_permission_denied' };

/**
 * Pure decider over `WatchScope`. v0.3 enum values:
 *   - UNSPECIFIED (0) → accept (treated as OWN per session.proto)
 *   - OWN         (1) → accept
 *   - ALL         (2) → reject_permission_denied
 *
 * Unknown enum values (forward-compat) are rejected with
 * `reject_permission_denied`: a future v0.4 client speaking a higher
 * proto_version may send an enum value the v0.3 daemon does not know
 * about. The conservative choice is "deny by default" rather than
 * silently accepting and treating as OWN — the negotiation contract
 * (Hello) already lets the client downgrade or refuse to connect, so a
 * value the daemon cannot interpret is a contract violation.
 */
export function decideWatchScope(scope: WatchScope): WatchScopeVerdict {
  switch (scope) {
    case WatchScope.UNSPECIFIED:
    case WatchScope.OWN:
      return { kind: 'accept' };
    case WatchScope.ALL:
      return { kind: 'reject_permission_denied' };
    default:
      // Unknown enum — see Layer 1 note in the function doc.
      return { kind: 'reject_permission_denied' };
  }
}

// ---------------------------------------------------------------------------
// Row → proto mapper (sink helper, exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Build a proto `Session` from an in-process `SessionRow` and the
 * caller's principal. The principal's `LocalUser` shape is embedded in
 * the proto `owner` oneof so a watcher receives the full attribution
 * surface without an extra round-trip.
 *
 * Note: the proto `Session.owner` field is the SESSION's owner (which,
 * per the principal-scoped subscription contract, equals the watching
 * principal in v0.3 — the bus filter guarantees `row.owner_id ===
 * principalKey(caller)` before any event reaches a listener). v0.4 admin
 * subscriptions will be the only case where these can differ; until
 * then we render from the watching principal's authoritative shape so
 * `displayName` is populated (the row carries only `owner_id` =
 * principalKey, which is `<kind>:<uid>` — no display_name column).
 *
 * `exit_code` is wire-optional via proto3 field-presence (`optional
 * int32 exit_code = 7`). The DB row carries the sentinel `-1` for "not
 * yet exited" (chapter 07 §3); we map -1 → unset and any other value
 * through unchanged so `state == EXITED` rows preserve `0` correctly.
 */
export function sessionRowToProto(
  row: SessionRow,
  caller: AuthPrincipal,
): ReturnType<typeof create<typeof SessionSchema>> {
  const owner = create(PrincipalSchema, {
    kind: {
      case: 'localUser',
      value: create(LocalUserSchema, {
        uid: caller.uid,
        displayName: caller.displayName,
      }),
    },
  });
  return create(SessionSchema, {
    id: row.id,
    owner,
    state: row.state as unknown as number,
    cwd: row.cwd,
    createdUnixMs: BigInt(row.created_ms),
    lastActiveUnixMs: BigInt(row.last_active_ms),
    // Sentinel -1 means "not yet exited" — leave the optional field unset.
    exitCode: row.exit_code === -1 ? undefined : row.exit_code,
  });
}

/**
 * Translate an in-memory `SessionEvent` (from the bus) into a wire
 * `SessionEvent` proto. The proto shape is a oneof:
 *   - `created`   carries the full `Session`
 *   - `updated`   carries the full `Session` (state / exit_code change)
 *   - `destroyed` carries just the `session_id` string
 *
 * v0.3 SessionManager emits only `created` and `destroyed`; an `updated`
 * variant lands in T4.x when PTY state transitions wire in. The mapper
 * is exhaustive over the in-memory union so a future variant added to
 * `types.ts::SessionEvent` without an update here fails the TypeScript
 * `never`-narrowing check.
 */
export function sessionEventToProto(
  ev: SessionEvent,
  caller: AuthPrincipal,
): ProtoSessionEvent {
  switch (ev.kind) {
    case 'created':
      return create(SessionEventSchema, {
        kind: { case: 'created', value: sessionRowToProto(ev.session, caller) },
      });
    case 'destroyed':
      // Wire shape carries only the id — clients use it to remove the
      // session from their local cache without needing the row payload.
      return create(SessionEventSchema, {
        kind: { case: 'destroyed', value: ev.session.id },
      });
    case 'ended':
      // Spec ch06 §1: pty-host child exit (graceful or crash). Wire
      // shape is `updated` carrying the full Session row — clients
      // read the new `state` (EXITED|CRASHED) and `exit_code` to render
      // the terminal-state badge. `destroyed` is reserved for the
      // explicit DestroySession RPC path so a client can distinguish
      // "user closed it" from "child died" by which oneof case lands.
      return create(SessionEventSchema, {
        kind: { case: 'updated', value: sessionRowToProto(ev.session, caller) },
      });
    default: {
      const _exhaustive: never = ev;
      throw new Error(
        `unhandled SessionEvent kind: ${String((_exhaustive as { kind: string }).kind)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Producer — bus → AsyncIterable adapter
// ---------------------------------------------------------------------------

/**
 * Bounded buffer used by the bus → AsyncIterable adapter. 1024 events
 * is generous: a session create/destroy happens at human interaction
 * speed (multiple-of-seconds), so even a sluggish watcher should drain
 * faster than the producer can fill. Hitting the limit is an indication
 * of a stuck consumer; the adapter signals the stream as
 * `Code.ResourceExhausted` so the client's reconnect path runs.
 *
 * Exported for unit tests so the slow-consumer scenario can be exercised
 * without queuing 1025+ real events.
 */
export const DEFAULT_WATCH_BUFFER_SIZE = 1024;

interface SubscribeAsAsyncIterableOptions {
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
 * Adapt the manager's push-based `subscribe(caller, listener)` API into
 * a pull-based `AsyncIterable<SessionEvent>` that Connect-ES v2's
 * server-streaming handler can `yield*` over.
 *
 * The adapter uses a single-slot promise queue:
 *   - the listener fires synchronously from `bus.publish` and either
 *     fulfills a pending `next()` or appends to the buffer;
 *   - `next()` either consumes a buffered event or installs the resolver
 *     for the next `publish` to fire;
 *   - the `signal`'s `abort` event detaches the listener and resolves
 *     any pending `next()` with `done: true` so the for-await loop in
 *     the handler exits cleanly.
 *
 * Buffer-full policy: throw a `ConnectError(ResourceExhausted)` from
 * `next()`. The handler propagates it as the stream's terminal error so
 * the client sees a structured failure rather than silent event loss.
 *
 * Exported separately from the handler so unit tests can drive the
 * adapter against a stub `subscribe` function without building a full
 * Connect transport.
 */
export function subscribeAsAsyncIterable(
  manager: ISessionManager,
  caller: AuthPrincipal,
  options: SubscribeAsAsyncIterableOptions = {},
): AsyncIterable<SessionEvent> {
  const bufferSize = options.bufferSize ?? DEFAULT_WATCH_BUFFER_SIZE;
  const signal = options.signal;

  return {
    [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
      // Pending events queued because no consumer was waiting at publish
      // time. FIFO via Array.shift — fine at sub-1024-element scale.
      const buffer: SessionEvent[] = [];
      // Resolver installed by `next()` when the buffer is empty. Cleared
      // before each fulfillment so a second publish enqueues instead of
      // double-fulfilling a stale resolver.
      let pendingResolve:
        | ((value: IteratorResult<SessionEvent>) => void)
        | null = null;
      let pendingReject: ((reason: unknown) => void) | null = null;
      let done = false;
      // Sticky error: if the buffer overflows we record the error and
      // surface it on the next `next()` call so the handler propagates a
      // single, deterministic terminal status to the client.
      let bufferError: ConnectError | null = null;

      const unsubscribe = manager.subscribe(caller, (ev) => {
        if (done) return;
        if (pendingResolve !== null) {
          const resolve = pendingResolve;
          pendingResolve = null;
          pendingReject = null;
          resolve({ value: ev, done: false });
          return;
        }
        if (buffer.length >= bufferSize) {
          // Slow consumer — record terminal error; further events are
          // dropped because we're about to terminate the stream anyway.
          bufferError = new ConnectError(
            `WatchSessions subscriber buffer overflow (>= ${bufferSize} events); ` +
              'consumer is too slow — stream terminated so client retries.',
            Code.ResourceExhausted,
          );
          done = true;
          unsubscribe();
          return;
        }
        buffer.push(ev);
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
        async next(): Promise<IteratorResult<SessionEvent>> {
          if (buffer.length > 0) {
            const value = buffer.shift() as SessionEvent;
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
          return new Promise<IteratorResult<SessionEvent>>((resolve, reject) => {
            pendingResolve = resolve;
            pendingReject = reject;
          });
        },
        async return(value?: unknown): Promise<IteratorResult<SessionEvent>> {
          done = true;
          unsubscribe();
          detachAbort();
          if (pendingReject !== null) {
            // No-op resolver — `return()` semantically completes the
            // iterator; the consumer's pending `next()` resolves to done.
            const resolve = pendingResolve;
            pendingResolve = null;
            pendingReject = null;
            resolve?.({ value: undefined as never, done: true });
          }
          return { value: value as never, done: true };
        },
        async throw(err?: unknown): Promise<IteratorResult<SessionEvent>> {
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

export interface WatchSessionsDeps {
  readonly manager: ISessionManager;
}

/**
 * Build the Connect `ServiceImpl<typeof SessionService>['watchSessions']`
 * handler. Reads `PRINCIPAL_KEY` from the HandlerContext (the
 * peerCredAuthInterceptor deposited it before the handler runs), runs
 * the decider over the request's `scope`, then either subscribes to the
 * principal-scoped event bus and yields proto events, or throws
 * `Code.PermissionDenied` with the canonical `session.not_owned`
 * ErrorDetail (T2.5 single source of truth).
 *
 * The handler returns an async generator (Connect-ES v2 server-streaming
 * shape). The generator's lifetime is bound to the HandlerContext's
 * `signal`: when the client disconnects or the server shuts down,
 * Connect aborts the signal, the producer's `subscribeAsAsyncIterable`
 * detaches the bus listener, and the generator returns cleanly.
 */
export function makeWatchSessionsHandler(
  deps: WatchSessionsDeps,
): ServiceImpl<typeof SessionService>['watchSessions'] {
  return async function* watchSessions(
    req,
    handlerContext: HandlerContext,
  ): AsyncGenerator<ProtoSessionEvent, void, undefined> {
    const principal = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      // Defensive — peerCredAuthInterceptor MUST have deposited the
      // principal before this handler runs. Mirrors hello.ts's posture:
      // surface as Internal so operators see a daemon-side wiring bug
      // rather than the client being told they're unauthenticated.
      throw new ConnectError(
        'WatchSessions handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }

    const verdict = decideWatchScope(req.scope);
    if (verdict.kind === 'reject_permission_denied') {
      // Spec ch05 §5: WATCH_SCOPE_ALL is reserved for v0.4 admin
      // principals; v0.3 daemons MUST reject with PermissionDenied +
      // structured ErrorDetail.code = "session.not_owned" so the client
      // can branch deterministically on the (Code, ErrorDetail.code)
      // pair (T2.5 single source of truth).
      throwError('session.not_owned', 'WATCH_SCOPE_ALL is not permitted on v0.3 (admin scope reserved for v0.4)', {
        requested_scope: WatchScope[req.scope] ?? String(req.scope),
      });
    }

    const events = subscribeAsAsyncIterable(deps.manager, principal, {
      signal: handlerContext.signal,
    });

    for await (const ev of events) {
      yield sessionEventToProto(ev, principal);
    }
  };
}
