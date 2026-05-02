// Minimal vitest for the lifecycle state machine + boot_id stability.
// T1.1 scope only — T1.4/T1.7/T5.1 own their own tests when those phases
// gain real bodies.

import { describe, expect, it } from 'vitest';
import { Lifecycle, Phase, PhaseTransitionError } from './lifecycle.js';
import { bootId } from './boot-id.js';
import { buildDaemonEnv, RESERVED_FOR_LISTENER_B } from './env.js';

describe('Lifecycle', () => {
  it('starts in PRE_START', () => {
    const lc = new Lifecycle();
    expect(lc.currentPhase()).toBe(Phase.PRE_START);
    expect(lc.isReady()).toBe(false);
    expect(lc.failure()).toBeNull();
  });

  it('advances forward through every phase in order', () => {
    const lc = new Lifecycle();
    const seen: Phase[] = [];
    lc.onTransition((p) => seen.push(p));

    lc.advanceTo(Phase.LOADING_CONFIG);
    lc.advanceTo(Phase.OPENING_DB);
    lc.advanceTo(Phase.RESTORING_SESSIONS);
    lc.advanceTo(Phase.STARTING_LISTENERS);
    lc.advanceTo(Phase.READY);

    expect(seen).toEqual([
      Phase.LOADING_CONFIG,
      Phase.OPENING_DB,
      Phase.RESTORING_SESSIONS,
      Phase.STARTING_LISTENERS,
      Phase.READY,
    ]);
    expect(lc.isReady()).toBe(true);
  });

  it('rejects skipping a phase', () => {
    const lc = new Lifecycle();
    expect(() => lc.advanceTo(Phase.OPENING_DB)).toThrow(PhaseTransitionError);
    expect(lc.currentPhase()).toBe(Phase.PRE_START);
  });

  it('rejects going backwards', () => {
    const lc = new Lifecycle();
    lc.advanceTo(Phase.LOADING_CONFIG);
    expect(() => lc.advanceTo(Phase.PRE_START)).toThrow(PhaseTransitionError);
  });

  it('records a failure and refuses further transitions', () => {
    const lc = new Lifecycle();
    lc.advanceTo(Phase.LOADING_CONFIG);
    lc.fail(new Error('disk full'));
    expect(lc.failure()).toMatchObject({ phase: Phase.LOADING_CONFIG });
    expect(lc.failure()?.error.message).toBe('disk full');
    expect(lc.isReady()).toBe(false);
    expect(() => lc.advanceTo(Phase.OPENING_DB)).toThrow(PhaseTransitionError);
  });

  it('keeps the first failure even if fail() is called twice', () => {
    const lc = new Lifecycle();
    lc.fail(new Error('first'));
    lc.fail(new Error('second'));
    expect(lc.failure()?.error.message).toBe('first');
  });

  it('unsubscribes listeners cleanly', () => {
    const lc = new Lifecycle();
    let count = 0;
    const off = lc.onTransition(() => {
      count += 1;
    });
    lc.advanceTo(Phase.LOADING_CONFIG);
    off();
    lc.advanceTo(Phase.OPENING_DB);
    expect(count).toBe(1);
  });
});

describe('bootId', () => {
  it('is a UUIDv4 string', () => {
    expect(bootId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('is stable across imports within the same process', async () => {
    const a = (await import('./boot-id.js')).bootId;
    const b = (await import('./boot-id.js')).bootId;
    expect(a).toBe(b);
    expect(a).toBe(bootId);
  });
});

describe('buildDaemonEnv', () => {
  it('produces a typed env with the listener-B sentinel pinned', () => {
    const env = buildDaemonEnv();
    expect(env.bootId).toBe(bootId);
    expect(env.listeners[1]).toBe(RESERVED_FOR_LISTENER_B);
    expect(['service', 'dev']).toContain(env.mode);
    expect(env.paths.descriptorPath.endsWith('listener-a.json')).toBe(true);
  });
});
