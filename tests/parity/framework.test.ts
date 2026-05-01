// T07 — parity-test framework unit tests.
//
// Spec: docs/superpowers/specs/2026-05-01-v0.4-web-design.md
//   - ch03 §7   (test discipline per swap PR — parity test required per RPC)
//   - ch03 §7.1 (parity-test framework shape: assertParity + ignoreFields + coerce)
//   - ch08 §3   (L2 daemon Connect handler unit + contract tests)
//   - ch08 §8   (reverse-verify discipline)
//
// What this file proves about the framework:
//   1. `runParityCase` runs envelopeCall + connectCall in parallel and asserts
//      the responses are equivalent under the supplied `equivalence` fn.
//   2. When responses diverge, the framework FAILS the test with a
//      side-by-side JSON diff (so a regressing bridge is loud, not silent).
//   3. `tolerantFields` strips ignore-listed keys from BOTH sides before compare,
//      so timestamp / trace-id drift doesn't cause false positives.
//   4. The default deep-equal equivalence catches structural divergence
//      (different keys, different values, different array order).
//
// Reverse-verify: replacing `equivalence` with `() => true` makes a divergent
// case PASS — proving the equivalence fn is the gating mechanism, not some
// happy-path coincidence. See `forces a divergent case to pass when equivalence
// is overridden to always-true` below.

import { describe, it, expect } from 'vitest';
import {
  assertParity,
  runParityCase,
  ParityDivergenceError,
  defaultEquivalence,
} from './framework.js';

describe('assertParity (low-level deep-equal + ignoreFields + coerce)', () => {
  it('passes when responses are deep-equal', () => {
    expect(() =>
      assertParity({ a: 1, b: 'two' }, { a: 1, b: 'two' }),
    ).not.toThrow();
  });

  it('throws ParityDivergenceError when responses differ', () => {
    expect(() => assertParity({ a: 1 }, { a: 2 })).toThrow(ParityDivergenceError);
  });

  it('error message contains a side-by-side diff (envelope + connect labels)', () => {
    let caught: unknown;
    try {
      assertParity({ a: 1, b: 'x' }, { a: 2, b: 'x' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParityDivergenceError);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/envelope/i);
    expect(msg).toMatch(/connect/i);
    // The differing field name should appear in the diff so the developer
    // can find the offending key without scrolling through the whole JSON.
    expect(msg).toContain('a');
  });

  it('ignoreFields strips listed keys from BOTH sides before compare', () => {
    expect(() =>
      assertParity(
        { a: 1, ts: 1700000000 },
        { a: 1, ts: 1800000000 },
        { ignoreFields: ['ts'] },
      ),
    ).not.toThrow();
  });

  it('ignoreFields supports nested dotted paths', () => {
    expect(() =>
      assertParity(
        { meta: { traceId: 'abc' }, data: { v: 1 } },
        { meta: { traceId: 'xyz' }, data: { v: 1 } },
        { ignoreFields: ['meta.traceId'] },
      ),
    ).not.toThrow();
  });

  it('coerce normalizes per-field before compare', () => {
    expect(() =>
      assertParity(
        { pid: '1234' },
        { pid: 1234 },
        { coerce: { pid: (v) => Number(v) } },
      ),
    ).not.toThrow();
  });

  it('still fails when coerce yields different values', () => {
    expect(() =>
      assertParity(
        { pid: '1234' },
        { pid: '5678' },
        { coerce: { pid: (v) => Number(v) } },
      ),
    ).toThrow(ParityDivergenceError);
  });
});

describe('defaultEquivalence', () => {
  it('returns true for deep-equal values', () => {
    expect(defaultEquivalence({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
  });

  it('returns false for divergent values', () => {
    expect(defaultEquivalence({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('honors ignoreFields when supplied through the optional second arg', () => {
    expect(
      defaultEquivalence(
        { a: 1, ts: 1 },
        { a: 1, ts: 2 },
        { ignoreFields: ['ts'] },
      ),
    ).toBe(true);
  });
});

describe('runParityCase', () => {
  it('passes when envelopeCall and connectCall return equivalent responses', async () => {
    await expect(
      runParityCase({
        name: 'happy path',
        envelopeCall: async () => ({ ok: true, value: 42 }),
        connectCall: async () => ({ ok: true, value: 42 }),
      }),
    ).resolves.toBeUndefined();
  });

  it('runs envelopeCall and connectCall in parallel (not serial)', async () => {
    // Both calls take 50ms; parallel total should be ~50ms, serial ~100ms.
    // We assert < 90ms to leave generous CI headroom but still catch a serial
    // implementation.
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const start = Date.now();
    await runParityCase({
      name: 'parallel timing',
      envelopeCall: async () => {
        await sleep(50);
        return { v: 1 };
      },
      connectCall: async () => {
        await sleep(50);
        return { v: 1 };
      },
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(90);
  });

  it('throws (fails the test) when responses diverge — synthetic {a:1} vs {a:2}', async () => {
    await expect(
      runParityCase({
        name: 'synthetic divergence',
        envelopeCall: async () => ({ a: 1 }),
        connectCall: async () => ({ a: 2 }),
      }),
    ).rejects.toThrow(ParityDivergenceError);
  });

  it('failure message includes the case name so multi-case reports are scannable', async () => {
    let caught: unknown;
    try {
      await runParityCase({
        name: 'my-rpc divergence',
        envelopeCall: async () => ({ x: 1 }),
        connectCall: async () => ({ x: 2 }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParityDivergenceError);
    expect((caught as Error).message).toContain('my-rpc divergence');
  });

  it('respects tolerantFields (drift in those fields does not fail the case)', async () => {
    await expect(
      runParityCase({
        name: 'tolerant ts',
        envelopeCall: async () => ({ ts: 1, v: 'same' }),
        connectCall: async () => ({ ts: 2, v: 'same' }),
        tolerantFields: ['ts'],
      }),
    ).resolves.toBeUndefined();
  });

  it('forces a divergent case to PASS when equivalence is overridden to always-true (reverse-verify)', async () => {
    // Reverse-verify per ch08 §8: prove equivalence fn is the gate by
    // overriding it. With the override, divergent responses no longer fail.
    // Without the override (see prior test), they DO fail.
    await expect(
      runParityCase({
        name: 'reverse verify',
        envelopeCall: async () => ({ a: 1 }),
        connectCall: async () => ({ a: 2 }),
        equivalence: () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it('propagates errors from envelopeCall (does not swallow as divergence)', async () => {
    await expect(
      runParityCase({
        name: 'envelope error',
        envelopeCall: async () => {
          throw new Error('envelope boom');
        },
        connectCall: async () => ({ a: 1 }),
      }),
    ).rejects.toThrow(/envelope boom/);
  });

  it('propagates errors from connectCall (does not swallow as divergence)', async () => {
    await expect(
      runParityCase({
        name: 'connect error',
        envelopeCall: async () => ({ a: 1 }),
        connectCall: async () => {
          throw new Error('connect boom');
        },
      }),
    ).rejects.toThrow(/connect boom/);
  });
});
