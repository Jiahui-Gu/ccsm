// packages/daemon/test/lock/runStartup-lock.spec.ts
//
// Wave-2 Task #221 — unit tests for `assertWired` boot-time check.
//
// Pure UT (no I/O / no daemon spawn) — `assertWired` is a decider
// function. The integration-level proof "runStartup actually pushes
// every name" lives in `test/integration/daemon-boot-end-to-end.spec.ts`
// (Task #208 / #225).

import { describe, expect, it } from 'vitest';

import {
  REQUIRED_COMPONENTS,
  assertWired,
} from '../../src/runStartup.lock.js';

// `write-coalescer` is currently WARN_ONLY (see runStartup.lock.ts).
// The hard-required set is the canonical list MINUS that one. When the
// pty-host bridge lands and `write-coalescer` is removed from
// WARN_ONLY, this constant + the table below auto-stay correct without
// edits — but the WARN_ONLY case below DOES need to be deleted then.
const WARN_ONLY = new Set(['write-coalescer']);
const HARD_REQUIRED = REQUIRED_COMPONENTS.filter((n) => !WARN_ONLY.has(n));

describe('assertWired (Task #221)', () => {
  it('does not throw when every REQUIRED_COMPONENTS name is present', () => {
    expect(() => assertWired([...REQUIRED_COMPONENTS])).not.toThrow();
  });

  it('does not throw when only hard-required names are present (WARN_ONLY components soft-fail)', () => {
    const warnLines: string[] = [];
    expect(() =>
      assertWired(HARD_REQUIRED, { warn: (s) => warnLines.push(s) }),
    ).not.toThrow();
    // The current WARN_ONLY entry (write-coalescer) should be flagged.
    expect(warnLines.length).toBe(1);
    expect(warnLines[0]).toContain('write-coalescer');
  });

  it('throws listing all 5 components when present is empty', () => {
    let raised: Error | null = null;
    try {
      assertWired([]);
    } catch (err) {
      raised = err as Error;
    }
    expect(raised).not.toBeNull();
    expect(raised!.message).toContain('missing wired components:');
    // Empty -> every hard-required name in the message; WARN_ONLY ones
    // (write-coalescer) only emit a warning so they are NOT in the
    // throw message.
    for (const n of HARD_REQUIRED) {
      expect(raised!.message).toContain(n);
    }
    for (const n of WARN_ONLY) {
      expect(raised!.message).not.toContain(n);
    }
  });

  // Table-driven: drop each hard-required name in turn and confirm
  // (a) it throws, (b) the missing name is listed, (c) other present
  // names are NOT listed (no false positives).
  for (const dropped of HARD_REQUIRED) {
    it(`throws when '${dropped}' is missing`, () => {
      const present = HARD_REQUIRED.filter((n) => n !== dropped);
      let raised: Error | null = null;
      try {
        assertWired(present);
      } catch (err) {
        raised = err as Error;
      }
      expect(raised, `expected throw when ${dropped} missing`).not.toBeNull();
      expect(raised!.message).toBe(`missing wired components: ${dropped}`);
    });
  }

  it('warn callback is optional (no throw, no warn invocation needed)', () => {
    // Even with WARN_ONLY components missing, calling without a `warn`
    // callback must not throw.
    expect(() => assertWired(HARD_REQUIRED)).not.toThrow();
  });

  it('REQUIRED_COMPONENTS exposes the canonical 5-component list in stable order', () => {
    expect(REQUIRED_COMPONENTS).toEqual([
      'listener-a',
      'supervisor',
      'capture-sources',
      'crash-replayer',
      'write-coalescer',
    ]);
  });
});
