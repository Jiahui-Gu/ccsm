// T26 — Tests for marker-aware crash-loop skip decider.
// Spec: docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md
//   §6.1 R2 + §6.4 marker semantics.

import { describe, expect, it } from 'vitest';

import {
  shouldSkipCrashLoop,
  type CrashLoopSkipInput,
} from '../crash-loop-skip.js';
import type { MarkerReadResult } from '../../marker/reader.js';

const presentValid: MarkerReadResult = {
  kind: 'present',
  payload: { reason: 'upgrade', version: '0.3.0', ts: 1_700_000_000_000 },
};

const presentEmpty: MarkerReadResult = { kind: 'present', reason: 'empty' };
const presentInvalidJson: MarkerReadResult = { kind: 'present', reason: 'invalid-json' };
const presentMissingFields: MarkerReadResult = { kind: 'present', reason: 'missing-fields' };
const presentIoError: MarkerReadResult = { kind: 'present', reason: 'io-error' };
const absent: MarkerReadResult = { kind: 'absent' };

function input(
  marker: MarkerReadResult,
  consumed: boolean,
  restartCount: number,
): CrashLoopSkipInput {
  return { marker, consumed, restartCount };
}

describe('shouldSkipCrashLoop — marker-aware crash-loop skip', () => {
  it('marker PRESENT (valid payload) + restartCount=5 + not consumed -> skip=true', () => {
    expect(shouldSkipCrashLoop(input(presentValid, false, 5))).toBe(true);
  });

  it('marker ABSENT + restartCount=5 -> skip=false (normal accounting)', () => {
    expect(shouldSkipCrashLoop(input(absent, false, 5))).toBe(false);
  });

  it('marker ABSENT + restartCount=0 -> skip=false (cold boot, no marker)', () => {
    expect(shouldSkipCrashLoop(input(absent, false, 0))).toBe(false);
  });

  it('marker PRESENT + already-consumed flag set -> skip=false (resumed)', () => {
    expect(shouldSkipCrashLoop(input(presentValid, true, 5))).toBe(false);
  });

  describe('corruption-treat-as-PRESENT (T22 reader contract)', () => {
    it('empty marker -> skip=true (treated as PRESENT)', () => {
      expect(shouldSkipCrashLoop(input(presentEmpty, false, 5))).toBe(true);
    });

    it('invalid-JSON marker -> skip=true (treated as PRESENT)', () => {
      expect(shouldSkipCrashLoop(input(presentInvalidJson, false, 5))).toBe(true);
    });

    it('missing-fields marker -> skip=true (treated as PRESENT)', () => {
      expect(shouldSkipCrashLoop(input(presentMissingFields, false, 5))).toBe(true);
    });

    it('io-error marker -> skip=true (treated as PRESENT)', () => {
      expect(shouldSkipCrashLoop(input(presentIoError, false, 5))).toBe(true);
    });

    it('corrupted marker but already consumed -> skip=false (one-shot)', () => {
      expect(shouldSkipCrashLoop(input(presentInvalidJson, true, 5))).toBe(false);
    });
  });

  describe('purity', () => {
    it('does not mutate the input', () => {
      const inp = input(presentValid, false, 3);
      const snapshot = JSON.stringify(inp);
      shouldSkipCrashLoop(inp);
      expect(JSON.stringify(inp)).toBe(snapshot);
    });

    it('is deterministic across repeated calls', () => {
      const inp = input(presentValid, false, 5);
      const a = shouldSkipCrashLoop(inp);
      const b = shouldSkipCrashLoop(inp);
      const c = shouldSkipCrashLoop(inp);
      expect([a, b, c]).toEqual([true, true, true]);
    });
  });
});
