// Connect-RPC route shim for `ccsm.v1.CcsmService.SubscribeSessionEvents`
// (daemon-side, Task #106 v0.3 SessionWatcher → daemon).
//
// Bridges the transport-agnostic per-stream orchestration in
// `daemon/src/sessionWatcher/connectHandler.ts` to the typed
// @connectrpc/connect router. Owns:
//
//   1. Converting `SessionEventPojo` (camelCase, JSON-shape) into typed
//      proto `SessionEvent` envelopes via the gen-ts `create()` helper.
//   2. Translating Connect's async-iterable server-stream contract into
//      the synchronous `push(evt)` callback the orchestrator uses.
//   3. Mapping `SubscribeEndReason` → Connect status code on stream end.
//   4. Honouring `context.signal` for caller-cancel propagation.
//
// SRP:
//   - sink (proto serialization + Connect transport adaptation).
//   - NOT a producer (the `SessionStateMachine` mints events) and NOT a
//     decider (the `connectHandler` decides snapshot-vs-delta + heartbeat).
//
// v0.3 zero-rework rule: this module is the v0.4 wire surface verbatim.
// No envelope-streaming bridge, no temporary dual-write — the router
// hands `subscribeSessionEvents` exclusively to this shim.
//
// Type-system note: daemon's tsconfig keeps `moduleResolution: NodeNext`
// + `rootDir: src` so the gen/ts proto stubs are NOT pulled into
// daemon's typecheck graph (they live as a sibling tree under `gen/ts`
// and are compiled independently for renderer/tests). To keep the proto
// types out of this file's compile dependencies AND still produce
// schema-valid wire messages at runtime, we accept the proto-side
// dependencies as opaque `ProtoCreateFn` / `ProtoSchemas` injected by
// the daemon shell at boot time. The shell wires them via the
// `@ccsm/proto-gen/v1` alias (live in vitest config + electron tsconfig
// + esbuild bundle resolution) before invoking
// `registerSessionWatcherRoutes`. This keeps the daemon binary build
// (rootDir=src) untouched.

import {
  Code,
  ConnectError,
  type ConnectRouter,
  type HandlerContext,
} from '@connectrpc/connect';
import {
  handleSubscribeSessionEvents,
  type SubscribeContext,
  type SubscribeEndReason,
  type SubscribeRequestPojo,
  type SubscribeStream,
} from '../sessionWatcher/connectHandler.js';
import type { SessionEventPojo } from '../sessionWatcher/sessionState.js';

// ---------------------------------------------------------------------------
// Proto injection surface (opaque to this module)
// ---------------------------------------------------------------------------

/**
 * The `create()` helper from `@bufbuild/protobuf`. Re-exported by the
 * proto-gen barrel; the daemon shell forwards it here so this module
 * doesn't need a direct dependency on the generated types.
 */
export type ProtoCreateFn = <S, T>(schema: S, init?: unknown) => T;

/**
 * The minimal set of generated `Schema` constants this shim references.
 * Each is a `GenMessage` from `@bufbuild/protobuf/codegenv2`; the shim
 * passes them through to `create()` opaquely.
 */
export interface SessionEventSchemas {
  SessionEventSchema: unknown;
  SessionSnapshotEventSchema: unknown;
  SessionSnapshotSchema: unknown;
  SessionDeltaEventSchema: unknown;
  SessionStateChangeSchema: unknown;
  SessionTitleChangeSchema: unknown;
  SessionCwdChangeSchema: unknown;
  SessionPidChangeSchema: unknown;
  SessionExitedSchema: unknown;
  SessionHeartbeatEventSchema: unknown;
  SessionBootChangedEventSchema: unknown;
}

/**
 * The umbrella service descriptor (`CcsmService` from
 * `@ccsm/proto-gen/v1`). Opaque here; passed to `router.service`.
 */
export type CcsmServiceDesc = unknown;

/**
 * The proto request shape decoded by Connect — daemon shell narrows
 * this with the gen-ts `SubscribeSessionEventsRequest` type at the
 * router-binding callsite.
 */
export interface SubscribeRequestProto {
  sessionId: string;
  fromSeq: bigint;
  fromBootNonce: string;
  heartbeatMs: number;
}

// ---------------------------------------------------------------------------
// POJO → proto conversion
// ---------------------------------------------------------------------------

/**
 * Convert one `SessionEventPojo` into a typed `SessionEvent` proto
 * envelope. Returns `null` for an unrecognized variant (defense in depth
 * — the POJO shape is a closed union so this should be unreachable; the
 * null lets the route shim drop it without crashing the stream).
 */
export function pojoToProtoSessionEvent(
  evt: SessionEventPojo,
  create: ProtoCreateFn,
  schemas: SessionEventSchemas,
): unknown | null {
  switch (evt.kind) {
    case 'snapshot':
      return create(schemas.SessionEventSchema, {
        event: {
          case: 'snapshot',
          value: {
            snapshot: {
              sessionId: evt.snapshot.sessionId,
              seq: BigInt(evt.snapshot.seq),
              state: evt.snapshot.state,
              title: evt.snapshot.title,
              cwd: evt.snapshot.cwd,
              spawnCwd: evt.snapshot.spawnCwd,
              spawnedAtMs: BigInt(evt.snapshot.spawnedAtMs),
              pid: evt.snapshot.pid,
            },
            tsMs: BigInt(evt.tsMs),
            gap: evt.gap,
          },
        },
      });
    case 'delta': {
      const change = evt.change;
      let changeInit;
      switch (change.kind) {
        case 'state_changed':
          changeInit = { case: 'stateChanged', value: { state: change.state } };
          break;
        case 'title_changed':
          changeInit = { case: 'titleChanged', value: { title: change.title } };
          break;
        case 'cwd_changed':
          changeInit = {
            case: 'cwdChanged',
            value: { fromCwd: change.fromCwd, toCwd: change.toCwd },
          };
          break;
        case 'pid_changed':
          changeInit = { case: 'pidChanged', value: { pid: change.pid } };
          break;
        case 'exited':
          changeInit = {
            case: 'exited',
            value: { exitCode: change.exitCode, signal: change.signal },
          };
          break;
      }
      return create(schemas.SessionEventSchema, {
        event: {
          case: 'delta',
          value: {
            sessionId: evt.sessionId,
            seq: BigInt(evt.seq),
            tsMs: BigInt(evt.tsMs),
            change: changeInit,
          },
        },
      });
    }
    case 'heartbeat':
      return create(schemas.SessionEventSchema, {
        event: {
          case: 'heartbeat',
          value: {
            sessionId: evt.sessionId,
            tsMs: BigInt(evt.tsMs),
            lastSeq: BigInt(evt.lastSeq),
            bootNonce: evt.bootNonce,
          },
        },
      });
    case 'boot_changed':
      return create(schemas.SessionEventSchema, {
        event: {
          case: 'bootChanged',
          value: {
            sessionId: evt.sessionId,
            bootNonce: evt.bootNonce,
            snapshotPending: evt.snapshotPending,
          },
        },
      });
  }
}

/**
 * Map a `SubscribeEndReason` to a Connect status code. `caller-cancel`
 * resolves the stream cleanly (no error) — Connect treats a return from
 * the async generator as success, so we throw only for the non-clean
 * end reasons.
 */
export function endReasonToError(reason: SubscribeEndReason): ConnectError | null {
  switch (reason.kind) {
    case 'caller-cancel':
      return null;
    case 'session-removed':
      return new ConnectError(
        `session ${reason.sessionId} removed`,
        Code.NotFound,
      );
    case 'daemon-shutdown':
      return new ConnectError('daemon shutting down', Code.Unavailable);
    case 'invalid-request':
      return new ConnectError(reason.detail, Code.InvalidArgument);
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Context the route handler needs at request-dispatch time. The daemon
 * shell builds one of these once at supervisor boot and passes it into
 * `registerSessionWatcherRoutes`.
 */
export interface SessionWatcherRouteContext {
  /** Test-friendly factory: typically returns a static `SubscribeContext`,
   *  but a getter lets the daemon swap state-machines on a graceful
   *  reload without restarting the Connect server. */
  readonly getSubscribeContext: () => SubscribeContext;
  /** `create` from `@bufbuild/protobuf`. */
  readonly create: ProtoCreateFn;
  /** Generated proto schemas pulled from `@ccsm/proto-gen/v1`. */
  readonly schemas: SessionEventSchemas;
  /** The `CcsmService` umbrella descriptor from `@ccsm/proto-gen/v1`. */
  readonly ccsmService: CcsmServiceDesc;
}

/**
 * Register the `SubscribeSessionEvents` server-stream on the given
 * Connect router. Idempotent only by router-side semantics (registering
 * the same method twice is a router error in @connectrpc).
 */
export function registerSessionWatcherRoutes(
  router: ConnectRouter,
  ctx: SessionWatcherRouteContext,
): void {
  // The router.service signature is `<T extends DescService>(service: T,
  // implementation: Partial<ServiceImpl<T>>)`. We pass the descriptor as
  // `unknown` (because daemon doesn't carry the proto types) and a
  // structurally-shaped impl object; Connect accepts it because the gen
  // service descriptor's `subscribeSessionEvents.methodKind` already
  // declares server_streaming.
  (router.service as (svc: unknown, impl: unknown) => unknown)(
    ctx.ccsmService,
    {
      subscribeSessionEvents: (req: SubscribeRequestProto, handlerCtx: HandlerContext) =>
        subscribeSessionEventsImpl(req, handlerCtx, ctx),
    },
  );
}

/**
 * The async-iterable adapter. Bridges the orchestrator's synchronous
 * `push(evt)` callback to a Connect server-stream. Exposed (un-wrapped)
 * so unit tests can drive the iterable directly without spinning up a
 * router.
 */
export async function* subscribeSessionEventsImpl(
  req: SubscribeRequestProto,
  handlerCtx: HandlerContext,
  routeCtx: SessionWatcherRouteContext,
): AsyncIterable<{ event: unknown }> {
  const ctx = routeCtx.getSubscribeContext();

  // Convert proto request → POJO request (bigint → number for fromSeq;
  // values are bounded by daemon-issued seqs, so the cast is safe).
  const pojoReq: SubscribeRequestPojo = {
    sessionId: req.sessionId,
    fromSeq: Number(req.fromSeq),
    fromBootNonce: req.fromBootNonce,
    heartbeatMs: req.heartbeatMs,
  };

  // Bridge: a bounded queue + waiter promise. The orchestrator pushes
  // synchronously; we yield asynchronously. End-of-stream is signalled
  // by setting `endReason` and resolving `wake`.
  const pending: SessionEventPojo[] = [];
  let endReason: SubscribeEndReason | null = null;
  let wake: (() => void) | null = null;
  const onPushed = (): void => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  const stream: SubscribeStream = {
    push(evt) {
      pending.push(evt);
      onPushed();
    },
    end(reason) {
      if (endReason !== null) return;
      endReason = reason;
      onPushed();
    },
  };

  const cancelOrchestrator = handleSubscribeSessionEvents(pojoReq, stream, ctx);

  // Wire caller-cancel: when the Connect transport aborts the request
  // (renderer disconnect, daemon graceful shutdown of the stream), we
  // ask the orchestrator to clean up. The orchestrator will end() us
  // with `caller-cancel`, which makes the loop below break cleanly.
  const onAbort = (): void => {
    cancelOrchestrator();
  };
  if (handlerCtx.signal.aborted) {
    onAbort();
  } else {
    handlerCtx.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      // Drain anything queued.
      while (pending.length > 0) {
        const next = pending.shift()!;
        const proto = pojoToProtoSessionEvent(next, routeCtx.create, routeCtx.schemas);
        if (proto !== null) {
          yield { event: proto };
        }
      }
      if (endReason !== null) break;
      // Park until the orchestrator pushes or ends the stream.
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    handlerCtx.signal.removeEventListener('abort', onAbort);
    // If we exit the loop without an end reason (transport aborted mid-
    // iteration via throw), still cancel the orchestrator so the
    // registry releases the subscriber.
    if (endReason === null) {
      cancelOrchestrator();
    }
  }

  if (endReason !== null) {
    const err = endReasonToError(endReason);
    if (err !== null) throw err;
  }
}
