// Unit tests for the per-session PendingWriteTracker (T4.3).
//
// Spec ref:
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch06 §1 FOREVER-STABLE row F5 (1 MiB cap; equality is allowed;
//     reject = `pending + attempted > cap`).

import { describe, expect, it } from 'vitest';

import {
  PENDING_WRITE_CAP_BYTES,
  PendingWriteTracker,
} from '../pending-write-tracker.js';

describe('PendingWriteTracker — spec-locked constants', () => {
  it('exposes a 1 MiB default cap (FOREVER-STABLE per ch06 §1 F5)', () => {
    expect(PENDING_WRITE_CAP_BYTES).toBe(1024 * 1024);
    expect(new PendingWriteTracker().cap).toBe(1024 * 1024);
  });

  it('rejects non-positive / non-integer caps in the constructor', () => {
    expect(() => new PendingWriteTracker(0)).toThrow(/positive integer/);
    expect(() => new PendingWriteTracker(-1)).toThrow(/positive integer/);
    expect(() => new PendingWriteTracker(1.5)).toThrow(/positive integer/);
  });
});

describe('PendingWriteTracker.decide — pure decider', () => {
  it('accepts when pending + attempted < cap', () => {
    const t = new PendingWriteTracker(1024);
    t.recordWrite(500);
    expect(t.decide(100)).toEqual({ kind: 'accept' });
  });

  it('accepts equality (pending + attempted == cap; spec strict ">" rejects)', () => {
    const t = new PendingWriteTracker(1024);
    t.recordWrite(500);
    // 500 + 524 = 1024 == cap → accept (spec wording uses strict >).
    expect(t.decide(524)).toEqual({ kind: 'accept' });
  });

  it('rejects when pending + attempted > cap, carrying the rejection payload', () => {
    const t = new PendingWriteTracker(1024);
    t.recordWrite(500);
    expect(t.decide(525)).toEqual({
      kind: 'reject',
      reason: 'pty.input_overflow',
      pendingWriteBytes: 500,
      attemptedBytes: 525,
      capBytes: 1024,
    });
  });

  it('rejects a single write that exceeds cap on its own (zero pending)', () => {
    const t = new PendingWriteTracker(1024);
    expect(t.decide(2048)).toEqual({
      kind: 'reject',
      reason: 'pty.input_overflow',
      pendingWriteBytes: 0,
      attemptedBytes: 2048,
      capBytes: 1024,
    });
  });

  it('decide() does NOT mutate the tally', () => {
    const t = new PendingWriteTracker(1024);
    t.recordWrite(900);
    t.decide(200); // would reject; must not increment
    t.decide(50); // would accept; must not increment
    expect(t.pendingWriteBytes).toBe(900);
  });

  it('throws on negative / non-integer attemptedBytes', () => {
    const t = new PendingWriteTracker();
    expect(() => t.decide(-1)).toThrow(/non-negative integer/);
    expect(() => t.decide(1.5)).toThrow(/non-negative integer/);
  });
});

describe('PendingWriteTracker — write/drain accounting', () => {
  it('recordWrite increments, recordDrain decrements', () => {
    const t = new PendingWriteTracker(1024);
    t.recordWrite(400);
    expect(t.pendingWriteBytes).toBe(400);
    t.recordWrite(100);
    expect(t.pendingWriteBytes).toBe(500);
    t.recordDrain(150);
    expect(t.pendingWriteBytes).toBe(350);
  });

  it('recordDrain clamps at zero (over-drain is a no-op past empty)', () => {
    const t = new PendingWriteTracker(1024);
    t.recordWrite(100);
    t.recordDrain(500);
    expect(t.pendingWriteBytes).toBe(0);
  });

  it('write/drain interleaved — admission verdict reflects current pending', () => {
    const t = new PendingWriteTracker(1024);
    t.recordWrite(900);
    expect(t.decide(200).kind).toBe('reject');
    t.recordDrain(800);
    expect(t.decide(200).kind).toBe('accept');
  });

  it('throws on negative / non-integer recordWrite / recordDrain', () => {
    const t = new PendingWriteTracker();
    expect(() => t.recordWrite(-1)).toThrow(/non-negative integer/);
    expect(() => t.recordDrain(-1)).toThrow(/non-negative integer/);
    expect(() => t.recordWrite(1.5)).toThrow(/non-negative integer/);
  });
});

describe('PendingWriteTracker — full-cap walk (1 MiB)', () => {
  it('accepts a fill up to the cap then rejects the next byte', () => {
    const t = new PendingWriteTracker(); // 1 MiB
    t.recordWrite(PENDING_WRITE_CAP_BYTES);
    expect(t.pendingWriteBytes).toBe(PENDING_WRITE_CAP_BYTES);
    const v = t.decide(1);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') {
      expect(v.pendingWriteBytes).toBe(PENDING_WRITE_CAP_BYTES);
      expect(v.attemptedBytes).toBe(1);
      expect(v.capBytes).toBe(PENDING_WRITE_CAP_BYTES);
    }
  });

  it('after full drain, accepts a new 1 MiB write', () => {
    const t = new PendingWriteTracker();
    t.recordWrite(PENDING_WRITE_CAP_BYTES);
    t.recordDrain(PENDING_WRITE_CAP_BYTES);
    expect(t.decide(PENDING_WRITE_CAP_BYTES).kind).toBe('accept');
  });
});
