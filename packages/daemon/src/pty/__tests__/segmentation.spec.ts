// Unit tests for the per-session pty delta accumulator (T4.9, ch06 §3).
//
// Drives the accumulator with an injected fake clock + fake timer so the
// 16 ms / 16 KiB segmentation invariants can be asserted deterministically
// without sleeping or spawning a real pty.

import { describe, expect, it } from 'vitest';

import {
  DeltaAccumulator,
  PTY_CADENCE,
  SEGMENTATION_BYTE_CAP,
  SEGMENTATION_TIMEOUT_MS,
  K_TIME_MS,
  M_DELTAS,
  B_BYTES,
  type Clock,
  type PtyDeltaPayload,
  type TimerOps,
} from '../segmentation.js';

interface PendingTimer {
  cb: () => void;
  fireAtMs: number;
  cleared: boolean;
}

function makeFakeEnv(startMs = 1_000_000): {
  clock: Clock;
  timer: TimerOps;
  advance: (ms: number) => void;
  pending: () => PendingTimer | null;
} {
  let nowMs = startMs;
  let pending: PendingTimer | null = null;

  const clock: Clock = () => nowMs;
  const timer: TimerOps = {
    setTimer(cb, delayMs) {
      // Spec invariant: at most one pending timer per accumulator. The
      // accumulator clears the previous handle before arming a new one,
      // so observing two simultaneous timers in this fake would be a bug
      // we WANT to catch.
      if (pending !== null && !pending.cleared) {
        throw new Error(
          `fake timer: setTimer called while a previous timer (fireAt=${pending.fireAtMs}) is still pending`,
        );
      }
      const t: PendingTimer = { cb, fireAtMs: nowMs + delayMs, cleared: false };
      pending = t;
      return t;
    },
    clearTimer(h) {
      const t = h as PendingTimer;
      t.cleared = true;
      if (pending === t) pending = null;
    },
  };

  function advance(ms: number): void {
    nowMs += ms;
    // Fire the pending timer if its deadline has passed.
    while (pending !== null && pending.fireAtMs <= nowMs && !pending.cleared) {
      const t = pending;
      pending = null;
      t.cb();
    }
  }

  return {
    clock,
    timer,
    advance,
    pending: () => pending,
  };
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe('cadence constants', () => {
  it('exports the spec ch06 values', () => {
    expect(SEGMENTATION_TIMEOUT_MS).toBe(16);
    expect(SEGMENTATION_BYTE_CAP).toBe(16384);
    expect(K_TIME_MS).toBe(30_000);
    expect(M_DELTAS).toBe(256);
    expect(B_BYTES).toBe(1024 * 1024);
    expect(PTY_CADENCE.SEGMENTATION_TIMEOUT_MS).toBe(SEGMENTATION_TIMEOUT_MS);
    expect(PTY_CADENCE.SEGMENTATION_BYTE_CAP).toBe(SEGMENTATION_BYTE_CAP);
    expect(PTY_CADENCE.K_TIME_MS).toBe(K_TIME_MS);
    expect(PTY_CADENCE.M_DELTAS).toBe(M_DELTAS);
    expect(PTY_CADENCE.B_BYTES).toBe(B_BYTES);
  });

  it('PTY_CADENCE is frozen', () => {
    expect(Object.isFrozen(PTY_CADENCE)).toBe(true);
  });
});

describe('DeltaAccumulator — empty / no-op behavior', () => {
  it('zero-byte push emits nothing and arms no timer', () => {
    const env = makeFakeEnv();
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
    });

    acc.push(new Uint8Array(0));

    expect(out).toEqual([]);
    expect(env.pending()).toBeNull();
    expect(acc.bufferedBytes()).toBe(0);
  });

  it('flushNow on empty buffer is a no-op', () => {
    const env = makeFakeEnv();
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
    });
    acc.flushNow();
    expect(out).toEqual([]);
  });
});

describe('DeltaAccumulator — 16 ms timeout boundary', () => {
  it('arms a 16 ms timer on the first byte and flushes when it fires', () => {
    const env = makeFakeEnv(1_000_000);
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
    });

    acc.push(bytes(0x68, 0x69)); // 'hi'

    // Timer must be armed at exactly +16ms and no delta yet.
    expect(env.pending()).not.toBeNull();
    expect(env.pending()!.fireAtMs).toBe(1_000_000 + SEGMENTATION_TIMEOUT_MS);
    expect(out).toEqual([]);

    // Advance just-under and ensure no flush.
    env.advance(SEGMENTATION_TIMEOUT_MS - 1);
    expect(out).toEqual([]);

    // Cross the deadline; flush must happen.
    env.advance(1);
    expect(out.length).toBe(1);
    expect(out[0].seq).toBe(1);
    expect(out[0].payload).toEqual(bytes(0x68, 0x69));
    // tsMs is the wall-clock at the FIRST byte (not the flush time) so
    // T4.10's correlation with K_TIME aligns to byte arrival, not flush.
    expect(out[0].tsMs).toBe(1_000_000);
  });

  it('multiple pushes inside the same window coalesce into one delta', () => {
    const env = makeFakeEnv();
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
    });

    acc.push(bytes(0x41));
    env.advance(5);
    acc.push(bytes(0x42, 0x43));
    env.advance(5);
    acc.push(bytes(0x44));

    expect(out).toEqual([]);
    expect(acc.bufferedBytes()).toBe(4);

    env.advance(SEGMENTATION_TIMEOUT_MS); // crosses 16 ms from FIRST byte
    expect(out.length).toBe(1);
    expect(out[0].seq).toBe(1);
    expect(out[0].payload).toEqual(bytes(0x41, 0x42, 0x43, 0x44));
  });

  it('starts a new timer for each fresh segment', () => {
    const env = makeFakeEnv(2_000_000);
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
    });

    acc.push(bytes(1));
    env.advance(SEGMENTATION_TIMEOUT_MS);
    expect(out.length).toBe(1);
    expect(env.pending()).toBeNull();

    // Second segment, second timer arming.
    acc.push(bytes(2, 3));
    expect(env.pending()).not.toBeNull();
    env.advance(SEGMENTATION_TIMEOUT_MS);
    expect(out.length).toBe(2);
    expect(out[1].seq).toBe(2);
    expect(out[1].payload).toEqual(bytes(2, 3));
  });
});

describe('DeltaAccumulator — 16 KiB byte cap', () => {
  it('flushes synchronously when a single push exactly fills the cap', () => {
    const env = makeFakeEnv();
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
    });

    const buf = new Uint8Array(SEGMENTATION_BYTE_CAP).fill(0x58); // 'X'
    acc.push(buf);

    expect(out.length).toBe(1);
    expect(out[0].payload.length).toBe(SEGMENTATION_BYTE_CAP);
    expect(out[0].seq).toBe(1);
    // No timer pending — the buffer is empty after the synchronous flush.
    expect(env.pending()).toBeNull();
    expect(acc.bufferedBytes()).toBe(0);
  });

  it('splits an oversized push into back-to-back full-cap deltas + tail', () => {
    const env = makeFakeEnv(5_000_000);
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
    });

    // 50_000 bytes ≈ 3 full caps + 768-byte tail.
    const big = new Uint8Array(50_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    acc.push(big);

    // Three full-cap deltas should have flushed synchronously.
    expect(out.length).toBe(3);
    expect(out[0].payload.length).toBe(SEGMENTATION_BYTE_CAP);
    expect(out[1].payload.length).toBe(SEGMENTATION_BYTE_CAP);
    expect(out[2].payload.length).toBe(SEGMENTATION_BYTE_CAP);

    // Seq is monotonic and contiguous.
    expect(out.map((d) => d.seq)).toEqual([1, 2, 3]);

    // Tail remains buffered, timer armed.
    expect(acc.bufferedBytes()).toBe(50_000 - 3 * SEGMENTATION_BYTE_CAP);
    expect(env.pending()).not.toBeNull();

    // Drain the tail via the deadline.
    env.advance(SEGMENTATION_TIMEOUT_MS);
    expect(out.length).toBe(4);
    expect(out[3].seq).toBe(4);
    expect(out[3].payload.length).toBe(50_000 - 3 * SEGMENTATION_BYTE_CAP);

    // Re-assemble: every input byte should appear in the same order in
    // the concatenated output payloads (raw VT preservation).
    const cat = new Uint8Array(50_000);
    let off = 0;
    for (const d of out) {
      cat.set(d.payload, off);
      off += d.payload.length;
    }
    expect(cat).toEqual(big);
  });

  it('mid-segment cap fill flushes the prefix that fills the cap, then continues', () => {
    const env = makeFakeEnv();
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
    });

    const half = new Uint8Array(SEGMENTATION_BYTE_CAP - 100).fill(0x41);
    acc.push(half);
    expect(out.length).toBe(0);
    expect(acc.bufferedBytes()).toBe(SEGMENTATION_BYTE_CAP - 100);

    // Push 200 bytes — 100 fill the cap, 100 carry over to the next seg.
    const more = new Uint8Array(200).fill(0x42);
    acc.push(more);

    expect(out.length).toBe(1);
    expect(out[0].payload.length).toBe(SEGMENTATION_BYTE_CAP);
    expect(acc.bufferedBytes()).toBe(100);
    expect(env.pending()).not.toBeNull();
  });
});

describe('DeltaAccumulator — flushNow / dispose / firstSeq', () => {
  it('flushNow drains the buffer immediately and clears the timer', () => {
    const env = makeFakeEnv();
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
    });
    acc.push(bytes(9, 9, 9));
    expect(env.pending()).not.toBeNull();
    acc.flushNow();
    expect(out.length).toBe(1);
    expect(env.pending()).toBeNull();

    // Advance past the original deadline — must NOT produce a phantom
    // delta (a flushNow that didn't disarm the timer would).
    env.advance(SEGMENTATION_TIMEOUT_MS * 4);
    expect(out.length).toBe(1);
  });

  it('dispose clears the pending timer and silences further pushes', () => {
    const env = makeFakeEnv();
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
    });
    acc.push(bytes(1, 2));
    acc.dispose();
    expect(env.pending()).toBeNull();

    acc.push(bytes(3, 4));
    acc.flushNow();
    env.advance(SEGMENTATION_TIMEOUT_MS * 4);
    expect(out).toEqual([]);
  });

  it('firstSeq lets the daemon resume seq numbering across restart', () => {
    const env = makeFakeEnv();
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
      firstSeq: 4097,
    });
    expect(acc.nextSeqWillEmit()).toBe(4097);

    acc.push(bytes(0));
    acc.flushNow();
    expect(out[0].seq).toBe(4097);
    expect(acc.nextSeqWillEmit()).toBe(4098);

    acc.push(bytes(1));
    acc.flushNow();
    expect(out[1].seq).toBe(4098);
  });
});

describe('DeltaAccumulator — monotonic seq invariant', () => {
  it('emits strictly increasing seq across many mixed-cadence segments', () => {
    const env = makeFakeEnv();
    const out: PtyDeltaPayload[] = [];
    const acc = new DeltaAccumulator({
      onDelta: (d) => out.push(d),
      now: env.clock,
      timer: env.timer,
    });

    // Pattern: a small write → timer flush, a big oversized write →
    // synchronous multi-flush, a manual flushNow, repeat.
    for (let i = 0; i < 5; i++) {
      acc.push(bytes(i + 1));
      env.advance(SEGMENTATION_TIMEOUT_MS);
      const big = new Uint8Array(SEGMENTATION_BYTE_CAP * 2 + 300);
      acc.push(big);
      acc.flushNow();
    }

    // Every seq must be unique, contiguous, and starting at 1.
    const seqs = out.map((d) => d.seq);
    for (let i = 0; i < seqs.length; i++) {
      expect(seqs[i]).toBe(i + 1);
    }
    // And the running sum of payload bytes equals the running sum of
    // input bytes — no bytes lost or duplicated.
    const totalOut = out.reduce((s, d) => s + d.payload.length, 0);
    const totalIn = 5 * (1 + SEGMENTATION_BYTE_CAP * 2 + 300);
    expect(totalOut).toBe(totalIn);
  });
});
