// packages/daemon/src/pty-host/__tests__/exit-decider.spec.ts
//
// Unit tests for `decideSessionEnd` (Task #436 coverage sweep).
// Pure decider — spec ch06 §1 truth table:
//   graceful + code 0 + signal null → graceful, exit_code 0
//   anything else                   → crashed, exit_code = exit.code

import { describe, expect, it } from 'vitest';

import { decideSessionEnd } from '../exit-decider.js';
import type { ChildExit } from '../types.js';

const exit = (e: Partial<ChildExit>): ChildExit => ({
  reason: 'crashed',
  code: null,
  signal: null,
  ...e,
});

describe('decideSessionEnd', () => {
  it('graceful + code 0 + null signal → graceful, 0', () => {
    expect(
      decideSessionEnd(exit({ reason: 'graceful', code: 0, signal: null })),
    ).toEqual({ reason: 'graceful', exit_code: 0 });
  });

  it('crashed + non-zero code + null signal → crashed, code', () => {
    expect(
      decideSessionEnd(exit({ reason: 'crashed', code: 137, signal: null })),
    ).toEqual({ reason: 'crashed', exit_code: 137 });
  });

  it('crashed + null code + signal → crashed, null', () => {
    expect(
      decideSessionEnd(exit({ reason: 'crashed', code: null, signal: 'SIGKILL' })),
    ).toEqual({ reason: 'crashed', exit_code: null });
  });

  it('crashed + code 0 + null signal → crashed, 0 (no graceful notice)', () => {
    expect(
      decideSessionEnd(exit({ reason: 'crashed', code: 0, signal: null })),
    ).toEqual({ reason: 'crashed', exit_code: 0 });
  });

  it('graceful + non-zero code → defensive crashed (host should clamp this)', () => {
    expect(
      decideSessionEnd(exit({ reason: 'graceful', code: 1, signal: null })),
    ).toEqual({ reason: 'crashed', exit_code: 1 });
  });

  it('graceful + code 0 + signal SIGTERM → defensive crashed (signal disqualifies)', () => {
    expect(
      decideSessionEnd(exit({ reason: 'graceful', code: 0, signal: 'SIGTERM' })),
    ).toEqual({ reason: 'crashed', exit_code: 0 });
  });
});
