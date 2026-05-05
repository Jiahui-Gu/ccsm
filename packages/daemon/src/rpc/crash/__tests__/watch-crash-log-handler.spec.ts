// packages/daemon/src/rpc/crash/__tests__/watch-crash-log-handler.spec.ts
//
// Task #472 (T8.14b-7c) — daemon src/rpc/ coverage push for the
// production CrashService.WatchCrashLog server-streaming handler. PR #1061
// (Task #437) audited rpc/ and excluded `crash/watch-crash-log.ts` because
// `#435 owns crash/`. PR #1060 (Task #435) shipped fileSink coverage but
// did NOT add a direct unit spec for the rpc/crash watch handler — the
// only direct unit spec for streaming RPCs in src/rpc/ today is
// `pty-attach.spec.ts` and `crash/__tests__/get-raw-crash-log.spec.ts`.
// `test/integration/crash-stream.spec.ts` covers it end-to-end but is
// pre-existing-flaky on the same hook-timeout pattern as the other wired
// integration specs (see PR #1060 / #1061 PR bodies).
//
// Scope (one branch per `it`):
//   1. decideOwnerScope — UNSPECIFIED → 'own'
//   2. decideOwnerScope — OWN         → 'own'
//   3. decideOwnerScope — ALL         → 'reject_permission_denied' (spec ch15 §3 #14)
//   4. decideOwnerScope — unknown     → 'reject_permission_denied' (forward-compat)
//   5. isVisibleToCaller — entry owned by caller passes
//   6. isVisibleToCaller — entry owned by DAEMON_SELF passes
//   7. isVisibleToCaller — entry owned by other principal hidden
//   8. isVisibleToCaller — reject_permission_denied scope hides everything
//   9. rawEntryToProto — labels are copied (mutation isolation)
//  10. subscribeAsAsyncIterable — emit-then-pull yields filtered events in order
//  11. subscribeAsAsyncIterable — visibility filter rejects non-matching
//      events at the boundary (they never enter the buffer)
//  12. subscribeAsAsyncIterable — bufferSize overflow throws ResourceExhausted
//      from next() and detaches the listener
//  13. subscribeAsAsyncIterable — abort signal closes iterator with done:true
//      and detaches listener
//  14. handler — missing PRINCIPAL_KEY → Code.Internal
//  15. handler — OwnerFilter.ALL       → Code.PermissionDenied + session.not_owned
//  16. handler — unknown enum          → Code.PermissionDenied + session.not_owned
//  17. handler — happy path: emits → handler yields proto entry; abort closes generator

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Code,
  ConnectError,
  createContextValues,
  type HandlerContext,
} from '@connectrpc/connect';

import {
  ErrorDetailSchema,
  OwnerFilter,
  type ErrorDetail,
} from '@ccsm/proto';
import { create } from '@bufbuild/protobuf';
import { WatchCrashLogRequestSchema, RequestMetaSchema } from '@ccsm/proto';

import { PRINCIPAL_KEY, principalKey, type Principal } from '../../../auth/index.js';
import { CrashEventBus } from '../../../crash/event-bus.js';
import type { CrashRawEntry } from '../../../crash/raw-appender.js';
import { DAEMON_SELF } from '../../../crash/sources.js';
import {
  DEFAULT_WATCH_BUFFER_SIZE,
  decideOwnerScope,
  isVisibleToCaller,
  makeWatchCrashLogHandler,
  rawEntryToProto,
  subscribeAsAsyncIterable,
} from '../watch-crash-log.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRINCIPAL_ALICE: Principal = {
  kind: 'local-user',
  uid: '1000',
  displayName: 'alice',
};
const ALICE_KEY = principalKey(PRINCIPAL_ALICE);
const BOB_KEY = 'local-user:1001';

function entry(opts: Partial<CrashRawEntry> & { id: string; owner_id: string }): CrashRawEntry {
  return {
    id: opts.id,
    ts_ms: opts.ts_ms ?? 1,
    source: opts.source ?? 'sqlite_open',
    summary: opts.summary ?? 'sum',
    detail: opts.detail ?? 'det',
    labels: opts.labels ?? {},
    owner_id: opts.owner_id,
  };
}

function ctxWith(
  principal: Principal | null,
  signal?: AbortSignal,
): HandlerContext {
  const values = createContextValues();
  values.set(PRINCIPAL_KEY, principal);
  return {
    values,
    signal: signal ?? new AbortController().signal,
  } as HandlerContext;
}

function makeReq(filter: OwnerFilter = OwnerFilter.OWN) {
  return create(WatchCrashLogRequestSchema, {
    meta: create(RequestMetaSchema, { requestId: 'rid-1' }),
    ownerFilter: filter,
  });
}

function expectErrorDetailCode(err: ConnectError, expected: string): void {
  const details = err.findDetails(ErrorDetailSchema) as ErrorDetail[];
  expect(details.length).toBeGreaterThanOrEqual(1);
  expect(details[0].code).toBe(expected);
}

// ---------------------------------------------------------------------------
// decideOwnerScope
// ---------------------------------------------------------------------------

describe('CrashService.WatchCrashLog — decideOwnerScope (Task #472)', () => {
  it('UNSPECIFIED maps to own (treated as OWN per crash.proto comment)', () => {
    expect(decideOwnerScope(OwnerFilter.UNSPECIFIED)).toEqual({ kind: 'own' });
  });
  it('OWN maps to own', () => {
    expect(decideOwnerScope(OwnerFilter.OWN)).toEqual({ kind: 'own' });
  });
  it('ALL maps to reject_permission_denied (spec ch15 §3 #14)', () => {
    expect(decideOwnerScope(OwnerFilter.ALL)).toEqual({
      kind: 'reject_permission_denied',
    });
  });
  it('unknown enum maps to reject_permission_denied (forward-compat conservative deny)', () => {
    expect(decideOwnerScope(99 as unknown as OwnerFilter)).toEqual({
      kind: 'reject_permission_denied',
    });
  });
});

// ---------------------------------------------------------------------------
// isVisibleToCaller
// ---------------------------------------------------------------------------

describe('CrashService.WatchCrashLog — isVisibleToCaller (Task #472)', () => {
  it('OWN scope: entry owned by caller is visible', () => {
    const e = entry({ id: '1', owner_id: ALICE_KEY });
    expect(isVisibleToCaller(e, { kind: 'own' }, ALICE_KEY)).toBe(true);
  });
  it('OWN scope: entry owned by DAEMON_SELF is visible (ch09 §1 sentinel)', () => {
    const e = entry({ id: '2', owner_id: DAEMON_SELF });
    expect(isVisibleToCaller(e, { kind: 'own' }, ALICE_KEY)).toBe(true);
  });
  it('OWN scope: entry owned by another principal is hidden', () => {
    const e = entry({ id: '3', owner_id: BOB_KEY });
    expect(isVisibleToCaller(e, { kind: 'own' }, ALICE_KEY)).toBe(false);
  });
  it('reject_permission_denied scope hides everything (defensive — sink filtered first)', () => {
    const e = entry({ id: '4', owner_id: ALICE_KEY });
    expect(
      isVisibleToCaller(e, { kind: 'reject_permission_denied' }, ALICE_KEY),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rawEntryToProto
// ---------------------------------------------------------------------------

describe('CrashService.WatchCrashLog — rawEntryToProto (Task #472)', () => {
  it('copies labels (downstream proto mutation must not affect source)', () => {
    const src = entry({
      id: 'A',
      ts_ms: 42,
      owner_id: ALICE_KEY,
      labels: { k: 'v' },
    });
    const proto = rawEntryToProto(src);
    expect(proto.id).toBe('A');
    expect(proto.tsUnixMs).toBe(42n);
    expect(proto.labels).toEqual({ k: 'v' });
    // Mutate proto labels — source must not change.
    proto.labels.k = 'mutated';
    expect(src.labels.k).toBe('v');
  });
});

// ---------------------------------------------------------------------------
// subscribeAsAsyncIterable
// ---------------------------------------------------------------------------

describe('CrashService.WatchCrashLog — subscribeAsAsyncIterable (Task #472)', () => {
  it('default buffer size is 1024 (matches WatchSessions adapter)', () => {
    expect(DEFAULT_WATCH_BUFFER_SIZE).toBe(1024);
  });

  it('yields filtered events in emit order', async () => {
    const bus = new CrashEventBus();
    const iter = subscribeAsAsyncIterable(bus, {
      visible: () => true,
    })[Symbol.asyncIterator]();

    const e1 = entry({ id: '1', owner_id: ALICE_KEY });
    const e2 = entry({ id: '2', owner_id: ALICE_KEY });
    bus.emitCrashAdded(e1);
    bus.emitCrashAdded(e2);

    const r1 = await iter.next();
    const r2 = await iter.next();
    expect(r1.value?.id).toBe('1');
    expect(r2.value?.id).toBe('2');

    await iter.return?.(undefined);
    expect(bus.listenerCount()).toBe(0);
  });

  it('drops events at the boundary when visible() returns false (buffer never grows)', async () => {
    const bus = new CrashEventBus();
    const iter = subscribeAsAsyncIterable(bus, {
      visible: (e) => e.owner_id === ALICE_KEY,
      bufferSize: 2,
    })[Symbol.asyncIterator]();

    // Emit 5 invisible events — they MUST NOT exhaust the bufferSize=2 limit.
    for (let i = 0; i < 5; i++) {
      bus.emitCrashAdded(entry({ id: `bob${i}`, owner_id: BOB_KEY }));
    }
    // Now emit one visible event — should be readable.
    bus.emitCrashAdded(entry({ id: 'alice-1', owner_id: ALICE_KEY }));

    const r = await iter.next();
    expect(r.value?.id).toBe('alice-1');
    await iter.return?.(undefined);
  });

  it('overflow past bufferSize closes the stream with Code.ResourceExhausted', async () => {
    const bus = new CrashEventBus();
    const iter = subscribeAsAsyncIterable(bus, {
      visible: () => true,
      bufferSize: 2,
    })[Symbol.asyncIterator]();

    // Emit 3 events without consuming — bufferSize=2 should trip overflow on
    // the 3rd. Listener detaches itself when overflow fires.
    bus.emitCrashAdded(entry({ id: '1', owner_id: ALICE_KEY }));
    bus.emitCrashAdded(entry({ id: '2', owner_id: ALICE_KEY }));
    bus.emitCrashAdded(entry({ id: '3', owner_id: ALICE_KEY }));

    expect(bus.listenerCount()).toBe(0);

    // Drain the 2 buffered events first.
    const r1 = await iter.next();
    const r2 = await iter.next();
    expect(r1.value?.id).toBe('1');
    expect(r2.value?.id).toBe('2');

    // The 3rd next() throws the bufferError.
    let captured: unknown = null;
    try {
      await iter.next();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.ResourceExhausted);
  });

  it('aborted signal closes iterator with done:true and detaches listener', async () => {
    const bus = new CrashEventBus();
    const ac = new AbortController();
    const iter = subscribeAsAsyncIterable(bus, {
      visible: () => true,
      signal: ac.signal,
    })[Symbol.asyncIterator]();

    expect(bus.listenerCount()).toBe(1);

    // Pending next() then abort — should resolve with done:true.
    const pending = iter.next();
    ac.abort();
    const r = await pending;
    expect(r.done).toBe(true);
    expect(bus.listenerCount()).toBe(0);
  });

  it('pre-aborted signal yields done:true immediately and never subscribes', async () => {
    const bus = new CrashEventBus();
    const ac = new AbortController();
    ac.abort();
    const iter = subscribeAsAsyncIterable(bus, {
      visible: () => true,
      signal: ac.signal,
    })[Symbol.asyncIterator]();

    const r = await iter.next();
    expect(r.done).toBe(true);
    // Listener was attached then immediately removed by onAbort().
    expect(bus.listenerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// makeWatchCrashLogHandler — sink
// ---------------------------------------------------------------------------

describe('CrashService.WatchCrashLog — handler error mapping (Task #472)', () => {
  let bus: CrashEventBus;
  beforeEach(() => {
    bus = new CrashEventBus();
  });
  afterEach(() => {
    expect(bus.listenerCount()).toBe(0);
  });

  it('throws Code.Internal when PRINCIPAL_KEY is missing', async () => {
    const handler = makeWatchCrashLogHandler({ bus });
    const gen = handler(makeReq(), ctxWith(null))[Symbol.asyncIterator]();
    let captured: unknown = null;
    try {
      await gen.next();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.Internal);
  });

  it('rejects OwnerFilter.ALL with Code.PermissionDenied + session.not_owned', async () => {
    const handler = makeWatchCrashLogHandler({ bus });
    const gen = handler(makeReq(OwnerFilter.ALL), ctxWith(PRINCIPAL_ALICE))[
      Symbol.asyncIterator
    ]();
    let captured: unknown = null;
    try {
      await gen.next();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    const err = captured as ConnectError;
    expect(err.code).toBe(Code.PermissionDenied);
    expectErrorDetailCode(err, 'session.not_owned');
    const detail = (err.findDetails(ErrorDetailSchema) as ErrorDetail[])[0];
    expect(detail.extra.requested_owner_filter).toBe('ALL');
  });

  it('rejects unknown OwnerFilter enum with Code.PermissionDenied + session.not_owned', async () => {
    const handler = makeWatchCrashLogHandler({ bus });
    const gen = handler(
      makeReq(99 as unknown as OwnerFilter),
      ctxWith(PRINCIPAL_ALICE),
    )[Symbol.asyncIterator]();
    let captured: unknown = null;
    try {
      await gen.next();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    const err = captured as ConnectError;
    expect(err.code).toBe(Code.PermissionDenied);
    expectErrorDetailCode(err, 'session.not_owned');
    const detail = (err.findDetails(ErrorDetailSchema) as ErrorDetail[])[0];
    expect(detail.extra.requested_owner_filter).toBe('99');
  });
});

describe('CrashService.WatchCrashLog — handler happy path (Task #472)', () => {
  it('emits visible bus events as proto CrashEntry; abort closes generator cleanly', async () => {
    const bus = new CrashEventBus();
    const ac = new AbortController();
    const handler = makeWatchCrashLogHandler({ bus });
    const gen = handler(
      makeReq(OwnerFilter.OWN),
      ctxWith(PRINCIPAL_ALICE, ac.signal),
    )[Symbol.asyncIterator]();

    // Kick the generator (registers the bus listener) before emitting.
    const firstPending = gen.next();
    // Emit one alice event + one foreign event (filtered out).
    bus.emitCrashAdded(entry({ id: 'self-1', ts_ms: 7, owner_id: DAEMON_SELF }));
    bus.emitCrashAdded(entry({ id: 'bob-1', owner_id: BOB_KEY }));

    const first = await firstPending;
    expect(first.done).toBe(false);
    const v = first.value;
    expect(v).toBeDefined();
    expect(v?.id).toBe('self-1');
    expect(v?.tsUnixMs).toBe(7n);

    // Abort -> next() resolves done:true; bus listener detaches.
    const secondPending = gen.next();
    ac.abort();
    const second = await secondPending;
    expect(second.done).toBe(true);
    expect(bus.listenerCount()).toBe(0);
  });
});
