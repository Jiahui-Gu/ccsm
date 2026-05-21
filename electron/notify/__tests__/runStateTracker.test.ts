import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRunStateTracker, RING_DEBOUNCE_MS } from '../runStateTracker';
import { decide, DEDUPE_MS, SHORT_TASK_MS } from '../notifyDecider';
import type { Decision } from '../notifyDecider';

const NOW = 1_700_000_000_000;

describe('runStateTracker — pure decider', () => {
  it('running → idle: fires a decision (Rule 5 unfocused branch); toast is deferred', () => {
    const fires: Decision[] = [];
    const t = createRunStateTracker(decide, {
      onDeferredToast: (d) => fires.push(d),
    });
    t.setFocused(false); // Rule 5: not focused → toast + flash
    expect(t.onTitle('s1', 'running', NOW)).toBeNull();
    expect(t._internals().runStartTs.get('s1')).toBe(NOW);
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec).not.toBeNull();
    expect(dec?.sid).toBe('s1');
    // Toast is debounced — immediate decision carries flash only.
    expect(dec?.toast).toBe(false);
    expect(dec?.flash).toBe(true);
    // runStartTs cleared after non-running title
    expect(t._internals().runStartTs.has('s1')).toBe(false);
    // lastFiredTs recorded (for the flash)
    expect(t._internals().lastFiredTs.get('s1')).toBe(NOW + 1_000);
    // A pending deferred toast is scheduled.
    expect(t._internals().pendingToastSids).toEqual(['s1']);
    expect(fires).toEqual([]);
    t.dispose();
  });

  it('dedupes back-to-back idle titles within DEDUPE_MS', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false);
    t.onTitle('s1', 'running', NOW);
    const first = t.onTitle('s1', 'idle', NOW + 100);
    expect(first).not.toBeNull();
    // Second idle within dedupe window — even with a fresh run in between
    t.onTitle('s1', 'running', NOW + 200);
    const second = t.onTitle('s1', 'idle', NOW + 100 + DEDUPE_MS - 1);
    expect(second).toBeNull();
    t.dispose();
  });

  it('mute window prevents toast (Rule 7) but flash still fires', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false);
    t.setMuted('s1', NOW + 60_000); // muted for the next minute
    t.onTitle('s1', 'running', NOW);
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec).not.toBeNull();
    expect(dec?.toast).toBe(false);
    expect(dec?.flash).toBe(true);
    // Muted sids must not even schedule a deferred toast (the timer would
    // be re-suppressed at fire-time anyway, so keep the pending-set tidy).
    expect(t._internals().pendingToastSids).toEqual([]);
    t.dispose();
  });

  it('expired mute (untilTs in the past) no longer suppresses toast', () => {
    const fires: Decision[] = [];
    const t = createRunStateTracker(decide, {
      onDeferredToast: (d) => fires.push(d),
    });
    t.setFocused(false);
    t.setMuted('s1', NOW - 1); // already expired
    t.onTitle('s1', 'running', NOW);
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    // Immediate is flash-only (toast deferred); pending toast exists.
    expect(dec?.toast).toBe(false);
    expect(dec?.flash).toBe(true);
    expect(t._internals().pendingToastSids).toEqual(['s1']);
    t.dispose();
  });

  it('setMuted(null) clears the mute', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false);
    t.setMuted('s1', Number.POSITIVE_INFINITY); // sticky mute
    t.setMuted('s1', null);
    t.onTitle('s1', 'running', NOW);
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    // Immediate flash fires; toast is deferred.
    expect(dec?.toast).toBe(false);
    expect(dec?.flash).toBe(true);
    expect(t._internals().pendingToastSids).toEqual(['s1']);
    t.dispose();
  });

  it('forgetSid clears all per-sid state', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false);
    // Populate user-input but with timestamp far in the past so Rule 1
    // doesn't suppress the fire (we still need lastFiredTs populated).
    t.markUserInput('s1', NOW - 10 * 60 * 1000);
    t.setMuted('s1', NOW + 100_000);
    t.onTitle('s1', 'running', NOW);
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec).not.toBeNull(); // ensures lastFiredTs got recorded

    const before = t._internals();
    expect(before.lastUserInputTs.has('s1')).toBe(true);
    expect(before.mutedSids.has('s1')).toBe(true);
    expect(before.lastFiredTs.has('s1')).toBe(true);

    t.forgetSid('s1');
    const after = t._internals();
    expect(after.runStartTs.has('s1')).toBe(false);
    expect(after.mutedSids.has('s1')).toBe(false);
    expect(after.lastFiredTs.has('s1')).toBe(false);
    expect(after.lastUserInputTs.has('s1')).toBe(false);
    expect(after.pendingToastSids).toEqual([]);
    t.dispose();
  });

  it('multiple sids tracked independently', () => {
    const fires: Decision[] = [];
    const t = createRunStateTracker(decide, {
      onDeferredToast: (d) => fires.push(d),
    });
    t.setFocused(false);
    t.onTitle('s1', 'running', NOW);
    t.onTitle('s2', 'running', NOW + 500);
    expect(t._internals().runStartTs.get('s1')).toBe(NOW);
    expect(t._internals().runStartTs.get('s2')).toBe(NOW + 500);

    const d1 = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(d1?.sid).toBe('s1');
    // s2 should still be running and unaffected
    expect(t._internals().runStartTs.get('s2')).toBe(NOW + 500);

    const d2 = t.onTitle('s2', 'idle', NOW + 2_000);
    expect(d2?.sid).toBe('s2');

    // Forgetting s1 doesn't touch s2
    t.forgetSid('s1');
    expect(t._internals().lastFiredTs.has('s2')).toBe(true);
    t.dispose();
  });

  it('classification "unknown" is a no-op', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false);
    expect(t.onTitle('s1', 'unknown', NOW)).toBeNull();
    expect(t._internals().runStartTs.has('s1')).toBe(false);
    expect(t._internals().lastFiredTs.has('s1')).toBe(false);
    t.dispose();
  });

  it('Rule 1: user-input within 60s suppresses fire', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false);
    t.markUserInput('s1', NOW);
    t.onTitle('s1', 'running', NOW + 100);
    // Idle 1s later — Rule 1 mute window still active
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec).toBeNull();
    t.dispose();
  });

  it('Rule 2 vs Rule 3: foreground active sid splits on SHORT_TASK_MS', () => {
    const fires: Decision[] = [];
    const t = createRunStateTracker(decide, {
      onDeferredToast: (d) => fires.push(d),
    });
    t.setFocused(true);
    t.setActiveSid('s1');

    // Short task — Rule 2: flash only, no toast → still a non-null Decision
    t.onTitle('s1', 'running', NOW);
    const shortDec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(shortDec).not.toBeNull();
    expect(shortDec?.toast).toBe(false);
    expect(shortDec?.flash).toBe(true);
    // Rule 2 doesn't toast → no deferred timer scheduled.
    expect(t._internals().pendingToastSids).toEqual([]);

    // Wait past dedupe, then long task — Rule 3: toast + flash.
    // Toast is debounced, so the immediate Decision still carries flash only;
    // the toast surfaces via the deferred callback.
    const t2 = NOW + DEDUPE_MS + 10_000;
    t.onTitle('s1', 'running', t2);
    const longDec = t.onTitle('s1', 'idle', t2 + SHORT_TASK_MS + 1_000);
    expect(longDec).not.toBeNull();
    expect(longDec?.toast).toBe(false);
    expect(longDec?.flash).toBe(true);
    expect(t._internals().pendingToastSids).toEqual(['s1']);
    t.dispose();
  });

  it('Rule 4: foreground but viewing a different sid → toast + flash (toast deferred)', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(true);
    t.setActiveSid('s2'); // viewing s2
    t.onTitle('s1', 'running', NOW);
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    // Toast debounced; immediate is flash-only.
    expect(dec?.toast).toBe(false);
    expect(dec?.flash).toBe(true);
    expect(t._internals().pendingToastSids).toEqual(['s1']);
    t.dispose();
  });

  it('runStartTs is cleared after every non-running title (even when no decision fires)', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false);
    t.markUserInput('s1', NOW); // forces Rule 1 → null decision
    t.onTitle('s1', 'running', NOW);
    expect(t._internals().runStartTs.has('s1')).toBe(true);
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec).toBeNull();
    expect(t._internals().runStartTs.has('s1')).toBe(false);
    t.dispose();
  });

  // ---------------------------------------------------------------------------
  // Task #767 regression — `hasObservedRunning` gate
  //
  // Before the gate, the very first 'idle' / 'waiting' OSC title for a sid
  // (which claude.exe emits within ~100-300ms of boot) would call decide()
  // with no runStartTs entry. notifyDecider Rule 2 then computed
  //   elapsed = start === undefined ? 0 : now - start  →  0
  //   0 < SHORT_TASK_MS (60s)                          →  TRUE
  // so it returned `{toast:false, flash:true}` unconditionally. flashSink
  // lit `flashStates[sid]=true` for FLASH_DURATION_MS (4s), driving 2.5
  // AgentIcon framer-motion breath cycles on every fresh / imported /
  // resumed session — the bug user reported in #767.
  //
  // Fix: producer-layer gate — skip decide() until we've seen a 'running'
  // title for this sid. notifyDecider stays pure / unchanged.
  // ---------------------------------------------------------------------------
  it('Task #767: does not fire when first title for a sid is "idle"', () => {
    const t = createRunStateTracker(decide);
    // Default focused=true + activeSid set to s1 reproduces the exact
    // foreground+active context where the unguarded code path tripped
    // Rule 2 ("foreground-active-short").
    t.setFocused(true);
    t.setActiveSid('s1');
    const dec = t.onTitle('s1', 'idle', NOW);
    expect(dec).toBeNull();
    // No mutation: lastFiredTs must stay empty (the bug also poisoned the
    // 5s dedupe window with a phantom fire).
    expect(t._internals().lastFiredTs.has('s1')).toBe(false);
    t.dispose();
  });

  it('Task #767: does not fire when first title for a sid is "waiting"', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(true);
    t.setActiveSid('s1');
    const dec = t.onTitle('s1', 'waiting', NOW);
    expect(dec).toBeNull();
    expect(t._internals().lastFiredTs.has('s1')).toBe(false);
    t.dispose();
  });

  it('Task #767 regression guard: still fires on idle AFTER a running title', () => {
    // Sanity check that the gate only suppresses the boot-time false
    // positive — once a real run has started, the existing rules apply
    // exactly as before. This is the critical regression case: if the
    // gate were too aggressive, legitimate Rule 2 flashes would silently
    // disappear.
    const t = createRunStateTracker(decide);
    t.setFocused(true);
    t.setActiveSid('s1');
    // Real run starts.
    expect(t.onTitle('s1', 'running', NOW)).toBeNull();
    // Run finishes 1s later → Rule 2 (foreground+active+short) fires.
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec).not.toBeNull();
    expect(dec?.toast).toBe(false);
    expect(dec?.flash).toBe(true);
    t.dispose();
  });

  it('Task #767: forgetSid resets the hasObservedRunning gate', () => {
    // After session teardown, a brand-new lifetime for the same sid (e.g.
    // re-import with a recycled id) must start gated again.
    const t = createRunStateTracker(decide);
    t.setFocused(true);
    t.setActiveSid('s1');
    t.onTitle('s1', 'running', NOW);
    const dec1 = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec1).not.toBeNull(); // gate open after running

    t.forgetSid('s1');

    // Without the forgetSid clearing hasObservedRunning, this fresh idle
    // would erroneously fire (gate would still be open from the previous
    // lifetime).
    const dec2 = t.onTitle('s1', 'idle', NOW + 10_000);
    expect(dec2).toBeNull();
    t.dispose();
  });
});

// ---------------------------------------------------------------------------
// "Ring the last waiting" debounce (toast-spam fix).
//
// Real-world burst: agent runs a long task with several mid-task permission
// prompts. Each prompt = a 'waiting' title; user answers in-app, agent
// resumes (next 'running'), next prompt arrives ~5s later. Pre-debounce
// the user got 3-5 toasts back-to-back. Post-debounce, each waiting
// (re)starts a RING_DEBOUNCE_MS timer; only the LAST waiting (i.e. the one
// where the agent actually gets stuck) fires a toast.
// ---------------------------------------------------------------------------
describe('runStateTracker — ring-last debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function newTracker(): { tracker: ReturnType<typeof createRunStateTracker>; fires: Decision[] } {
    const fires: Decision[] = [];
    const tracker = createRunStateTracker(decide, {
      onDeferredToast: (d) => fires.push(d),
      // nowFn defaults to Date.now which vi.useFakeTimers also patches.
    });
    return { tracker, fires };
  }

  it('edge case 1: quick waiting (title flips out before debounce) → no toast', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false); // Rule 5 path → would-toast
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    expect(tracker._internals().pendingToastSids).toEqual(['s1']);
    // User answers in-app: agent resumes BEFORE the debounce window closes.
    vi.advanceTimersByTime(2_000);
    tracker.onTitle('s1', 'running', NOW + 3_000);
    expect(tracker._internals().pendingToastSids).toEqual([]);
    // Advance well past the original deadline — no toast fires.
    vi.advanceTimersByTime(RING_DEBOUNCE_MS + 1_000);
    expect(fires).toEqual([]);
    tracker.dispose();
  });

  it('edge case 2: single sustained waiting → exactly one toast at +RING_DEBOUNCE_MS', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    // Advance past the debounce window — toast fires.
    vi.advanceTimersByTime(RING_DEBOUNCE_MS + 10);
    expect(fires.length).toBe(1);
    expect(fires[0]!.toast).toBe(true);
    expect(fires[0]!.flash).toBe(false);
    expect(fires[0]!.sid).toBe('s1');
    expect(tracker._internals().pendingToastSids).toEqual([]);
    tracker.dispose();
  });

  it('edge case 3: long task with 3 quick prompts then sustained → exactly one toast', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    // Initial run starts at NOW.
    tracker.onTitle('s1', 'running', NOW);
    // Prompt #1 at +5s; user answers in 2s (running at +7s).
    vi.advanceTimersByTime(5_000);
    tracker.onTitle('s1', 'idle', NOW + 5_000);
    vi.advanceTimersByTime(2_000); // timer not yet exhausted
    tracker.onTitle('s1', 'running', NOW + 7_000);
    expect(fires).toEqual([]);
    // Prompt #2 at +12s; user answers in 3s.
    vi.advanceTimersByTime(5_000);
    tracker.onTitle('s1', 'idle', NOW + 12_000);
    vi.advanceTimersByTime(3_000);
    tracker.onTitle('s1', 'running', NOW + 15_000);
    expect(fires).toEqual([]);
    // Prompt #3 at +20s; this one sticks (user is away).
    vi.advanceTimersByTime(5_000);
    tracker.onTitle('s1', 'idle', NOW + 20_000);
    // Advance the full debounce window.
    vi.advanceTimersByTime(RING_DEBOUNCE_MS + 10);
    expect(fires.length).toBe(1);
    expect(fires[0]!.sid).toBe('s1');
    tracker.dispose();
  });

  it('edge case 4a: Rule 1 (user-input) still suppresses at fire-time', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    // 2s into the wait, user touches the sid (e.g. presses Enter from inside
    // ccsm to take an action). The timer is still pending; at fire-time the
    // user-init window is active and suppresses the toast.
    vi.advanceTimersByTime(2_000);
    tracker.markUserInput('s1', NOW + 3_000);
    vi.advanceTimersByTime(RING_DEBOUNCE_MS); // fires at NOW + 9_000
    expect(fires).toEqual([]);
    tracker.dispose();
  });

  it('edge case 4b: Rule 7 (per-sid mute) still suppresses at fire-time', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    expect(tracker._internals().pendingToastSids).toEqual(['s1']);
    // Mute the sid during the wait — fire-time re-check suppresses.
    vi.advanceTimersByTime(2_000);
    tracker.setMuted('s1', Number.POSITIVE_INFINITY);
    vi.advanceTimersByTime(RING_DEBOUNCE_MS);
    expect(fires).toEqual([]);
    tracker.dispose();
  });

  it('edge case 5: multiple sids run independent timers', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s2', 'running', NOW + 100);
    // s1 starts waiting at +1s → deadline NOW+9_000.
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    // s2 starts waiting at +3s → deadline NOW+11_000.
    vi.advanceTimersByTime(2_000);
    tracker.onTitle('s2', 'idle', NOW + 3_000);
    expect(tracker._internals().pendingToastSids.sort()).toEqual(['s1', 's2']);
    // Advance to NOW+9_010 — only s1 fires.
    vi.advanceTimersByTime(6_010);
    expect(fires.length).toBe(1);
    expect(fires[0]!.sid).toBe('s1');
    expect(tracker._internals().pendingToastSids).toEqual(['s2']);
    // Advance to NOW+11_010 — s2 fires too.
    vi.advanceTimersByTime(2_000);
    expect(fires.length).toBe(2);
    expect(fires[1]!.sid).toBe('s2');
    tracker.dispose();
  });

  it('forgetSid cancels any pending deferred toast', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    expect(tracker._internals().pendingToastSids).toEqual(['s1']);
    tracker.forgetSid('s1');
    expect(tracker._internals().pendingToastSids).toEqual([]);
    vi.advanceTimersByTime(RING_DEBOUNCE_MS + 1_000);
    expect(fires).toEqual([]);
    tracker.dispose();
  });

  it('dispose cancels all pending deferred toasts', () => {
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    tracker.onTitle('s2', 'running', NOW + 100);
    tracker.onTitle('s2', 'idle', NOW + 1_100);
    expect(tracker._internals().pendingToastSids.length).toBe(2);
    tracker.dispose();
    expect(tracker._internals().pendingToastSids).toEqual([]);
    vi.advanceTimersByTime(RING_DEBOUNCE_MS + 1_000);
    expect(fires).toEqual([]);
  });

  it('two bursts past dedupe: the LAST waiting wins (timer pushed out by each fresh idle)', () => {
    // Burst pattern with running flips between idles. Each fresh idle past
    // the 5s dedupe window pushes the deadline out — only the final waiting
    // (no follow-up running) actually rings.
    const { tracker, fires } = newTracker();
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    // Idle #1 at +1s.
    tracker.onTitle('s1', 'idle', NOW + 1_000);
    // 6s later (past the 5s dedupe), agent resumes briefly.
    vi.advanceTimersByTime(6_000); // now NOW+7_000
    tracker.onTitle('s1', 'running', NOW + 7_000);
    // No fire yet — running cancelled the pending timer.
    expect(fires).toEqual([]);
    expect(tracker._internals().pendingToastSids).toEqual([]);
    // Idle #2 at +8s; this one sticks.
    vi.advanceTimersByTime(1_000); // now NOW+8_000
    tracker.onTitle('s1', 'idle', NOW + 8_000);
    // Deadline now NOW+16_000. Advance to NOW+15_500 — not fired yet.
    vi.advanceTimersByTime(7_500);
    expect(fires).toEqual([]);
    // Past the deadline.
    vi.advanceTimersByTime(1_000);
    expect(fires.length).toBe(1);
    expect(fires[0]!.sid).toBe('s1');
    tracker.dispose();
  });
});
