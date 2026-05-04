// Unit tests for `decideSessionEnd` (T4.4 / Task #42).
//
// Pure-function decider — no fixtures, no IO, no fork. Pins the
// truth-table from `exit-decider.ts` jsdoc against the spec ch06 §1
// crash-vs-graceful classification.

import { describe, expect, it } from 'vitest';

import { decideSessionEnd } from '../../src/pty-host/exit-decider.js';
import type { ChildExit } from '../../src/pty-host/types.js';

function exit(partial: Partial<ChildExit>): ChildExit {
  return {
    reason: partial.reason ?? 'crashed',
    code: partial.code ?? null,
    signal: partial.signal ?? null,
  };
}

describe('decideSessionEnd', () => {
  it('graceful + code 0 + no signal → graceful, exit_code 0', () => {
    expect(decideSessionEnd(exit({ reason: 'graceful', code: 0 }))).toEqual({
      reason: 'graceful',
      exit_code: 0,
    });
  });

  it('crashed + non-zero code → crashed with that code', () => {
    expect(decideSessionEnd(exit({ reason: 'crashed', code: 137 }))).toEqual({
      reason: 'crashed',
      exit_code: 137,
    });
  });

  it('crashed + signal (no code) → crashed with null exit_code', () => {
    expect(
      decideSessionEnd(exit({ reason: 'crashed', code: null, signal: 'SIGKILL' })),
    ).toEqual({ reason: 'crashed', exit_code: null });
  });

  it('crashed + code 0 (no graceful notice) is still a crash — defends against silent exit-without-exiting-message', () => {
    // Spec ch06 §1: graceful requires the `kind:'exiting'` notice AND
    // code 0. A child that exits 0 without sending the notice is a
    // crash by definition.
    expect(decideSessionEnd(exit({ reason: 'crashed', code: 0 }))).toEqual({
      reason: 'crashed',
      exit_code: 0,
    });
  });

  it('graceful + non-zero code is reclassified as crashed (defense in depth)', () => {
    // Unreachable today — the host clamps `graceful` to require code 0
    // — but pinned here so a future host relaxation cannot silently
    // mark a non-zero-exit child as graceful.
    expect(decideSessionEnd(exit({ reason: 'graceful', code: 2 }))).toEqual({
      reason: 'crashed',
      exit_code: 2,
    });
  });

  it('graceful + signal is reclassified as crashed (defense in depth)', () => {
    expect(
      decideSessionEnd(exit({ reason: 'graceful', code: 0, signal: 'SIGKILL' })),
    ).toEqual({ reason: 'crashed', exit_code: 0 });
  });
});
