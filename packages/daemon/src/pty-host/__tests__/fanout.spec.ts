// Per-session subscriber fanout + per-subscriber ack backlog — Task #49 / T4.13.
//
// Spec ref: docs/superpowers/specs/2026-05-04-pty-attach-handler.md
//   §2.3 (per-session emitter fan-out to subscribers)
//   §4.2 (AckSubscriberState shape)
//   §4.3 (channel.size at ACK_CHANNEL_CAPACITY (== 4096) ⇒ overflow ⇒
//         RESOURCE_EXHAUSTED to the wire)
//   §6.1 / §6.2 (subscriber registry lookup by (principalKey, sessionId))
//
// What this file covers (in addition to the existing unit tests in
// `ack-state.spec.ts` and `pty-attach.spec.ts`):
//
//   1. `PtySessionEmitter` fans every `publishDelta` to EVERY live
//      subscriber synchronously (the per-session subscriber broadcast
//      contract that this task wires the Attach handler into).
//
//   2. `BoundedChannel(ACK_CHANNEL_CAPACITY)` accepts exactly 4096
//      enqueues and the 4097th returns `'overflow'` — the
//      load-bearing primitive behind the §4.3 RESOURCE_EXHAUSTED
//      mapping. Pinning this at the unit level keeps the constant
//      from drifting silently (changing `ACK_CHANNEL_CAPACITY` without
//      re-tuning the in-memory ring would break the
//      "kick + reconnect on overflow" recovery invariant per spec
//      §4.5).
//
//   3. Subscriber registry round-trip — Attach handler registers a
//      live `AckSubscriberState` under `(principalKey, sessionId)` and
//      the AckPty handler can find it via `findFirstAckSubscriber`.
//      After unregister, the lookup returns `undefined` (the §6.2
//      no-op path the AckPty handler relies on).

import { afterEach, describe, expect, it } from 'vitest';

import {
  ACK_CHANNEL_CAPACITY,
  AckSubscriberState,
  BoundedChannel,
  findFirstAckSubscriber,
  registerAckSubscriber,
  resetAckSubscriberRegistry,
  unregisterAckSubscriber,
} from '../ack-state.js';
import {
  PtySessionEmitter,
  resetEmitterRegistry,
  type PtyEvent,
} from '../pty-emitter.js';
import type { DeltaMessage, SnapshotMessage } from '../types.js';

afterEach(() => {
  resetEmitterRegistry();
  resetAckSubscriberRegistry();
});

function makeSnapshotIpc(baseSeq: bigint): SnapshotMessage {
  return {
    kind: 'snapshot',
    baseSeq,
    geometry: { cols: 80, rows: 24 },
    screenState: new Uint8Array(0),
    schemaVersion: 1,
  };
}
function makeDeltaIpc(seq: bigint, payload = new Uint8Array([0xab])): DeltaMessage {
  return {
    kind: 'delta',
    seq,
    tsUnixMs: 1700000000000n + seq,
    payload,
  };
}

// ---------------------------------------------------------------------------
// 1. PtySessionEmitter — per-session subscriber fan-out
// ---------------------------------------------------------------------------

describe('PtySessionEmitter — per-session subscriber fan-out', () => {
  it('publishDelta synchronously broadcasts to every live subscriber', () => {
    const emitter = new PtySessionEmitter('sess-fanout-1');
    const eventsA: PtyEvent[] = [];
    const eventsB: PtyEvent[] = [];
    const eventsC: PtyEvent[] = [];

    emitter.subscribe((e) => eventsA.push(e));
    emitter.subscribe((e) => eventsB.push(e));
    emitter.subscribe((e) => eventsC.push(e));

    expect(emitter.subscriberCount()).toBe(3);

    emitter.publishSnapshot(makeSnapshotIpc(0n));
    emitter.publishDelta(makeDeltaIpc(1n));
    emitter.publishDelta(makeDeltaIpc(2n));

    for (const events of [eventsA, eventsB, eventsC]) {
      expect(events).toHaveLength(3);
      expect(events[0]?.kind).toBe('snapshot');
      expect(events[1]?.kind).toBe('delta');
      expect(events[2]?.kind).toBe('delta');
    }
  });

  it('unsubscribed listeners stop receiving events; remaining subscribers unaffected', () => {
    const emitter = new PtySessionEmitter('sess-fanout-2');
    const eventsA: PtyEvent[] = [];
    const eventsB: PtyEvent[] = [];

    const unsubA = emitter.subscribe((e) => eventsA.push(e));
    emitter.subscribe((e) => eventsB.push(e));

    emitter.publishDelta(makeDeltaIpc(1n));
    unsubA();
    emitter.publishDelta(makeDeltaIpc(2n));

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(2);
    expect(emitter.subscriberCount()).toBe(1);
  });

  it('close() broadcasts the terminal "closed" event to every subscriber exactly once', () => {
    const emitter = new PtySessionEmitter('sess-fanout-3');
    const eventsA: PtyEvent[] = [];
    const eventsB: PtyEvent[] = [];
    emitter.subscribe((e) => eventsA.push(e));
    emitter.subscribe((e) => eventsB.push(e));

    emitter.close();
    expect(emitter.isClosed()).toBe(true);
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect(eventsA[0]?.kind).toBe('closed');
    expect(eventsB[0]?.kind).toBe('closed');

    // Idempotent: a second close does NOT re-broadcast.
    emitter.close();
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);

    // Subsequent publish* calls are no-ops on a closed emitter.
    emitter.publishDelta(makeDeltaIpc(1n));
    expect(eventsA).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. BoundedChannel — backlog>4096 ⇒ 'overflow' (RESOURCE_EXHAUSTED at wire)
// ---------------------------------------------------------------------------

describe('BoundedChannel(ACK_CHANNEL_CAPACITY) — §4.3 overflow', () => {
  it('ACK_CHANNEL_CAPACITY is the spec-pinned 4096', () => {
    expect(ACK_CHANNEL_CAPACITY).toBe(4096);
  });

  it('accepts exactly ACK_CHANNEL_CAPACITY enqueues; the next call returns "overflow"', () => {
    const channel = new BoundedChannel<number>(ACK_CHANNEL_CAPACITY);
    for (let i = 0; i < ACK_CHANNEL_CAPACITY; i += 1) {
      expect(channel.enqueue(i)).toBe('ok');
    }
    expect(channel.size).toBe(ACK_CHANNEL_CAPACITY);
    expect(channel.isFull).toBe(true);
    expect(channel.enqueue(99999)).toBe('overflow');
    // Overflow does NOT mutate the channel — size unchanged.
    expect(channel.size).toBe(ACK_CHANNEL_CAPACITY);
  });

  it('after one dequeue the channel accepts one more enqueue (FIFO recovery)', () => {
    const channel = new BoundedChannel<number>(ACK_CHANNEL_CAPACITY);
    for (let i = 0; i < ACK_CHANNEL_CAPACITY; i += 1) {
      channel.enqueue(i);
    }
    expect(channel.enqueue(0)).toBe('overflow');
    expect(channel.dequeue()).toBe(0); // FIFO head
    expect(channel.size).toBe(ACK_CHANNEL_CAPACITY - 1);
    expect(channel.enqueue(ACK_CHANNEL_CAPACITY)).toBe('ok');
    expect(channel.size).toBe(ACK_CHANNEL_CAPACITY);
  });
});

// ---------------------------------------------------------------------------
// 3. AckSubscriberState — backlog math at the §4.3 boundary
// ---------------------------------------------------------------------------

describe('AckSubscriberState — backlog at the §4.3 boundary', () => {
  it('unackedBacklog equals capacity when the subscriber has delivered ACK_CHANNEL_CAPACITY frames without ack', () => {
    const sub = new AckSubscriberState({
      subscriberId: 'sub-1',
      sessionId: 'sess-1',
      initialSeq: 0n,
    });
    for (let i = 1; i <= ACK_CHANNEL_CAPACITY; i += 1) {
      sub.onDelivered(BigInt(i));
    }
    expect(sub.lastDeliveredSeq).toBe(BigInt(ACK_CHANNEL_CAPACITY));
    expect(sub.lastAckedSeq).toBe(0n);
    expect(sub.unackedBacklog).toBe(BigInt(ACK_CHANNEL_CAPACITY));
  });

  it('after a full ack of the 4096th delivered frame backlog returns to zero', () => {
    const sub = new AckSubscriberState({
      subscriberId: 'sub-2',
      sessionId: 'sess-2',
      initialSeq: 0n,
    });
    for (let i = 1; i <= ACK_CHANNEL_CAPACITY; i += 1) {
      sub.onDelivered(BigInt(i));
    }
    const verdict = sub.onAck(BigInt(ACK_CHANNEL_CAPACITY));
    expect(verdict.kind).toBe('ok');
    expect(sub.unackedBacklog).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// 4. Per-(principalKey, sessionId) subscriber registry round-trip
// ---------------------------------------------------------------------------

describe('subscriber registry — register / lookup / unregister', () => {
  it('registerAckSubscriber + findFirstAckSubscriber round-trip', () => {
    const sub = new AckSubscriberState({
      subscriberId: 'sub-3',
      sessionId: 'sess-reg-1',
      initialSeq: 0n,
    });
    expect(findFirstAckSubscriber('local-user:1000', 'sess-reg-1')).toBeUndefined();
    registerAckSubscriber('local-user:1000', sub);
    expect(findFirstAckSubscriber('local-user:1000', 'sess-reg-1')).toBe(sub);
    // Different principal — same sessionId — does NOT match.
    expect(findFirstAckSubscriber('local-user:2000', 'sess-reg-1')).toBeUndefined();
    // Different sessionId — same principal — does NOT match.
    expect(findFirstAckSubscriber('local-user:1000', 'sess-other')).toBeUndefined();
  });

  it('multiple subscribers under the same key yield insertion order (spec §6.1 "FIRST matching")', () => {
    const subA = new AckSubscriberState({
      subscriberId: 'a',
      sessionId: 'sess-multi',
      initialSeq: 0n,
    });
    const subB = new AckSubscriberState({
      subscriberId: 'b',
      sessionId: 'sess-multi',
      initialSeq: 0n,
    });
    registerAckSubscriber('local-user:1000', subA);
    registerAckSubscriber('local-user:1000', subB);
    expect(findFirstAckSubscriber('local-user:1000', 'sess-multi')).toBe(subA);

    // Removing the first promotes the second.
    expect(unregisterAckSubscriber('local-user:1000', subA)).toBe(true);
    expect(findFirstAckSubscriber('local-user:1000', 'sess-multi')).toBe(subB);

    // Removing the second clears the bucket entirely.
    expect(unregisterAckSubscriber('local-user:1000', subB)).toBe(true);
    expect(findFirstAckSubscriber('local-user:1000', 'sess-multi')).toBeUndefined();
  });

  it('unregister is idempotent — removing twice returns false the second time', () => {
    const sub = new AckSubscriberState({
      subscriberId: 'sub-x',
      sessionId: 'sess-idem',
      initialSeq: 0n,
    });
    registerAckSubscriber('local-user:1000', sub);
    expect(unregisterAckSubscriber('local-user:1000', sub)).toBe(true);
    expect(unregisterAckSubscriber('local-user:1000', sub)).toBe(false);
  });
});
