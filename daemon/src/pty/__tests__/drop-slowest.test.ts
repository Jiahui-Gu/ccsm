import { describe, expect, it } from 'vitest';

import {
  DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES,
  createDropSlowest,
} from '../drop-slowest.js';

describe('drop-slowest: spec-default constant (frag-3.5.1 §3.5.1.5 line 118)', () => {
  it('exports threshold = 1 MiB (1_048_576 bytes)', () => {
    expect(DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES).toBe(1024 * 1024);
    expect(DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES).toBe(1_048_576);
  });
});

describe('drop-slowest: construction', () => {
  it('rejects non-positive thresholdBytes', () => {
    expect(() => createDropSlowest({ thresholdBytes: 0 })).toThrow(RangeError);
    expect(() => createDropSlowest({ thresholdBytes: -1 })).toThrow(RangeError);
    expect(() => createDropSlowest({ thresholdBytes: 1.5 })).toThrow(RangeError);
    expect(() => createDropSlowest({ thresholdBytes: Number.NaN })).toThrow(RangeError);
  });

  it('defaults to the spec threshold', () => {
    const d = createDropSlowest();
    d.record('s', DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES);
    expect(d.getOverlimit()).toEqual([]);
    d.record('s', 1);
    expect(d.getOverlimit()).toEqual(['s']);
  });
});

describe('drop-slowest: single subscriber accumulation', () => {
  it('flags overlimit only after pending strictly exceeds 1 MiB', () => {
    const d = createDropSlowest();
    // Half a MiB — well below.
    d.record('a', 512 * 1024);
    expect(d.pending('a')).toBe(512 * 1024);
    expect(d.getOverlimit()).toEqual([]);
    // Up to exactly 1 MiB — boundary, NOT overlimit (strict greater-than).
    d.record('a', 512 * 1024);
    expect(d.pending('a')).toBe(1_048_576);
    expect(d.getOverlimit()).toEqual([]);
    // One byte over — flagged.
    d.record('a', 1);
    expect(d.pending('a')).toBe(1_048_577);
    expect(d.getOverlimit()).toEqual(['a']);
  });

  it('does not flag a subscriber that stays below threshold', () => {
    const d = createDropSlowest({ thresholdBytes: 1000 });
    d.record('a', 999);
    expect(d.getOverlimit()).toEqual([]);
    d.record('a', 1); // 1000 — boundary, still not overlimit
    expect(d.getOverlimit()).toEqual([]);
  });
});

describe('drop-slowest: flush decrements tally', () => {
  it('drops back below threshold after flush', () => {
    const d = createDropSlowest({ thresholdBytes: 100 });
    d.record('a', 150);
    expect(d.getOverlimit()).toEqual(['a']);
    d.flush('a', 100); // 50 pending now
    expect(d.pending('a')).toBe(50);
    expect(d.getOverlimit()).toEqual([]);
  });

  it('clamps tally at zero on over-decrement (race-safe)', () => {
    const d = createDropSlowest({ thresholdBytes: 100 });
    d.record('a', 50);
    d.flush('a', 999); // way more than pending — clamp to 0
    expect(d.pending('a')).toBe(0);
    d.flush('unknown-sub', 10); // unknown subscriber — silently ignored
    expect(d.pending('unknown-sub')).toBe(0);
  });
});

describe('drop-slowest: reset', () => {
  it('zeroes tally without forgetting the subscriber', () => {
    const d = createDropSlowest({ thresholdBytes: 100 });
    d.record('a', 200);
    expect(d.getOverlimit()).toEqual(['a']);
    d.reset('a');
    expect(d.pending('a')).toBe(0);
    expect(d.getOverlimit()).toEqual([]);
    // Subsequent record() accumulates from 0.
    d.record('a', 50);
    expect(d.pending('a')).toBe(50);
  });

  it('is a no-op for unknown subscribers', () => {
    const d = createDropSlowest();
    d.reset('never-seen'); // must not throw
    expect(d.pending('never-seen')).toBe(0);
  });
});

describe('drop-slowest: multiple subscribers, only over-threshold returned', () => {
  it('returns only the over-threshold subset, in insertion order', () => {
    const d = createDropSlowest({ thresholdBytes: 100 });
    d.record('a', 50); // under
    d.record('b', 200); // over
    d.record('c', 100); // boundary, under
    d.record('d', 101); // over
    expect(d.getOverlimit()).toEqual(['b', 'd']);
  });

  it('isolates subscriber tallies', () => {
    const d = createDropSlowest({ thresholdBytes: 100 });
    d.record('a', 200);
    d.record('b', 50);
    d.flush('a', 200);
    expect(d.pending('a')).toBe(0);
    expect(d.pending('b')).toBe(50);
    expect(d.getOverlimit()).toEqual([]);
  });
});

describe('drop-slowest: forget cleans up state', () => {
  it('removes the subscriber entirely', () => {
    const d = createDropSlowest({ thresholdBytes: 100 });
    d.record('a', 200);
    expect(d.getOverlimit()).toEqual(['a']);
    d.forget('a');
    expect(d.pending('a')).toBe(0);
    expect(d.getOverlimit()).toEqual([]);
  });

  it('is idempotent', () => {
    const d = createDropSlowest();
    d.forget('never-seen');
    d.record('a', 10);
    d.forget('a');
    d.forget('a'); // second forget — no throw
    expect(d.pending('a')).toBe(0);
  });
});

describe('drop-slowest: replay-burst exemption seam (T47 / task #1004)', () => {
  it('skips accounting when { exempt: true } is passed', () => {
    const d = createDropSlowest();
    // Simulate a 256 KB replay burst delivered as one initial write — must
    // NOT count toward the steady-state watermark.
    d.record('a', 256 * 1024, { exempt: true });
    expect(d.pending('a')).toBe(0);
    expect(d.getOverlimit()).toEqual([]);
    // Subsequent steady-state writes accumulate normally and DO trip at 1 MB.
    d.record('a', 1_048_576);
    expect(d.getOverlimit()).toEqual([]);
    d.record('a', 1);
    expect(d.getOverlimit()).toEqual(['a']);
  });

  it('reset() after replay write is the alternative seam', () => {
    const d = createDropSlowest();
    // Caller chose record-then-reset path: include replay in tally to keep
    // ordering simple, then clear before steady-state accounting begins.
    d.record('a', 256 * 1024);
    d.reset('a');
    expect(d.pending('a')).toBe(0);
    d.record('a', 1_048_576);
    expect(d.getOverlimit()).toEqual([]);
    d.record('a', 1);
    expect(d.getOverlimit()).toEqual(['a']);
  });
});

describe('drop-slowest: input validation', () => {
  it('rejects negative byteCount on record', () => {
    const d = createDropSlowest();
    expect(() => d.record('a', -1)).toThrow(RangeError);
  });

  it('rejects non-integer byteCount on record', () => {
    const d = createDropSlowest();
    expect(() => d.record('a', 1.5)).toThrow(RangeError);
    expect(() => d.record('a', Number.NaN)).toThrow(RangeError);
    expect(() => d.record('a', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('rejects negative byteCount on flush', () => {
    const d = createDropSlowest();
    expect(() => d.flush('a', -1)).toThrow(RangeError);
  });

  it('zero-byte record is a no-op but registers the subscriber', () => {
    const d = createDropSlowest();
    d.record('a', 0);
    expect(d.pending('a')).toBe(0);
    expect(d.getOverlimit()).toEqual([]);
  });
});
