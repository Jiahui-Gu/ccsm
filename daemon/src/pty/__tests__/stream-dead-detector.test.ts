import { describe, expect, it } from 'vitest';

import {
  createStreamDeadDetector,
  type StreamDeadDetector,
} from '../stream-dead-detector.js';

// Hermetic clock helper. Tests pass `now` explicitly to `onAck` /
// `track` / `check` so the detector never observes wall-clock time.
function makeDetector(deadlineMs = 1000): StreamDeadDetector {
  // Inject a clock that throws — every entry point used in tests passes
  // an explicit `at` / `now`, so an accidental fallback to the clock
  // would surface immediately as a thrown test failure rather than as
  // wall-clock flakiness.
  return createStreamDeadDetector({
    deadlineMs,
    now: () => {
      throw new Error('detector should not consult ambient clock in tests');
    },
  });
}

describe('stream-dead-detector: construction', () => {
  it('rejects non-positive deadline', () => {
    expect(() => createStreamDeadDetector({ deadlineMs: 0 })).toThrow(RangeError);
    expect(() => createStreamDeadDetector({ deadlineMs: -1 })).toThrow(RangeError);
  });
  it('rejects non-integer / non-finite deadline', () => {
    expect(() => createStreamDeadDetector({ deadlineMs: 1.5 })).toThrow(RangeError);
    expect(() => createStreamDeadDetector({ deadlineMs: Number.NaN })).toThrow(RangeError);
    expect(() => createStreamDeadDetector({ deadlineMs: Infinity })).toThrow(RangeError);
  });
  it('accepts the spec-canonical 65 s default (2 × 30 s + 5 s)', () => {
    expect(() => createStreamDeadDetector({ deadlineMs: 65_000 })).not.toThrow();
  });
});

describe('stream-dead-detector: liveness window', () => {
  it('untracked subscriber is never reported', () => {
    const det = makeDetector(1000);
    expect(det.check(10_000_000)).toEqual([]);
    expect(det.size()).toBe(0);
  });

  it('fresh subscriber registered via track is alive until deadlineMs elapses', () => {
    const det = makeDetector(1000);
    det.track('sub-a', 1000);
    expect(det.check(1000)).toEqual([]); // age 0
    expect(det.check(1999)).toEqual([]); // age 999, just under
    expect(det.check(2000)).toEqual([]); // age 1000, NOT strictly older
    expect(det.check(2001)).toEqual(['sub-a']); // age 1001, dead
  });

  it('onAck on an unknown id implicitly registers it (re-arm semantics)', () => {
    const det = makeDetector(1000);
    det.onAck('sub-a', 5000);
    expect(det.size()).toBe(1);
    expect(det.check(5500)).toEqual([]);
    expect(det.check(6001)).toEqual(['sub-a']);
  });

  it('onAck refreshes lastAck and revives a subscriber close to the deadline', () => {
    const det = makeDetector(1000);
    det.track('sub-a', 1000);
    // About to die...
    expect(det.check(1999)).toEqual([]);
    det.onAck('sub-a', 1999);
    // ...but the ack reset the clock; lastAck = 1999, deadline = 1000.
    // Dead when age strictly > 1000, i.e. when now >= 3000.
    expect(det.check(2999)).toEqual([]); // age 1000, alive
    expect(det.check(3000)).toEqual(['sub-a']); // age 1001, dead
  });

  it('track is a no-op for an already-tracked id (does not bump timestamp)', () => {
    const det = makeDetector(1000);
    det.track('sub-a', 1000);
    det.track('sub-a', 5000); // ignored — onAck is the bumper
    expect(det.check(2001)).toEqual(['sub-a']);
  });
});

describe('stream-dead-detector: check is pure', () => {
  it('repeated check() returns the same dead set without mutating state', () => {
    const det = makeDetector(1000);
    det.track('sub-a', 1000);
    expect(det.check(2001)).toEqual(['sub-a']);
    expect(det.check(2001)).toEqual(['sub-a']);
    expect(det.check(2001)).toEqual(['sub-a']);
    expect(det.size()).toBe(1); // still tracked — caller must forget()
  });

  it('forget removes the subscriber so check no longer returns it', () => {
    const det = makeDetector(1000);
    det.track('sub-a', 1000);
    expect(det.check(2001)).toEqual(['sub-a']);
    det.forget('sub-a');
    expect(det.check(2001)).toEqual([]);
    expect(det.size()).toBe(0);
  });

  it('forget is idempotent on unknown id', () => {
    const det = makeDetector(1000);
    expect(() => det.forget('never-tracked')).not.toThrow();
  });
});

describe('stream-dead-detector: multiple subscribers', () => {
  it('only old subscribers are reported, fresh ones are not', () => {
    const det = makeDetector(1000);
    det.track('sub-old-1', 1000);
    det.track('sub-old-2', 1000);
    det.track('sub-fresh', 5000);
    det.onAck('sub-recent', 5500);
    const dead = det.check(6000);
    // sub-old-1, sub-old-2: age 5000, dead
    // sub-fresh: age 1000 — NOT strictly older than deadline, alive
    // sub-recent: age 500, alive
    expect(dead).toEqual(['sub-old-1', 'sub-old-2']);
  });

  it('returns dead ids in ASCII lexical order regardless of insertion order', () => {
    const det = makeDetector(1000);
    // Insert deliberately out of sort order.
    det.track('zeta', 1000);
    det.track('alpha', 1000);
    det.track('mike', 1000);
    det.track('bravo', 1000);
    expect(det.check(2001)).toEqual(['alpha', 'bravo', 'mike', 'zeta']);
  });

  it('mixed live + dead set: only the dead ones come back, sorted', () => {
    const det = makeDetector(1000);
    det.track('c', 1000); // dead at 2001
    det.track('a', 1500); // alive at 2001 (age 501)
    det.track('b', 1000); // dead at 2001
    det.track('d', 1900); // alive at 2001 (age 101)
    expect(det.check(2001)).toEqual(['b', 'c']);
  });

  it('large fan-out: 100 subs, half ack just in time, half time out', () => {
    const det = makeDetector(1000);
    for (let i = 0; i < 100; i++) {
      const id = `sub-${String(i).padStart(3, '0')}`;
      det.track(id, 1000);
      if (i % 2 === 0) det.onAck(id, 1500); // even indices ack mid-window
    }
    const dead = det.check(2001);
    // odds are dead (50 ids), evens were ack'ed at 1500 → age 501 alive
    expect(dead.length).toBe(50);
    expect(dead[0]).toBe('sub-001');
    expect(dead[dead.length - 1]).toBe('sub-099');
    // Verify all returned ids are odd-indexed.
    for (const id of dead) {
      const n = Number(id.replace('sub-', ''));
      expect(n % 2).toBe(1);
    }
  });
});

describe('stream-dead-detector: clock injection', () => {
  it('falls back to injected clock when caller omits explicit timestamps', () => {
    let nowVal = 1000;
    const det = createStreamDeadDetector({
      deadlineMs: 1000,
      now: () => nowVal,
    });
    det.track('sub-a'); // uses clock => 1000
    nowVal = 1500;
    det.onAck('sub-b'); // uses clock => 1500
    nowVal = 2001;
    expect(det.check()).toEqual(['sub-a']); // sub-a age 1001, sub-b age 501
    nowVal = 2501;
    expect(det.check()).toEqual(['sub-a', 'sub-b']); // both dead
  });
});
