// Unit tests for the per-session pty-host snapshot scheduler (T4.10, ch06 §4).
//
// Drives the decider with an injected fake clock + fake timer so the four
// trigger rules (K_TIME / M_DELTAS / B_BYTES / Resize with 500ms coalescing)
// can be asserted deterministically without sleeping or spawning a real pty.

import { describe, expect, it } from 'vitest';

import {
  K_TIME_MS,
  M_DELTAS,
  B_BYTES,
  type Clock,
  type TimerOps,
} from '../../pty/segmentation.js';
import {
  SnapshotScheduler,
  RESIZE_COALESCE_WINDOW_MS,
  type SnapshotReason,
} from '../snapshot-scheduler.js';

interface PendingTimer {
  cb: () => void;
  fireAtMs: number;
  cleared: boolean;
}

function makeFakeEnv(startMs = 1_000_000): {
  clock: Clock;
  timer: TimerOps;
  advance: (ms: number) => void;
  pendingCount: () => number;
} {
  let nowMs = startMs;
  const pending: PendingTimer[] = [];

  const clock: Clock = () => nowMs;
  const timer: TimerOps = {
    setTimer(cb, delayMs) {
      const t: PendingTimer = { cb, fireAtMs: nowMs + delayMs, cleared: false };
      pending.push(t);
      return t;
    },
    clearTimer(h) {
      const t = h as PendingTimer;
      t.cleared = true;
      const idx = pending.indexOf(t);
      if (idx >= 0) pending.splice(idx, 1);
    },
  };

  function advance(ms: number): void {
    nowMs += ms;
    // Fire any pending timers whose deadline has passed, in deadline order.
    // Loop because timer callbacks may schedule new timers at the same now.
    for (;;) {
      const due = pending
        .filter((t) => !t.cleared && t.fireAtMs <= nowMs)
        .sort((a, b) => a.fireAtMs - b.fireAtMs);
      if (due.length === 0) return;
      const t = due[0];
      const idx = pending.indexOf(t);
      if (idx >= 0) pending.splice(idx, 1);
      t.cb();
    }
  }

  return {
    clock,
    timer,
    advance,
    pendingCount: () => pending.filter((t) => !t.cleared).length,
  };
}

function makeRecorder(): {
  fired: SnapshotReason[];
  onSnapshot: (r: SnapshotReason) => void;
} {
  const fired: SnapshotReason[] = [];
  return {
    fired,
    onSnapshot: (r) => {
      fired.push(r);
    },
  };
}

describe('SnapshotScheduler — M_DELTAS trigger', () => {
  it('does not fire before M_DELTAS deltas', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    for (let i = 0; i < M_DELTAS - 1; i++) sched.noteDelta(1);
    expect(rec.fired).toEqual([]);
    expect(sched.deltasSinceLastSnapshot()).toBe(M_DELTAS - 1);
  });

  it('fires exactly once when the M_DELTAS-th delta arrives and resets counters', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    for (let i = 0; i < M_DELTAS; i++) sched.noteDelta(1);
    expect(rec.fired).toEqual(['deltas']);
    expect(sched.deltasSinceLastSnapshot()).toBe(0);
    expect(sched.bytesSinceLastSnapshot()).toBe(0);
  });

  it('fires twice across two full M_DELTAS cycles', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    for (let i = 0; i < M_DELTAS * 2; i++) sched.noteDelta(1);
    expect(rec.fired).toEqual(['deltas', 'deltas']);
  });
});

describe('SnapshotScheduler — B_BYTES trigger', () => {
  it('fires on the delta that crosses B_BYTES', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    // Two slightly-under-half deltas stay below B_BYTES; a small third
    // delta crosses. Stays well clear of M_DELTAS (3 << 256).
    const underHalf = Math.floor(B_BYTES / 2) - 1;
    sched.noteDelta(underHalf);
    sched.noteDelta(underHalf);
    expect(rec.fired).toEqual([]);
    sched.noteDelta(2); // crosses by 0 → 1 over B_BYTES
    expect(rec.fired).toEqual(['bytes']);
    expect(sched.bytesSinceLastSnapshot()).toBe(0);
    expect(sched.deltasSinceLastSnapshot()).toBe(0);
  });

  it('treats negative byteCount as zero (no contribution to B_BYTES)', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    sched.noteDelta(-100);
    expect(sched.bytesSinceLastSnapshot()).toBe(0);
    expect(sched.deltasSinceLastSnapshot()).toBe(1);
  });

  it('M_DELTAS wins ordering when both thresholds cross in the same noteDelta', () => {
    // A pathological large-payload stream where each delta is large enough
    // that M_DELTAS deltas cumulatively exceed B_BYTES — both thresholds
    // cross on the M_DELTAS-th call. Spec says either reason is valid; we
    // pin the ordering to `deltas` so the report is deterministic.
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    const perDelta = Math.ceil(B_BYTES / M_DELTAS) + 1; // ensures byte cross at delta #M_DELTAS
    for (let i = 0; i < M_DELTAS; i++) sched.noteDelta(perDelta);
    expect(rec.fired).toEqual(['deltas']);
  });
});

describe('SnapshotScheduler — K_TIME trigger', () => {
  it('does NOT fire after K_TIME_MS if no delta arrived in the window', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    env.advance(K_TIME_MS * 2);
    expect(rec.fired).toEqual([]);
  });

  it('fires after K_TIME_MS once at least one delta has arrived', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    env.advance(1000);
    sched.noteDelta(64); // arms K_TIME timer; remaining = K_TIME_MS - 1000
    env.advance(K_TIME_MS - 1001); // 1 ms before deadline
    expect(rec.fired).toEqual([]);
    env.advance(2); // crosses deadline
    expect(rec.fired).toEqual(['time']);
    expect(sched.deltasSinceLastSnapshot()).toBe(0);
  });

  it('fires immediately if a delta arrives after K_TIME_MS has already elapsed (idle session)', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    // No deltas during the entire 30s window.
    env.advance(K_TIME_MS + 100);
    expect(rec.fired).toEqual([]);
    sched.noteDelta(1); // both clauses now true → fire synchronously
    expect(rec.fired).toEqual(['time']);
  });

  it('K_TIME timer is rearmed against the new baseline after a snapshot', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    // Burst to fire M_DELTAS, baseline reset.
    for (let i = 0; i < M_DELTAS; i++) sched.noteDelta(1);
    expect(rec.fired).toEqual(['deltas']);
    // Now wait nearly K_TIME but produce one delta then wait the rest.
    env.advance(5_000);
    sched.noteDelta(1);
    env.advance(K_TIME_MS - 5_000 - 1);
    expect(rec.fired).toEqual(['deltas']);
    env.advance(2);
    expect(rec.fired).toEqual(['deltas', 'time']);
  });
});

describe('SnapshotScheduler — Resize trigger + 500ms coalescing', () => {
  it('a single Resize fires a snapshot after RESIZE_COALESCE_WINDOW_MS', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    sched.noteResize();
    expect(rec.fired).toEqual([]);
    env.advance(RESIZE_COALESCE_WINDOW_MS - 1);
    expect(rec.fired).toEqual([]);
    env.advance(1);
    expect(rec.fired).toEqual(['resize']);
  });

  it('coalesces a burst of Resizes into a single snapshot at the end of the 500ms window', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    // 30 resizes over 480ms (drag-resize @ ~60Hz).
    for (let i = 0; i < 30; i++) {
      sched.noteResize();
      env.advance(16);
    }
    expect(rec.fired).toEqual([]); // still inside the first 500ms window
    env.advance(RESIZE_COALESCE_WINDOW_MS); // well past the deadline
    expect(rec.fired).toEqual(['resize']);
  });

  it('a Resize after the previous coalescing window starts a fresh window', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    sched.noteResize();
    env.advance(RESIZE_COALESCE_WINDOW_MS);
    expect(rec.fired).toEqual(['resize']);
    sched.noteResize();
    env.advance(RESIZE_COALESCE_WINDOW_MS);
    expect(rec.fired).toEqual(['resize', 'resize']);
  });
});

describe('SnapshotScheduler — interaction between triggers', () => {
  it('a Resize during a delta burst still produces a separate resize snapshot', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    // Burst that fires deltas trigger.
    for (let i = 0; i < M_DELTAS; i++) sched.noteDelta(1);
    expect(rec.fired).toEqual(['deltas']);
    // Resize 200ms later.
    env.advance(200);
    sched.noteResize();
    env.advance(RESIZE_COALESCE_WINDOW_MS);
    expect(rec.fired).toEqual(['deltas', 'resize']);
  });

  it('dispose() prevents any further snapshots and cancels pending timers', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    sched.noteDelta(1); // arms K_TIME
    sched.noteResize(); // arms resize coalescing
    expect(env.pendingCount()).toBe(2);
    sched.dispose();
    expect(env.pendingCount()).toBe(0);
    env.advance(K_TIME_MS * 10);
    expect(rec.fired).toEqual([]);
    // post-dispose calls are no-ops
    sched.noteDelta(B_BYTES);
    sched.noteResize();
    env.advance(K_TIME_MS);
    expect(rec.fired).toEqual([]);
  });

  it('dispose() is idempotent', () => {
    const env = makeFakeEnv();
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    sched.dispose();
    expect(() => sched.dispose()).not.toThrow();
  });

  it('lastSnapshotAtMs() advances on each fire', () => {
    const env = makeFakeEnv(1_000_000);
    const rec = makeRecorder();
    const sched = new SnapshotScheduler({
      onSnapshot: rec.onSnapshot,
      now: env.clock,
      timer: env.timer,
    });
    expect(sched.lastSnapshotAtMs()).toBe(1_000_000);
    env.advance(123);
    for (let i = 0; i < M_DELTAS; i++) sched.noteDelta(1);
    expect(sched.lastSnapshotAtMs()).toBe(1_000_123);
  });
});
