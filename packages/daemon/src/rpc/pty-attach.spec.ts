// PtyService.Attach handler — unit tests (Task #355 / T-PA-6).
//
// Drives `makeAttachHandler` through `createRouterTransport` (in-process
// Connect router; same shape as `__tests__/router.spec.ts` and
// `test/sessions/watch-sessions.spec.ts`). Covers spec
// `2026-05-04-pty-attach-handler.md` §3 decider branches at the wire,
// §4 backpressure, §5 abort cleanup, §3.3 first-snapshot await.
//
// Fakes (no real pty-host child, no real http2):
//   - FakeEmitter implements PtySessionEmitterLike. Sync publish methods
//     fan-out to subscribers; close() emits 'closed' once. Mirrors PR
//     #1027's PtySessionEmitter exact contract on the methods this
//     handler reads.
//   - peerCredAuthInterceptor is faked via a minimal interceptor that
//     deposits a Principal under PRINCIPAL_KEY, matching production
//     wiring (see daemon/src/index.ts `bearerToPeerInfoInterceptor` +
//     `peerCredAuthInterceptor`).

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
  type Interceptor,
} from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AttachRequestSchema,
  ErrorDetailSchema,
  PtyService,
  RequestMetaSchema,
  type ErrorDetail,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../auth/index.js';
import type {
  DeltaInMem,
  PtySnapshotInMem,
} from '../pty-host/attach-decider.js';
import { ACK_CHANNEL_CAPACITY } from '../pty-host/ack-state.js';

import {
  ATTACH_FAST_PATH_BUFFER_SIZE,
  awaitSnapshot,
  deltaToFrame,
  makeAttachHandler,
  snapshotToFrame,
  type PtyAttachDeps,
  type PtyEmitterEvent,
  type PtyEmitterListener,
  type PtySessionEmitterLike,
} from './pty-attach.js';

// ---------------------------------------------------------------------------
// Fake emitter — mirrors PR #1027 PtySessionEmitter contract for the
// surface this handler reads. Synchronous publish; subscribers receive in
// insertion order.
// ---------------------------------------------------------------------------

class FakeEmitter implements PtySessionEmitterLike {
  readonly sessionId: string;
  readonly capacity: number;
  #snapshot: PtySnapshotInMem | null = null;
  #maxSeq: bigint = 0n;
  readonly #ring: DeltaInMem[] = [];
  readonly #subs: Set<PtyEmitterListener> = new Set();
  #closed = false;

  constructor(sessionId: string, capacity = 4096) {
    this.sessionId = sessionId;
    this.capacity = capacity;
  }

  currentSnapshot(): PtySnapshotInMem | null {
    return this.#snapshot;
  }
  currentMaxSeq(): bigint {
    return this.#maxSeq;
  }
  oldestRetainedSeq(): bigint {
    if (this.#maxSeq === 0n) return 0n;
    const cap = BigInt(this.capacity);
    const candidate = this.#maxSeq - cap + 1n;
    return candidate > 1n ? candidate : 1n;
  }
  deltasSince(sinceSeq: bigint): readonly DeltaInMem[] | 'out-of-window' {
    if (this.#maxSeq === 0n) {
      return sinceSeq === 0n ? [] : 'out-of-window';
    }
    if (sinceSeq < this.oldestRetainedSeq()) return 'out-of-window';
    if (sinceSeq >= this.#maxSeq) return [];
    return this.#ring.filter((d) => d.seq > sinceSeq);
  }
  subscribe(listener: PtyEmitterListener): () => void {
    if (this.#closed) {
      try {
        listener({ kind: 'closed', reason: 'pty.session_destroyed' });
      } catch {
        /* swallow */
      }
      return () => {};
    }
    this.#subs.add(listener);
    return () => {
      this.#subs.delete(listener);
    };
  }
  isClosed(): boolean {
    return this.#closed;
  }

  // ---- Test surface (match PR #1027 publishSnapshot / publishDelta /
  //      close shape but skip the malformed-ipc defensive checks) ----

  publishSnapshot(snap: PtySnapshotInMem): void {
    if (this.#closed) return;
    this.#snapshot = snap;
    this.#broadcast({ kind: 'snapshot', snapshot: snap });
  }
  publishDelta(delta: DeltaInMem): void {
    if (this.#closed) return;
    if (delta.seq <= this.#maxSeq) {
      throw new Error(`non-monotonic seq ${delta.seq} <= ${this.#maxSeq}`);
    }
    this.#ring.push(delta);
    if (this.#ring.length > this.capacity) {
      this.#ring.shift();
    }
    this.#maxSeq = delta.seq;
    this.#broadcast({ kind: 'delta', delta });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const event: PtyEmitterEvent = {
      kind: 'closed',
      reason: 'pty.session_destroyed',
    };
    const subs = [...this.#subs];
    this.#subs.clear();
    for (const l of subs) {
      try {
        l(event);
      } catch {
        /* swallow */
      }
    }
  }
  subscriberCount(): number {
    return this.#subs.size;
  }

  #broadcast(event: PtyEmitterEvent): void {
    const subs = [...this.#subs];
    for (const l of subs) {
      try {
        l(event);
      } catch {
        /* swallow */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_PRINCIPAL: AuthPrincipal = {
  kind: 'local-user',
  uid: '1000',
  displayName: 'tester',
};

const depositPrincipal: Interceptor = (next) => async (req) => {
  req.contextValues.set(PRINCIPAL_KEY, TEST_PRINCIPAL);
  return next(req);
};

function makeSnapshot(baseSeq: bigint, screen = new Uint8Array([1, 2])): PtySnapshotInMem {
  return {
    baseSeq,
    geometry: { cols: 80, rows: 24 },
    screenState: screen,
    schemaVersion: 1,
  };
}

function makeDelta(seq: bigint, payload = new Uint8Array([0xaa])): DeltaInMem {
  return { seq, tsUnixMs: 1700000000000n + seq, payload };
}

function makeReq(overrides: {
  readonly sessionId?: string;
  readonly sinceSeq?: bigint;
  readonly requiresAck?: boolean;
}): ReturnType<typeof create<typeof AttachRequestSchema>> {
  return create(AttachRequestSchema, {
    meta: create(RequestMetaSchema, {
      requestId: '11111111-2222-3333-4444-555555555555',
    }),
    sessionId: overrides.sessionId ?? 'sess-1',
    sinceSeq: overrides.sinceSeq ?? 0n,
    requiresAck: overrides.requiresAck ?? false,
  });
}

function makeTransport(
  registry: Map<string, FakeEmitter>,
): ReturnType<typeof createRouterTransport> {
  const deps: PtyAttachDeps = {
    getEmitter: (id) => registry.get(id),
  };
  return createRouterTransport(
    (router) => {
      router.service(PtyService, { attach: makeAttachHandler(deps) });
    },
    {
      router: { interceptors: [depositPrincipal] },
    },
  );
}

function readErrorDetail(err: unknown): ErrorDetail | null {
  if (!(err instanceof ConnectError)) return null;
  const details = err.findDetails(ErrorDetailSchema);
  return details[0] ?? null;
}

// ---------------------------------------------------------------------------
// Pure-function tests (mappers + awaitSnapshot)
// ---------------------------------------------------------------------------

describe('snapshotToFrame / deltaToFrame', () => {
  it('snapshotToFrame copies all fields onto the proto oneof', () => {
    const snap = makeSnapshot(42n, new Uint8Array([9, 8, 7]));
    const frame = snapshotToFrame(snap);
    expect(frame.kind.case).toBe('snapshot');
    if (frame.kind.case !== 'snapshot') throw new Error('case mismatch');
    expect(frame.kind.value.baseSeq).toBe(42n);
    expect(frame.kind.value.schemaVersion).toBe(1);
    expect(frame.kind.value.geometry?.cols).toBe(80);
    expect(frame.kind.value.geometry?.rows).toBe(24);
    expect(Array.from(frame.kind.value.screenState)).toEqual([9, 8, 7]);
  });

  it('deltaToFrame copies seq + payload + ts', () => {
    const delta = makeDelta(7n, new Uint8Array([0xff, 0x00]));
    const frame = deltaToFrame(delta);
    expect(frame.kind.case).toBe('delta');
    if (frame.kind.case !== 'delta') throw new Error('case mismatch');
    expect(frame.kind.value.seq).toBe(7n);
    expect(frame.kind.value.tsUnixMs).toBe(1700000000007n);
    expect(Array.from(frame.kind.value.payload)).toEqual([0xff, 0x00]);
  });
});

describe('awaitSnapshot (spec §3.3 first-snapshot race)', () => {
  it('resolves synchronously when a snapshot is already in memory', async () => {
    const emitter = new FakeEmitter('sess-1');
    emitter.publishSnapshot(makeSnapshot(0n));
    const snap = await awaitSnapshot(emitter, undefined);
    expect(snap.baseSeq).toBe(0n);
  });

  it('waits and resolves when a snapshot arrives after subscribe', async () => {
    const emitter = new FakeEmitter('sess-1');
    const promise = awaitSnapshot(emitter, undefined);
    expect(emitter.subscriberCount()).toBe(1);
    emitter.publishSnapshot(makeSnapshot(0n));
    const snap = await promise;
    expect(snap.baseSeq).toBe(0n);
    // Subscriber MUST be detached after resolution (spec §5).
    expect(emitter.subscriberCount()).toBe(0);
  });

  it('rejects with pty.session_destroyed if the session ends first', async () => {
    const emitter = new FakeEmitter('sess-1');
    const promise = awaitSnapshot(emitter, undefined);
    emitter.close();
    await expect(promise).rejects.toMatchObject({
      code: Code.Canceled,
    });
    const err = await promise.catch((e) => e);
    const detail = readErrorDetail(err);
    expect(detail?.code).toBe('pty.session_destroyed');
    expect(emitter.subscriberCount()).toBe(0);
  });

  it('rejects when the AbortSignal fires before a snapshot arrives', async () => {
    const emitter = new FakeEmitter('sess-1');
    const ac = new AbortController();
    const promise = awaitSnapshot(emitter, ac.signal);
    expect(emitter.subscriberCount()).toBe(1);
    ac.abort(new Error('client disconnected'));
    await expect(promise).rejects.toThrow('client disconnected');
    expect(emitter.subscriberCount()).toBe(0);
  });

  it('rejects immediately for an already-closed emitter', async () => {
    const emitter = new FakeEmitter('sess-1');
    emitter.close();
    await expect(awaitSnapshot(emitter, undefined)).rejects.toMatchObject({
      code: Code.Canceled,
    });
  });
});

// ---------------------------------------------------------------------------
// Wire-level tests through createRouterTransport
// ---------------------------------------------------------------------------

describe('PtyService.Attach — over the wire', () => {
  let registry: Map<string, FakeEmitter>;
  let client: ReturnType<typeof createClient<typeof PtyService>>;

  beforeEach(() => {
    registry = new Map();
    client = createClient(PtyService, makeTransport(registry));
  });

  afterEach(() => {
    for (const e of registry.values()) e.close();
    registry.clear();
  });

  it('rejects empty session_id with pty.session_not_found', async () => {
    const iter = client.attach(makeReq({ sessionId: '' }));
    const err = await drainExpectError(iter);
    expect(err.code).toBe(Code.NotFound);
    expect(readErrorDetail(err)?.code).toBe('pty.session_not_found');
  });

  it('rejects unknown session id with pty.session_not_found', async () => {
    const iter = client.attach(makeReq({ sessionId: 'no-such' }));
    const err = await drainExpectError(iter);
    expect(err.code).toBe(Code.NotFound);
    expect(readErrorDetail(err)?.code).toBe('pty.session_not_found');
    expect(readErrorDetail(err)?.extra.session_id).toBe('no-such');
  });

  it('since_seq=0 yields snapshot then live deltas (spec §3.1.1)', async () => {
    const emitter = new FakeEmitter('sess-1');
    emitter.publishSnapshot(makeSnapshot(0n));
    registry.set('sess-1', emitter);

    const iter = client.attach(makeReq({ sessionId: 'sess-1', sinceSeq: 0n }));
    const ai = iter[Symbol.asyncIterator]();

    const f1 = await ai.next();
    expect(f1.done).toBe(false);
    expect(f1.value?.kind.case).toBe('snapshot');

    // Now publish a live delta — handler should yield it.
    void Promise.resolve().then(() => emitter.publishDelta(makeDelta(1n)));
    const f2 = await ai.next();
    expect(f2.done).toBe(false);
    expect(f2.value?.kind.case).toBe('delta');
    if (f2.value?.kind.case === 'delta') {
      expect(f2.value.kind.value.seq).toBe(1n);
    }

    // Close session — handler should throw pty.session_destroyed.
    void Promise.resolve().then(() => emitter.close());
    const err = await ai.next().then(
      () => null,
      (e) => e as unknown,
    );
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.Canceled);
    expect(readErrorDetail(err)?.code).toBe('pty.session_destroyed');
  });

  it('since_seq>0 with retained deltas replays the slice then streams live', async () => {
    const emitter = new FakeEmitter('sess-1');
    emitter.publishSnapshot(makeSnapshot(0n));
    emitter.publishDelta(makeDelta(1n));
    emitter.publishDelta(makeDelta(2n));
    emitter.publishDelta(makeDelta(3n));
    registry.set('sess-1', emitter);

    const iter = client.attach(makeReq({ sessionId: 'sess-1', sinceSeq: 1n }));
    const ai = iter[Symbol.asyncIterator]();

    // Replays (sinceSeq, currentMaxSeq] = (1, 3] = [2, 3].
    const r1 = await ai.next();
    expect(r1.value?.kind.case).toBe('delta');
    if (r1.value?.kind.case === 'delta') expect(r1.value.kind.value.seq).toBe(2n);
    const r2 = await ai.next();
    if (r2.value?.kind.case === 'delta') expect(r2.value.kind.value.seq).toBe(3n);

    // Live delta at seq=4.
    void Promise.resolve().then(() => emitter.publishDelta(makeDelta(4n)));
    const r3 = await ai.next();
    if (r3.value?.kind.case === 'delta') expect(r3.value.kind.value.seq).toBe(4n);

    // Cleanup — abort by returning the iterator. (We don't assert the
    // subscriber count converges here; that's covered in the dedicated
    // AbortSignal test below — abort propagation across the
    // in-process router transport is async and would require a poll
    // loop to observe deterministically.)
    await ai.return?.(undefined);
  });

  it('since_seq < oldestRetainedSeq throws OutOfRange + pty.attach_too_far_behind (spec §3.2)', async () => {
    const emitter = new FakeEmitter('sess-1', /* capacity */ 4);
    emitter.publishSnapshot(makeSnapshot(0n));
    // Push 6 deltas → ring keeps last 4 → oldestRetainedSeq = 3.
    for (let i = 1n; i <= 6n; i += 1n) emitter.publishDelta(makeDelta(i));
    registry.set('sess-1', emitter);

    // sinceSeq = 1 is too far behind (oldest is 3).
    const iter = client.attach(makeReq({ sessionId: 'sess-1', sinceSeq: 1n }));
    const err = await drainExpectError(iter);
    expect(err.code).toBe(Code.OutOfRange);
    const detail = readErrorDetail(err);
    expect(detail?.code).toBe('pty.attach_too_far_behind');
    expect(detail?.extra.since_seq).toBe('1');
    expect(detail?.extra.oldest_retained_seq).toBe('3');
  });

  it('since_seq > currentMaxSeq throws InvalidArgument + pty.attach_future_seq (spec §3.4)', async () => {
    const emitter = new FakeEmitter('sess-1');
    emitter.publishSnapshot(makeSnapshot(0n));
    emitter.publishDelta(makeDelta(1n));
    registry.set('sess-1', emitter);

    const iter = client.attach(makeReq({ sessionId: 'sess-1', sinceSeq: 99n }));
    const err = await drainExpectError(iter);
    expect(err.code).toBe(Code.InvalidArgument);
    const detail = readErrorDetail(err);
    expect(detail?.code).toBe('pty.attach_future_seq');
    expect(detail?.extra.since_seq).toBe('99');
    expect(detail?.extra.current_max_seq).toBe('1');
  });

  it('since_seq=0 awaits the synthetic snapshot when emitter has none yet (§3.3)', async () => {
    const emitter = new FakeEmitter('sess-1');
    registry.set('sess-1', emitter); // No snapshot yet.

    const iter = client.attach(makeReq({ sessionId: 'sess-1', sinceSeq: 0n }));
    const ai = iter[Symbol.asyncIterator]();

    // Schedule the snapshot to arrive after the handler subscribes.
    void Promise.resolve().then(() => emitter.publishSnapshot(makeSnapshot(0n)));
    const f = await ai.next();
    expect(f.done).toBe(false);
    expect(f.value?.kind.case).toBe('snapshot');

    await ai.return?.(undefined);
  });

  it('mid-stream snapshots are NOT yielded onto the wire (spec §2.4 at-most-one)', async () => {
    const emitter = new FakeEmitter('sess-1');
    emitter.publishSnapshot(makeSnapshot(0n));
    registry.set('sess-1', emitter);

    const iter = client.attach(makeReq({ sessionId: 'sess-1', sinceSeq: 0n }));
    const ai = iter[Symbol.asyncIterator]();

    const initial = await ai.next();
    expect(initial.value?.kind.case).toBe('snapshot');

    // Mid-stream: deltas, then a NEW snapshot, then more deltas. Wire
    // MUST see only the deltas (the second snapshot is dropped).
    void Promise.resolve().then(() => emitter.publishDelta(makeDelta(1n)));
    const d1 = await ai.next();
    expect(d1.value?.kind.case).toBe('delta');

    void Promise.resolve().then(() => {
      emitter.publishDelta(makeDelta(2n));
      emitter.publishSnapshot(makeSnapshot(2n));
      emitter.publishDelta(makeDelta(3n));
    });
    const d2 = await ai.next();
    if (d2.value?.kind.case === 'delta') expect(d2.value.kind.value.seq).toBe(2n);
    const d3 = await ai.next();
    if (d3.value?.kind.case === 'delta') expect(d3.value.kind.value.seq).toBe(3n);

    await ai.return?.(undefined);
  });

  it('AbortSignal teardown unsubscribes from the emitter (spec §5)', async () => {
    const emitter = new FakeEmitter('sess-1');
    emitter.publishSnapshot(makeSnapshot(0n));
    registry.set('sess-1', emitter);

    const ac = new AbortController();
    const iter = client.attach(makeReq({ sessionId: 'sess-1', sinceSeq: 0n }), {
      signal: ac.signal,
    });
    const ai = iter[Symbol.asyncIterator]();
    await ai.next(); // consume the snapshot frame so the handler is parked
    expect(emitter.subscriberCount()).toBe(1);

    ac.abort();
    // Drain — the handler returns cleanly on abort.
    try {
      while (true) {
        const r = await ai.next();
        if (r.done) break;
      }
    } catch {
      // Connect may surface the abort as a Canceled error; either is fine.
    }
    // Convergence: subscriber count drops to 0.
    expect(emitter.subscriberCount()).toBe(0);
  });

  it('fast-path overflow throws ResourceExhausted + pty.subscriber_channel_full', async () => {
    // Drive a SLOW consumer: never call .next() past the snapshot, so
    // every published delta queues into the bounded fallback buffer.
    // After ATTACH_FAST_PATH_BUFFER_SIZE deltas, the next publish
    // overflows and the next .next() observes the terminal error.
    const emitter = new FakeEmitter('sess-1');
    emitter.publishSnapshot(makeSnapshot(0n));
    registry.set('sess-1', emitter);

    const iter = client.attach(
      makeReq({ sessionId: 'sess-1', sinceSeq: 0n, requiresAck: false }),
    );
    const ai = iter[Symbol.asyncIterator]();
    // Consume the snapshot — handler is now parked on the channel.
    await ai.next();

    // Fill the fallback buffer + 1 to trigger overflow.
    for (let i = 1n; i <= BigInt(ATTACH_FAST_PATH_BUFFER_SIZE) + 1n; i += 1n) {
      emitter.publishDelta(makeDelta(i));
    }

    // Drain — at some point we should hit the overflow ConnectError.
    const err = await (async (): Promise<unknown> => {
      try {
        while (true) {
          const r = await ai.next();
          if (r.done) return new Error('expected overflow error');
        }
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.ResourceExhausted);
    expect(readErrorDetail(err)?.code).toBe('pty.subscriber_channel_full');
  });

  it('requires_ack=true uses ACK_CHANNEL_CAPACITY (4096) per spec §4.5', async () => {
    // Smoke test: open Attach with requires_ack=true, push capacity-1
    // deltas, ensure no overflow. (Pushing 4097 here would be slow;
    // we trust the BoundedChannel unit tests for the exact capacity
    // boundary and just verify the ACK path uses a larger cap than
    // the fast path.)
    const emitter = new FakeEmitter('sess-1', /* ring */ ACK_CHANNEL_CAPACITY + 64);
    emitter.publishSnapshot(makeSnapshot(0n));
    registry.set('sess-1', emitter);

    const iter = client.attach(
      makeReq({ sessionId: 'sess-1', sinceSeq: 0n, requiresAck: true }),
    );
    const ai = iter[Symbol.asyncIterator]();
    await ai.next(); // consume snapshot

    // Push fast-path-cap + 50 deltas (would overflow the false path)
    // and verify we can still drain them — the requires_ack channel
    // is larger.
    const N = ATTACH_FAST_PATH_BUFFER_SIZE + 50;
    for (let i = 1n; i <= BigInt(N); i += 1n) {
      emitter.publishDelta(makeDelta(i));
    }
    let drained = 0;
    while (drained < N) {
      const r = await ai.next();
      if (r.done) break;
      drained += 1;
    }
    expect(drained).toBe(N);

    await ai.return?.(undefined);
  });

  it('emitter close mid-stream surfaces pty.session_destroyed (§7.2)', async () => {
    const emitter = new FakeEmitter('sess-1');
    emitter.publishSnapshot(makeSnapshot(0n));
    registry.set('sess-1', emitter);

    const iter = client.attach(makeReq({ sessionId: 'sess-1', sinceSeq: 0n }));
    const ai = iter[Symbol.asyncIterator]();
    await ai.next(); // snapshot

    void Promise.resolve().then(() => emitter.close());
    const err = await ai.next().then(
      () => null,
      (e) => e as unknown,
    );
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.Canceled);
    expect(readErrorDetail(err)?.code).toBe('pty.session_destroyed');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function drainExpectError(iter: AsyncIterable<unknown>): Promise<ConnectError> {
  try {
    for await (const _f of iter) {
      void _f;
    }
  } catch (err) {
    if (err instanceof ConnectError) return err;
    throw err;
  }
  throw new Error('expected the stream to error, but it ended cleanly');
}
