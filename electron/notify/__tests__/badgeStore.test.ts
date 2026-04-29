// Unit tests for the pure badge state store.
//
// These run in plain Node (no Electron) — that's the point of the split.
// The store is the *decider* tier: per-sid counters in / aggregate total
// out / change events emitted. No OS calls.

import { describe, it, expect, vi } from 'vitest';
import { BadgeManager } from '../badgeStore';

describe('BadgeManager (badgeStore)', () => {
  it('starts with total 0', () => {
    const m = new BadgeManager();
    expect(m.getTotal()).toBe(0);
  });

  it('incrementSid bumps per-sid counts', () => {
    const m = new BadgeManager();
    m.incrementSid('s1');
    m.incrementSid('s1');
    m.incrementSid('s2');
    expect(m.getTotal()).toBe(3);
  });

  it('clearSid removes a single sid; clearAll wipes all', () => {
    const m = new BadgeManager();
    m.incrementSid('s1');
    m.incrementSid('s1');
    m.incrementSid('s2');
    m.clearSid('s1');
    expect(m.getTotal()).toBe(1);
    m.clearAll();
    expect(m.getTotal()).toBe(0);
  });

  it('emits change on increment with current total', () => {
    const m = new BadgeManager();
    const seen: number[] = [];
    m.on('change', (n: number) => seen.push(n));
    m.incrementSid('s1');
    m.incrementSid('s1');
    m.incrementSid('s2');
    expect(seen).toEqual([1, 2, 3]);
  });

  it('emits change on clearSid only when sid was tracked', () => {
    const m = new BadgeManager();
    const spy = vi.fn();
    m.on('change', spy);
    m.clearSid('never-touched');
    expect(spy).not.toHaveBeenCalled();
    m.incrementSid('s1');
    spy.mockClear();
    m.clearSid('s1');
    expect(spy).toHaveBeenCalledWith(0);
  });

  it('emits change on clearAll only when there was state', () => {
    const m = new BadgeManager();
    const spy = vi.fn();
    m.on('change', spy);
    m.clearAll();
    expect(spy).not.toHaveBeenCalled();
    m.incrementSid('s1');
    spy.mockClear();
    m.clearAll();
    expect(spy).toHaveBeenCalledWith(0);
  });

  it('reapply re-emits the current total without mutating state', () => {
    const m = new BadgeManager();
    m.incrementSid('s1');
    m.incrementSid('s2');
    const spy = vi.fn();
    m.on('change', spy);
    m.reapply();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(2);
    expect(m.getTotal()).toBe(2);
  });

  it('ignores empty-string sid for both increment and clear', () => {
    const m = new BadgeManager();
    const spy = vi.fn();
    m.on('change', spy);
    m.incrementSid('');
    m.clearSid('');
    expect(spy).not.toHaveBeenCalled();
    expect(m.getTotal()).toBe(0);
  });
});
