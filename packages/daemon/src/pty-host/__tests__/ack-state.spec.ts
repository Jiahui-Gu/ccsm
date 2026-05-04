// Unit tests for ack-state.ts (Task #352, T-PA-3 / T-PA-4 ack-state slice).
//
// Spec ref: docs/superpowers/specs/2026-05-04-pty-attach-handler.md
// §4.2 (per-subscriber state shape) / §4.3 (overflow trigger) / §4.5
// (capacity == DELTA_RETENTION_SEQS == 4096) / §6.1 (ack validation).
//
// Coverage matrix (one assertion per spec invariant):
//   BoundedChannel
//     - construction validates capacity (positive integer)
//     - default capacity matches ACK_CHANNEL_CAPACITY (4096) per §4.5
//     - enqueue under cap returns 'ok', size accounting correct
//     - enqueue at cap returns 'overflow' WITHOUT mutating channel
//       (§4.3 producer-side: must distinguish from silent drop)
//     - dequeue returns FIFO order
//     - dequeue from empty returns undefined
//     - peek returns head without removing
//     - clear empties the channel
//     - enqueueDroppingOldest drops head when full, returns dropped item
//       (separate primitive used by emitter ring per code comment;
//        validates the "drop old entry" path the task spec named)
//   AckSubscriberState
//     - initial state: lastDelivered == lastAcked == initialSeq;
//                      unackedBacklog == 0
//     - onDelivered advances lastDeliveredSeq; backlog math correct
//     - onDelivered rejects non-monotonic seq (throws — handler bug)
//     - onAck advances lastAckedSeq for in-window ack
//     - onAck idempotent for repeated equal ack (§6.1: benign retry)
//     - onAck returns 'pty.ack_overrun' when applied_seq > lastDelivered
//     - onAck returns 'pty.ack_regress' when applied_seq < lastAcked
//     - rejected acks DO NOT mutate state
//     - channel attached at construction with requested capacity

import { describe, expect, it } from 'vitest';

import {
  ACK_CHANNEL_CAPACITY,
  AckSubscriberState,
  BoundedChannel,
  type DeltaEnvelope,
} from '../ack-state.js';

function makeDelta(seq: bigint, byte = 0): DeltaEnvelope {
  return {
    seq,
    tsUnixMs: 1_700_000_000_000n + seq,
    payload: new Uint8Array([byte]),
  };
}

describe('ACK_CHANNEL_CAPACITY', () => {
  it('equals DELTA_RETENTION_SEQS = 4096 per spec §4.5', () => {
    // This is a forever-stable invariant: changing it without also
    // changing DELTA_RETENTION_SEQS breaks the kick+reconnect recovery
    // contract. The `as const` literal type catches accidental drift.
    expect(ACK_CHANNEL_CAPACITY).toBe(4096);
  });
});

describe('BoundedChannel — construction', () => {
  it('rejects zero capacity', () => {
    expect(() => new BoundedChannel(0)).toThrow(RangeError);
  });

  it('rejects negative capacity', () => {
    expect(() => new BoundedChannel(-1)).toThrow(RangeError);
  });

  it('rejects non-integer capacity', () => {
    expect(() => new BoundedChannel(1.5)).toThrow(RangeError);
  });

  it('defaults to ACK_CHANNEL_CAPACITY when no arg given', () => {
    const ch = new BoundedChannel<number>();
    expect(ch.capacity).toBe(ACK_CHANNEL_CAPACITY);
    expect(ch.size).toBe(0);
    expect(ch.isEmpty).toBe(true);
    expect(ch.isFull).toBe(false);
  });

  it('honors custom capacity', () => {
    const ch = new BoundedChannel<number>(8);
    expect(ch.capacity).toBe(8);
  });
});

describe('BoundedChannel — enqueue / dequeue FIFO behavior', () => {
  it('enqueue under cap returns ok and tracks size', () => {
    const ch = new BoundedChannel<number>(3);
    expect(ch.enqueue(1)).toBe('ok');
    expect(ch.size).toBe(1);
    expect(ch.enqueue(2)).toBe('ok');
    expect(ch.size).toBe(2);
    expect(ch.isFull).toBe(false);
    expect(ch.enqueue(3)).toBe('ok');
    expect(ch.size).toBe(3);
    expect(ch.isFull).toBe(true);
  });

  it('enqueue at cap returns overflow and does NOT mutate', () => {
    const ch = new BoundedChannel<number>(2);
    ch.enqueue(1);
    ch.enqueue(2);
    expect(ch.size).toBe(2);
    // §4.3 producer-side check: overflow signal must be observable.
    expect(ch.enqueue(3)).toBe('overflow');
    expect(ch.size).toBe(2);
    // Original head still there — no silent drop, no shift.
    expect(ch.peek()).toBe(1);
  });

  it('dequeue returns FIFO order', () => {
    const ch = new BoundedChannel<number>(3);
    ch.enqueue(10);
    ch.enqueue(20);
    ch.enqueue(30);
    expect(ch.dequeue()).toBe(10);
    expect(ch.dequeue()).toBe(20);
    expect(ch.dequeue()).toBe(30);
    expect(ch.size).toBe(0);
    expect(ch.isEmpty).toBe(true);
  });

  it('dequeue from empty returns undefined', () => {
    const ch = new BoundedChannel<number>(2);
    expect(ch.dequeue()).toBeUndefined();
  });

  it('survives wrap-around (head/tail cycle past capacity)', () => {
    // Validates the ring math, not just append-then-drain.
    const ch = new BoundedChannel<number>(3);
    ch.enqueue(1);
    ch.enqueue(2);
    expect(ch.dequeue()).toBe(1);
    ch.enqueue(3);
    ch.enqueue(4); // tail wraps to slot 0
    expect(ch.size).toBe(3);
    expect(ch.dequeue()).toBe(2);
    expect(ch.dequeue()).toBe(3);
    expect(ch.dequeue()).toBe(4);
    expect(ch.isEmpty).toBe(true);
  });

  it('peek returns head without removing', () => {
    const ch = new BoundedChannel<number>(2);
    ch.enqueue(7);
    ch.enqueue(8);
    expect(ch.peek()).toBe(7);
    expect(ch.peek()).toBe(7);
    expect(ch.size).toBe(2);
  });

  it('peek on empty returns undefined', () => {
    const ch = new BoundedChannel<number>(2);
    expect(ch.peek()).toBeUndefined();
  });
});

describe('BoundedChannel — clear', () => {
  it('empties a partially-full channel', () => {
    const ch = new BoundedChannel<number>(4);
    ch.enqueue(1);
    ch.enqueue(2);
    ch.clear();
    expect(ch.size).toBe(0);
    expect(ch.isEmpty).toBe(true);
    expect(ch.dequeue()).toBeUndefined();
  });

  it('is a no-op on an empty channel', () => {
    const ch = new BoundedChannel<number>(2);
    ch.clear();
    expect(ch.size).toBe(0);
  });

  it('clears wrap-around state', () => {
    const ch = new BoundedChannel<number>(3);
    ch.enqueue(1);
    ch.enqueue(2);
    ch.dequeue();
    ch.enqueue(3);
    ch.enqueue(4);
    ch.clear();
    expect(ch.size).toBe(0);
    // Reuse after clear behaves like fresh.
    ch.enqueue(99);
    expect(ch.dequeue()).toBe(99);
  });
});

describe('BoundedChannel — enqueueDroppingOldest (drop-old primitive)', () => {
  it('appends without dropping when not full', () => {
    const ch = new BoundedChannel<number>(3);
    expect(ch.enqueueDroppingOldest(1)).toBeUndefined();
    expect(ch.enqueueDroppingOldest(2)).toBeUndefined();
    expect(ch.size).toBe(2);
  });

  it('drops the oldest entry when full and returns it', () => {
    // The "drop old entry" path the task spec named — used by the
    // emitter's per-session in-memory ring (T-PA-5) which prunes by
    // snapshot cadence and tolerates losing oldest deltas. The Attach
    // subscriber channel does NOT use this method (spec §4.3 closes
    // the stream instead), but the primitive lives here.
    const ch = new BoundedChannel<number>(3);
    ch.enqueueDroppingOldest(1);
    ch.enqueueDroppingOldest(2);
    ch.enqueueDroppingOldest(3);
    expect(ch.size).toBe(3);
    expect(ch.enqueueDroppingOldest(4)).toBe(1);
    expect(ch.size).toBe(3);
    expect(ch.dequeue()).toBe(2);
    expect(ch.dequeue()).toBe(3);
    expect(ch.dequeue()).toBe(4);
  });

  it('preserves FIFO across many drops (ring wrap correctness)', () => {
    const ch = new BoundedChannel<number>(2);
    ch.enqueueDroppingOldest(1);
    ch.enqueueDroppingOldest(2);
    expect(ch.enqueueDroppingOldest(3)).toBe(1);
    expect(ch.enqueueDroppingOldest(4)).toBe(2);
    expect(ch.enqueueDroppingOldest(5)).toBe(3);
    expect(ch.dequeue()).toBe(4);
    expect(ch.dequeue()).toBe(5);
  });
});

describe('AckSubscriberState — construction', () => {
  it('initializes lastDelivered/lastAcked from initialSeq with zero backlog', () => {
    const s = new AckSubscriberState({
      subscriberId: 'sub-1',
      sessionId: 'sess-1',
      initialSeq: 42n,
    });
    expect(s.subscriberId).toBe('sub-1');
    expect(s.sessionId).toBe('sess-1');
    expect(s.lastDeliveredSeq).toBe(42n);
    expect(s.lastAckedSeq).toBe(42n);
    expect(s.unackedBacklog).toBe(0n);
  });

  it('attaches a channel with default capacity when none specified', () => {
    const s = new AckSubscriberState({
      subscriberId: 'sub',
      sessionId: 'sess',
      initialSeq: 0n,
    });
    expect(s.channel.capacity).toBe(ACK_CHANNEL_CAPACITY);
  });

  it('honors custom channel capacity (used by tests / future v0.4 tuning)', () => {
    const s = new AckSubscriberState({
      subscriberId: 'sub',
      sessionId: 'sess',
      initialSeq: 0n,
      channelCapacity: 16,
    });
    expect(s.channel.capacity).toBe(16);
  });
});

describe('AckSubscriberState — onDelivered (ack-pointer advance)', () => {
  it('advances lastDeliveredSeq monotonically; backlog tracks delta', () => {
    const s = new AckSubscriberState({
      subscriberId: 'sub',
      sessionId: 'sess',
      initialSeq: 0n,
    });
    s.onDelivered(1n);
    expect(s.lastDeliveredSeq).toBe(1n);
    expect(s.unackedBacklog).toBe(1n);
    s.onDelivered(2n);
    s.onDelivered(3n);
    expect(s.lastDeliveredSeq).toBe(3n);
    expect(s.unackedBacklog).toBe(3n);
  });

  it('throws on equal seq (non-strictly-monotonic = handler bug)', () => {
    const s = new AckSubscriberState({
      subscriberId: 'sub',
      sessionId: 'sess',
      initialSeq: 5n,
    });
    expect(() => s.onDelivered(5n)).toThrow(/non-monotonic/);
  });

  it('throws on regressing seq', () => {
    const s = new AckSubscriberState({
      subscriberId: 'sub',
      sessionId: 'sess',
      initialSeq: 0n,
    });
    s.onDelivered(10n);
    expect(() => s.onDelivered(9n)).toThrow(/non-monotonic/);
    expect(s.lastDeliveredSeq).toBe(10n); // unchanged after throw
  });
});

describe('AckSubscriberState — onAck validation per spec §6.1', () => {
  function freshState(initialSeq: bigint = 0n): AckSubscriberState {
    return new AckSubscriberState({
      subscriberId: 'sub',
      sessionId: 'sess',
      initialSeq,
    });
  }

  it('advances lastAckedSeq for in-window ack', () => {
    const s = freshState();
    s.onDelivered(1n);
    s.onDelivered(2n);
    s.onDelivered(3n);
    const r = s.onAck(2n);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.newLastAckedSeq).toBe(2n);
    }
    expect(s.lastAckedSeq).toBe(2n);
    expect(s.unackedBacklog).toBe(1n); // delivered 3 - acked 2
  });

  it('idempotent for repeated equal ack (benign retry under packet loss)', () => {
    const s = freshState();
    s.onDelivered(1n);
    s.onDelivered(2n);
    expect(s.onAck(2n).kind).toBe('ok');
    const r = s.onAck(2n);
    expect(r.kind).toBe('ok');
    expect(s.lastAckedSeq).toBe(2n);
  });

  it('rejects pty.ack_overrun when applied_seq > lastDeliveredSeq', () => {
    const s = freshState();
    s.onDelivered(1n);
    s.onDelivered(2n);
    const r = s.onAck(5n);
    expect(r).toEqual({
      kind: 'rejected',
      reason: 'pty.ack_overrun',
      appliedSeq: 5n,
      lastDeliveredSeq: 2n,
      lastAckedSeq: 0n,
    });
    // State must NOT mutate on rejection.
    expect(s.lastAckedSeq).toBe(0n);
  });

  it('rejects pty.ack_regress when applied_seq < lastAckedSeq', () => {
    const s = freshState();
    s.onDelivered(1n);
    s.onDelivered(2n);
    s.onDelivered(3n);
    s.onAck(2n);
    const r = s.onAck(1n);
    expect(r).toEqual({
      kind: 'rejected',
      reason: 'pty.ack_regress',
      appliedSeq: 1n,
      lastDeliveredSeq: 3n,
      lastAckedSeq: 2n,
    });
    // State must NOT mutate on rejection.
    expect(s.lastAckedSeq).toBe(2n);
  });

  it('respects non-zero initialSeq (subscriber resumed mid-stream)', () => {
    // Attach with since_seq=100 sets initialSeq=100; first delivered
    // is seq=101; an ack of 100 is the in-window idempotent baseline,
    // an ack of 99 must regress.
    const s = freshState(100n);
    expect(s.onAck(100n).kind).toBe('ok');
    s.onDelivered(101n);
    expect(s.onAck(101n).kind).toBe('ok');
    const regress = s.onAck(99n);
    expect(regress.kind).toBe('rejected');
    if (regress.kind === 'rejected') {
      expect(regress.reason).toBe('pty.ack_regress');
    }
  });
});

describe('AckSubscriberState — channel composition', () => {
  it('routes deltas through the bounded channel', () => {
    const s = new AckSubscriberState({
      subscriberId: 'sub',
      sessionId: 'sess',
      initialSeq: 0n,
      channelCapacity: 4,
    });
    expect(s.channel.enqueue(makeDelta(1n))).toBe('ok');
    expect(s.channel.enqueue(makeDelta(2n))).toBe('ok');
    expect(s.channel.size).toBe(2);
    const head = s.channel.dequeue();
    expect(head?.seq).toBe(1n);
  });

  it('signals overflow per spec §4.3 when consumer falls behind capacity', () => {
    const s = new AckSubscriberState({
      subscriberId: 'sub',
      sessionId: 'sess',
      initialSeq: 0n,
      channelCapacity: 2,
    });
    s.channel.enqueue(makeDelta(1n));
    s.channel.enqueue(makeDelta(2n));
    // Producer hits cap; signal must be 'overflow', not silent.
    expect(s.channel.enqueue(makeDelta(3n))).toBe('overflow');
    // The Attach handler reacts to this by closing the stream with
    // Code.ResourceExhausted / pty.subscriber_channel_full per §4.3.
    // Channel state must still be intact for any in-flight dequeue.
    expect(s.channel.size).toBe(2);
    expect(s.channel.peek()?.seq).toBe(1n);
  });
});
