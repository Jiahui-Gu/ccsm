// B9 (Task #25) — dev-mode parent watchdog tests.
//
// Reverse-verify pairing (per dev.md §2 phase-4): with the watchdog
// removed from `daemon/src/index.ts`, the integration-style "parent
// gone → onParentGone fires" test would still pass at the unit level
// (this file tests the module in isolation). The reverse-verify
// against the actual leak lives in scripts/check-no-stray-daemon.mjs
// (Task brief step 5: simulate 5 nodemon restart cycles, count
// surviving PIDs == 1).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkParent,
  startDevParentWatchdog,
} from '../dev-parent-watchdog.js';

describe('checkParent (pure decider)', () => {
  it('returns "alive" when kill(ppid, 0) succeeds', () => {
    const kill = vi.fn();
    expect(checkParent(1234, { kill })).toBe('alive');
    expect(kill).toHaveBeenCalledWith(1234, 0);
  });

  it('returns "gone" on ESRCH', () => {
    const kill = vi.fn(() => {
      const err = new Error('No such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(checkParent(9999, { kill })).toBe('gone');
  });

  it('returns "unknown" on EPERM (do NOT self-kill on transient perms)', () => {
    const kill = vi.fn(() => {
      const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(checkParent(42, { kill })).toBe('unknown');
  });

  it('returns "unknown" on errors with no .code', () => {
    const kill = vi.fn(() => {
      throw new Error('mystery');
    });
    expect(checkParent(42, { kill })).toBe('unknown');
  });
});

describe('startDevParentWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls at the configured interval and fires onParentGone exactly once on ESRCH', () => {
    let aliveTicks = 3;
    const kill = vi.fn((_pid: number, _signal: 0) => {
      if (aliveTicks > 0) {
        aliveTicks--;
        return;
      }
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    const onParentGone = vi.fn();

    startDevParentWatchdog({
      ppid: 5555,
      intervalMs: 100,
      onParentGone,
      kill,
    });

    // Tick #1, #2, #3 — parent alive.
    vi.advanceTimersByTime(300);
    expect(onParentGone).not.toHaveBeenCalled();

    // Tick #4 — parent gone.
    vi.advanceTimersByTime(100);
    expect(onParentGone).toHaveBeenCalledTimes(1);

    // Subsequent ticks must not re-fire (idempotency: timer was cleared).
    vi.advanceTimersByTime(1000);
    expect(onParentGone).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onParentGone when probe returns "unknown" (EPERM)', () => {
    const kill = vi.fn(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    const onParentGone = vi.fn();
    const onUnknown = vi.fn();

    startDevParentWatchdog({
      ppid: 7777,
      intervalMs: 50,
      onParentGone,
      onUnknown,
      kill,
    });

    vi.advanceTimersByTime(500);
    expect(onParentGone).not.toHaveBeenCalled();
    // onUnknown is rate-limited to once even across many ticks.
    expect(onUnknown).toHaveBeenCalledTimes(1);
    expect(onUnknown).toHaveBeenCalledWith(7777);
  });

  it('handle.stop() halts polling without firing onParentGone', () => {
    const kill = vi.fn();
    const onParentGone = vi.fn();
    const handle = startDevParentWatchdog({
      ppid: 1,
      intervalMs: 100,
      onParentGone,
      kill,
    });

    vi.advanceTimersByTime(250);
    expect(kill).toHaveBeenCalled();
    const callsBeforeStop = kill.mock.calls.length;

    handle.stop();
    vi.advanceTimersByTime(1000);
    expect(kill.mock.calls.length).toBe(callsBeforeStop);
    expect(onParentGone).not.toHaveBeenCalled();
  });

  it('uses default 500ms interval when none provided', () => {
    const kill = vi.fn();
    const onParentGone = vi.fn();
    startDevParentWatchdog({ ppid: 1, onParentGone, kill });

    vi.advanceTimersByTime(499);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
