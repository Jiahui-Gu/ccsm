import { describe, it, expect } from 'vitest';
import { createRunStateTracker } from '../runStateTracker.js';
import { decide, DEDUPE_MS, SHORT_TASK_MS } from '../notifyDecider.js';

const NOW = 1_700_000_000_000;

describe('runStateTracker — pure decider', () => {
  it('running → idle: fires a decision (Rule 5 unfocused branch)', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false); // Rule 5: not focused → toast + flash
    expect(t.onTitle('s1', 'running', NOW)).toBeNull();
    expect(t._internals().runStartTs.get('s1')).toBe(NOW);
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec).not.toBeNull();
    expect(dec?.sid).toBe('s1');
    expect(dec?.toast).toBe(true);
    expect(dec?.flash).toBe(true);
    // runStartTs cleared after non-running title
    expect(t._internals().runStartTs.has('s1')).toBe(false);
    // lastFiredTs recorded
    expect(t._internals().lastFiredTs.get('s1')).toBe(NOW + 1_000);
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
  });

  it('expired mute (untilTs in the past) no longer suppresses toast', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false);
    t.setMuted('s1', NOW - 1); // already expired
    t.onTitle('s1', 'running', NOW);
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec?.toast).toBe(true);
  });

  it('setMuted(null) clears the mute', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false);
    t.setMuted('s1', Number.POSITIVE_INFINITY); // sticky mute
    t.setMuted('s1', null);
    t.onTitle('s1', 'running', NOW);
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec?.toast).toBe(true);
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
  });

  it('multiple sids tracked independently', () => {
    const t = createRunStateTracker(decide);
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
  });

  it('classification "unknown" is a no-op', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false);
    expect(t.onTitle('s1', 'unknown', NOW)).toBeNull();
    expect(t._internals().runStartTs.has('s1')).toBe(false);
    expect(t._internals().lastFiredTs.has('s1')).toBe(false);
  });

  it('Rule 1: user-input within 60s suppresses fire', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(false);
    t.markUserInput('s1', NOW);
    t.onTitle('s1', 'running', NOW + 100);
    // Idle 1s later — Rule 1 mute window still active
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec).toBeNull();
  });

  it('Rule 2 vs Rule 3: foreground active sid splits on SHORT_TASK_MS', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(true);
    t.setActiveSid('s1');

    // Short task — Rule 2: flash only, no toast → still a non-null Decision
    t.onTitle('s1', 'running', NOW);
    const shortDec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(shortDec).not.toBeNull();
    expect(shortDec?.toast).toBe(false);
    expect(shortDec?.flash).toBe(true);

    // Wait past dedupe, then long task — Rule 3: toast + flash
    const t2 = NOW + DEDUPE_MS + 10_000;
    t.onTitle('s1', 'running', t2);
    const longDec = t.onTitle('s1', 'idle', t2 + SHORT_TASK_MS + 1_000);
    expect(longDec).not.toBeNull();
    expect(longDec?.toast).toBe(true);
    expect(longDec?.flash).toBe(true);
  });

  it('Rule 4: foreground but viewing a different sid → toast + flash', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(true);
    t.setActiveSid('s2'); // viewing s2
    t.onTitle('s1', 'running', NOW);
    const dec = t.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec?.toast).toBe(true);
    expect(dec?.flash).toBe(true);
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
  });

  it('Task #767: does not fire when first title for a sid is "waiting"', () => {
    const t = createRunStateTracker(decide);
    t.setFocused(true);
    t.setActiveSid('s1');
    const dec = t.onTitle('s1', 'waiting', NOW);
    expect(dec).toBeNull();
    expect(t._internals().lastFiredTs.has('s1')).toBe(false);
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
  });
});
