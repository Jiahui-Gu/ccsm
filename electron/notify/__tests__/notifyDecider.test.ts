import { describe, it, expect } from 'vitest';
import {
  decide,
  USER_INIT_MUTE_MS,
  SHORT_TASK_MS,
  DEDUPE_MS,
  type Ctx,
  type Event,
} from '../notifyDecider';

const NOW = 1_700_000_000_000;

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    focused: true,
    activeSid: null,
    lastUserInputTs: new Map(),
    runStartTs: new Map(),
    mutedSids: new Set(),
    lastFiredTs: new Map(),
    now: NOW,
    ...overrides,
  };
}

function waiting(sid: string, ts: number = NOW): Event {
  return { type: 'osc-title', sid, title: 'waiting', ts };
}

describe('notifyDecider — 7 rules', () => {
  it('rule 1: user-init mute within 60s suppresses everything', () => {
    const ctx = makeCtx({
      focused: false, // even with backgrounded ccsm, mute wins
      lastUserInputTs: new Map([['s1', NOW - 30_000]]),
    });
    expect(decide(waiting('s1'), ctx)).toBeNull();
  });

  it('rule 1 boundary: > 60s ago no longer mutes — falls to other rule (unfocused)', () => {
    const ctx = makeCtx({
      focused: false,
      lastUserInputTs: new Map([['s1', NOW - (USER_INIT_MUTE_MS + 1_000)]]),
    });
    expect(decide(waiting('s1'), ctx)).toEqual({
      sid: 's1',
      toast: true,
      flash: true,
    });
  });

  it('rule 2: foreground + active sid + short task → flash only, no toast', () => {
    const ctx = makeCtx({
      focused: true,
      activeSid: 's1',
      runStartTs: new Map([['s1', NOW - 30_000]]),
    });
    expect(decide(waiting('s1'), ctx)).toEqual({
      sid: 's1',
      toast: false,
      flash: true,
    });
  });

  it('rule 3: foreground + active sid + long task (>= 60s) → toast + flash', () => {
    const ctx = makeCtx({
      focused: true,
      activeSid: 's1',
      runStartTs: new Map([['s1', NOW - (SHORT_TASK_MS + 1_000)]]),
    });
    expect(decide(waiting('s1'), ctx)).toEqual({
      sid: 's1',
      toast: true,
      flash: true,
    });
  });

  it('rule 4: foreground but viewing other sid → toast + flash on the firing sid', () => {
    const ctx = makeCtx({
      focused: true,
      activeSid: 'other',
      runStartTs: new Map([['s1', NOW - 5_000]]),
    });
    expect(decide(waiting('s1'), ctx)).toEqual({
      sid: 's1',
      toast: true,
      flash: true,
    });
  });

  it('rule 5: ccsm not focused → toast + flash', () => {
    const ctx = makeCtx({ focused: false });
    expect(decide(waiting('s1'), ctx)).toEqual({
      sid: 's1',
      toast: true,
      flash: true,
    });
  });

  it('rule 6: multi-sid background concurrent — each sid evaluated independently', () => {
    const ctx = makeCtx({
      focused: false,
      activeSid: null,
    });
    const a = decide(waiting('sid-A'), ctx);
    const b = decide(waiting('sid-B'), ctx);
    expect(a).toEqual({ sid: 'sid-A', toast: true, flash: true });
    expect(b).toEqual({ sid: 'sid-B', toast: true, flash: true });
    // Decisions are independent — neither sid affects the other's evaluation,
    // and dedupe is per-sid (verified separately).
  });

  it('rule 7: muted sid → flash only, toast suppressed (even unfocused)', () => {
    const ctx = makeCtx({
      focused: false,
      mutedSids: new Set(['s1']),
    });
    expect(decide(waiting('s1'), ctx)).toEqual({
      sid: 's1',
      toast: false,
      flash: true,
    });
  });

  it('rule 7: muted + foreground active short task → still flash only, no toast', () => {
    const ctx = makeCtx({
      focused: true,
      activeSid: 's1',
      runStartTs: new Map([['s1', NOW - 10_000]]),
      mutedSids: new Set(['s1']),
    });
    expect(decide(waiting('s1'), ctx)).toEqual({
      sid: 's1',
      toast: false,
      flash: true,
    });
  });
});

describe('notifyDecider — dedupe', () => {
  it('suppresses fire when last fired within 5s', () => {
    const ctx = makeCtx({
      focused: false,
      lastFiredTs: new Map([['s1', NOW - 3_000]]),
    });
    expect(decide(waiting('s1'), ctx)).toBeNull();
  });

  it('boundary: last fired > 5s ago — fires normally', () => {
    const ctx = makeCtx({
      focused: false,
      lastFiredTs: new Map([['s1', NOW - (DEDUPE_MS + 1_000)]]),
    });
    expect(decide(waiting('s1'), ctx)).toEqual({
      sid: 's1',
      toast: true,
      flash: true,
    });
  });

  it('dedupe is per-sid — fire on sid-B not blocked by recent sid-A', () => {
    const ctx = makeCtx({
      focused: false,
      lastFiredTs: new Map([['sid-A', NOW - 1_000]]),
    });
    expect(decide(waiting('sid-A'), ctx)).toBeNull();
    expect(decide(waiting('sid-B'), ctx)).toEqual({
      sid: 'sid-B',
      toast: true,
      flash: true,
    });
  });
});

describe('notifyDecider — context-update-only events return null', () => {
  it('window-focus-change returns null', () => {
    const ctx = makeCtx();
    expect(
      decide({ type: 'window-focus-change', focused: true }, ctx),
    ).toBeNull();
    expect(
      decide({ type: 'window-focus-change', focused: false }, ctx),
    ).toBeNull();
  });

  it('active-sid-change returns null', () => {
    const ctx = makeCtx();
    expect(
      decide({ type: 'active-sid-change', sid: 's1' }, ctx),
    ).toBeNull();
    expect(
      decide({ type: 'active-sid-change', sid: null }, ctx),
    ).toBeNull();
  });

  it('user-input returns null', () => {
    const ctx = makeCtx();
    expect(
      decide({ type: 'user-input', sid: 's1', ts: NOW }, ctx),
    ).toBeNull();
  });

  it('non-waiting OSC title returns null', () => {
    const ctx = makeCtx();
    expect(
      decide(
        { type: 'osc-title', sid: 's1', title: '⠂ Claude Code', ts: NOW },
        ctx,
      ),
    ).toBeNull();
  });
});

describe('notifyDecider — purity', () => {
  it('does not mutate the ctx maps/sets', () => {
    const lastUserInputTs = new Map([['s1', NOW - 30_000]]);
    const runStartTs = new Map([['s1', NOW - 10_000]]);
    const mutedSids = new Set(['s2']);
    const lastFiredTs = new Map([['s1', NOW - 10_000]]);
    const ctx: Ctx = {
      focused: false,
      activeSid: 's1',
      lastUserInputTs,
      runStartTs,
      mutedSids,
      lastFiredTs,
      now: NOW,
    };
    decide(waiting('s1'), ctx);
    decide(waiting('s2'), ctx);
    decide({ type: 'user-input', sid: 's3', ts: NOW }, ctx);

    expect(lastUserInputTs.size).toBe(1);
    expect(lastUserInputTs.get('s1')).toBe(NOW - 30_000);
    expect(runStartTs.size).toBe(1);
    expect(mutedSids.size).toBe(1);
    expect(lastFiredTs.size).toBe(1);
  });
});
