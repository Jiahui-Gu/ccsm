import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRunStateTracker, IDLE_CONFIRM_MS } from '../runStateTracker';
import { decide } from '../notifyDecider';
import type { Decision } from '../notifyDecider';

const NOW = 1_700_000_000_000;

describe('runStateTracker — idle confirmation window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function newTracker(): {
    tracker: ReturnType<typeof createRunStateTracker>;
    fires: Decision[];
  } {
    const fires: Decision[] = [];
    const tracker = createRunStateTracker(decide, {
      onConfirmedIdle: (d) => fires.push(d),
    });
    return { tracker, fires };
  }

  it('onTitle never returns a synchronous decision', () => {
    const { tracker } = newTracker();
    tracker.setFocused(false);
    expect(tracker.onTitle('s1', 'running', NOW)).toBeNull();
    expect(tracker.onTitle('s1', 'idle', NOW + 1_000)).toBeNull();
    tracker.dispose();
  });

  it('idle → running within the window → no notification (mid-task pause)', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    expect(tracker._internals().pendingIdleSids).toEqual(['s1']);
    // CLI resumes itself before the window closes.
    vi.advanceTimersByTime(IDLE_CONFIRM_MS - 100);
    tracker.onTitle('s1', 'running', NOW + IDLE_CONFIRM_MS - 100);
    expect(tracker._internals().pendingIdleSids).toEqual([]);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 1_000);
    expect(fires).toEqual([]);
    tracker.dispose();
  });

  it('idle → silence >= window → exactly one notification (real stop)', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 10);
    expect(fires.length).toBe(1);
    expect(fires[0]!.sid).toBe('s1');
    expect(fires[0]!.toast).toBe(true); // unfocused → Rule 5
    expect(fires[0]!.flash).toBe(true);
    expect(tracker._internals().pendingIdleSids).toEqual([]);
    tracker.dispose();
  });

  it('idle jitter burst → running within window → no notification', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    vi.advanceTimersByTime(200);
    tracker.onTitle('s1', 'idle', NOW + 1_200); // jitter resets timer
    vi.advanceTimersByTime(200);
    tracker.onTitle('s1', 'idle', NOW + 1_400);
    vi.advanceTimersByTime(200);
    tracker.onTitle('s1', 'running', NOW + 1_600); // CLI resumes
    expect(tracker._internals().pendingIdleSids).toEqual([]);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 1_000);
    expect(fires).toEqual([]);
    tracker.dispose();
  });

  it('idle → idle → silence >= window → fires exactly once (resets, single fire)', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    vi.advanceTimersByTime(500);
    tracker.onTitle('s1', 'idle', NOW + 1_500); // resets the window
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 10);
    expect(fires.length).toBe(1);
    tracker.dispose();
  });

  it('boot gate: idle with no prior running → no notification', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(true);
    tracker.setActiveSid('s1');
    tracker.onTitle('s1', 'idle', NOW);
    expect(tracker._internals().pendingIdleSids).toEqual([]);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 1_000);
    expect(fires).toEqual([]);
    tracker.dispose();
  });

  it('confirmed idle while unfocused → toast + flash', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 10);
    expect(fires).toEqual([{ sid: 's1', toast: true, flash: true }]);
    tracker.dispose();
  });

  it('confirmed idle while focused + active sid → flash only', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(true);
    tracker.setActiveSid('s1');
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 10);
    expect(fires).toEqual([{ sid: 's1', toast: false, flash: true }]);
    tracker.dispose();
  });

  it('confirmed idle while muted → flash only, no toast', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.setMuted('s1', Number.POSITIVE_INFINITY);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 10);
    expect(fires).toEqual([{ sid: 's1', toast: false, flash: true }]);
    tracker.dispose();
  });

  it('forgetSid cancels a pending idle-confirm timer (no fire after teardown)', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    expect(tracker._internals().pendingIdleSids).toEqual(['s1']);
    tracker.forgetSid('s1');
    expect(tracker._internals().pendingIdleSids).toEqual([]);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 1_000);
    expect(fires).toEqual([]);
    tracker.dispose();
  });

  it('dispose cancels all pending idle-confirm timers', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    tracker.onTitle('s2', 'running', NOW + 100);
    tracker.onTitle('s2', 'idle', NOW + 1_100);
    expect(tracker._internals().pendingIdleSids.length).toBe(2);
    tracker.dispose();
    expect(tracker._internals().pendingIdleSids).toEqual([]);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 1_000);
    expect(fires).toEqual([]);
  });

  it('Rule 1: user-input within 60s suppresses the confirmed-idle fire', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.markUserInput('s1', NOW);
    tracker.onTitle('s1', 'running', NOW + 100);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 10);
    expect(fires).toEqual([]);
    tracker.dispose();
  });

  it('multiple sids run independent windows', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s2', 'running', NOW + 100);
    tracker.onTitle('s1', 'idle', NOW + 1_000); // deadline NOW+1000+window
    vi.advanceTimersByTime(500);
    tracker.onTitle('s2', 'idle', NOW + 1_500); // deadline NOW+1500+window
    expect(tracker._internals().pendingIdleSids.sort()).toEqual(['s1', 's2']);
    // Advance just past s1's deadline.
    vi.advanceTimersByTime(IDLE_CONFIRM_MS - 500 + 10);
    expect(fires.length).toBe(1);
    expect(fires[0]!.sid).toBe('s1');
    expect(tracker._internals().pendingIdleSids).toEqual(['s2']);
    // Advance past s2's deadline.
    vi.advanceTimersByTime(500);
    expect(fires.length).toBe(2);
    expect(fires[1]!.sid).toBe('s2');
    tracker.dispose();
  });

  it('classification "unknown" is a no-op (does not start or cancel a window)', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    tracker.onTitle('s1', 'unknown', NOW + 1_500); // must NOT cancel
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 10);
    expect(fires.length).toBe(1);
    tracker.dispose();
  });

  it('Task #767: forgetSid resets the hasObservedRunning gate', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 10);
    expect(fires.length).toBe(1); // gate open after running
    tracker.forgetSid('s1');
    // Fresh idle with no new running — gate closed again.
    tracker.onTitle('s1', 'idle', NOW + 20_000);
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 10);
    expect(fires.length).toBe(1); // no second fire
    tracker.dispose();
  });
});
