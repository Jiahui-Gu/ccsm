// Unit tests for degraded-state decider — spec ch06 §4 (3-strike + 60 s
// cooldown gate). Pure-decider semantics → no fake timers, no I/O, just
// table-driven assertions over `decideDegraded` outputs.
//
// Task #385 — paired with packages/daemon/src/pty-host/degraded-state.ts.

import { describe, expect, it } from 'vitest';

import {
  DEGRADED_COOLDOWN_MS,
  DEGRADED_STRIKE_THRESHOLD,
  decideDegraded,
} from './degraded-state.js';

describe('decideDegraded', () => {
  const T0 = 1_700_000_000_000; // arbitrary fixed wall-clock for table tests

  it('reports RUNNING + gate open when no failures have occurred', () => {
    expect(
      decideDegraded({
        consecutiveFailures: 0,
        lastFailureAtMs: null,
        nowMs: T0,
      }),
    ).toEqual({ state: 'RUNNING', gateOpen: true });
  });

  it('reports RUNNING + gate open below the 3-strike threshold', () => {
    for (const failures of [1, 2]) {
      expect(
        decideDegraded({
          consecutiveFailures: failures,
          lastFailureAtMs: T0,
          nowMs: T0 + 1_000,
        }),
      ).toEqual({ state: 'RUNNING', gateOpen: true });
    }
  });

  it('flips to DEGRADED + gate closed at exactly the 3rd strike (cooldown active)', () => {
    expect(
      decideDegraded({
        consecutiveFailures: DEGRADED_STRIKE_THRESHOLD,
        lastFailureAtMs: T0,
        nowMs: T0, // 0 ms into cooldown
      }),
    ).toEqual({ state: 'DEGRADED', gateOpen: false });
  });

  it('keeps gate closed throughout the cooldown window', () => {
    // Sample several points strictly inside [0, COOLDOWN_MS).
    for (const dtMs of [0, 1, 1_000, 30_000, 59_000, DEGRADED_COOLDOWN_MS - 1]) {
      const decision = decideDegraded({
        consecutiveFailures: DEGRADED_STRIKE_THRESHOLD,
        lastFailureAtMs: T0,
        nowMs: T0 + dtMs,
      });
      expect(decision, `dtMs=${dtMs}`).toEqual({
        state: 'DEGRADED',
        gateOpen: false,
      });
    }
  });

  it('reopens the gate (RUNNING) at exactly the 60 s boundary', () => {
    expect(
      decideDegraded({
        consecutiveFailures: DEGRADED_STRIKE_THRESHOLD,
        lastFailureAtMs: T0,
        nowMs: T0 + DEGRADED_COOLDOWN_MS,
      }),
    ).toEqual({ state: 'RUNNING', gateOpen: true });
  });

  it('keeps the gate open after the cooldown elapses (retry permitted)', () => {
    for (const dtMs of [
      DEGRADED_COOLDOWN_MS,
      DEGRADED_COOLDOWN_MS + 1,
      DEGRADED_COOLDOWN_MS + 60_000,
    ]) {
      expect(
        decideDegraded({
          consecutiveFailures: DEGRADED_STRIKE_THRESHOLD,
          lastFailureAtMs: T0,
          nowMs: T0 + dtMs,
        }),
        `dtMs=${dtMs}`,
      ).toEqual({ state: 'RUNNING', gateOpen: true });
    }
  });

  it('treats higher strike counts (4, 5, ...) the same as the 3rd strike', () => {
    // The decider does not differentiate; the cooldown semantics carry
    // through. This guards against a future refactor accidentally adding
    // a `=== THRESHOLD` check instead of the `>= THRESHOLD` already there.
    for (const failures of [3, 4, 5, 100]) {
      expect(
        decideDegraded({
          consecutiveFailures: failures,
          lastFailureAtMs: T0,
          nowMs: T0 + 1_000,
        }),
      ).toEqual({ state: 'DEGRADED', gateOpen: false });
    }
  });

  it('falls back to RUNNING when caller passes failures>=THRESHOLD with null lastFailureAtMs (defensive)', () => {
    // Programmer error path — documented in jsdoc table comment 2. We
    // assert the safe fallback rather than silently honoring a null as
    // "infinite cooldown".
    expect(
      decideDegraded({
        consecutiveFailures: DEGRADED_STRIKE_THRESHOLD,
        lastFailureAtMs: null,
        nowMs: T0,
      }),
    ).toEqual({ state: 'RUNNING', gateOpen: true });
  });
});
