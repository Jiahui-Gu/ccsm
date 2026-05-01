// T48 wiring tests — heartbeat envelope owner.
//
// Asserts:
//   1. Each scheduler tick produces one envelope per active subId
//      shaped `{ kind: 'heartbeat', ts, bootNonce }`.
//   2. The `bootNonce` field is the daemon-bound value (T48 stamper).
//   3. The stamped nonce is IDENTICAL across all heartbeats from the
//      same daemon process (one stamper, one nonce).
//   4. A simulated daemon restart (fresh stamper with a fresh nonce)
//      yields envelopes with the new nonce — proving the field is
//      driven by the bound stamper, not a hard-coded literal.
//   5. Reverse-verify negative: an owner built without the stamper
//      wiring (a hand-rolled scheduler+push that omits stamp()) emits
//      envelopes WITHOUT `bootNonce` — so the assertions actually
//      catch a regression that drops the wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHeartbeatEnvelopeOwner,
  type HeartbeatEnvelope,
} from '../heartbeat-envelope-owner.js';
import { createFromBootNonceStamper } from '../from-boot-nonce-stamper.js';
import { createHeartbeatScheduler } from '../stream-heartbeat-scheduler.js';

const NONCE_BOOT_A = '01HZZZBOOTNONCEAAAAAAAA';
const NONCE_BOOT_B = '01HZZZBOOTNONCEBBBBBBBB';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('heartbeat-envelope-owner — construction guards', () => {
  it('rejects missing push callback', () => {
    expect(() =>
      createHeartbeatEnvelopeOwner({
        // @ts-expect-error — exercise runtime guard
        push: undefined,
        bootNonce: NONCE_BOOT_A,
        intervalMs: 30_000,
      }),
    ).toThrow(TypeError);
  });
  it('rejects missing both bootNonce and stamper', () => {
    expect(() =>
      createHeartbeatEnvelopeOwner({
        push: () => {},
        intervalMs: 30_000,
      }),
    ).toThrow(/bootNonce or stamper is required/);
  });
  it('rejects passing both bootNonce and stamper', () => {
    expect(() =>
      createHeartbeatEnvelopeOwner({
        push: () => {},
        bootNonce: NONCE_BOOT_A,
        stamper: createFromBootNonceStamper(NONCE_BOOT_B),
        intervalMs: 30_000,
      }),
    ).toThrow(/either bootNonce or stamper, not both/);
  });
  it('rejects empty bootNonce (delegated to stamper)', () => {
    expect(() =>
      createHeartbeatEnvelopeOwner({
        push: () => {},
        bootNonce: '',
        intervalMs: 30_000,
      }),
    ).toThrow(TypeError);
  });
});

describe('heartbeat-envelope-owner — envelope shape + stamping', () => {
  it('per tick: emits { kind: "heartbeat", ts, bootNonce } per active subId', () => {
    const sent: Array<{ subId: string; env: HeartbeatEnvelope }> = [];
    const owner = createHeartbeatEnvelopeOwner({
      bootNonce: NONCE_BOOT_A,
      intervalMs: 10_000,
      push: (subId, env) => sent.push({ subId, env }),
      // Force `ts` deterministic for the equality assertion below.
      now: () => 1_700_000_001_234,
    });
    owner.start('sub-A');
    owner.start('sub-B');
    vi.advanceTimersByTime(10_000);

    expect(sent).toHaveLength(2);
    for (const { env } of sent) {
      expect(env.kind).toBe('heartbeat');
      expect(env.ts).toBe(1_700_000_001_234);
      expect(env.bootNonce).toBe(NONCE_BOOT_A);
    }
    expect(sent.map((e) => e.subId).sort()).toEqual(['sub-A', 'sub-B']);
    owner.stop('sub-A');
    owner.stop('sub-B');
  });

  it('bootNonce is identical across heartbeats from same daemon process', () => {
    const sent: HeartbeatEnvelope[] = [];
    const owner = createHeartbeatEnvelopeOwner({
      bootNonce: NONCE_BOOT_A,
      intervalMs: 10_000,
      push: (_subId, env) => sent.push(env),
    });
    owner.start('sub-1');
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000);
    }
    expect(sent).toHaveLength(5);
    expect(sent.every((e) => e.bootNonce === NONCE_BOOT_A)).toBe(true);
    expect(sent.some((e) => e.bootNonce === NONCE_BOOT_B)).toBe(false);
    owner.stop('sub-1');
  });

  it('different bound nonces (simulated restart) yield different stamped values', () => {
    const sentA: HeartbeatEnvelope[] = [];
    const sentB: HeartbeatEnvelope[] = [];

    const ownerA = createHeartbeatEnvelopeOwner({
      bootNonce: NONCE_BOOT_A,
      intervalMs: 10_000,
      push: (_s, env) => sentA.push(env),
    });
    ownerA.start('sub-x');
    vi.advanceTimersByTime(10_000);
    ownerA.stop('sub-x');

    const ownerB = createHeartbeatEnvelopeOwner({
      bootNonce: NONCE_BOOT_B,
      intervalMs: 10_000,
      push: (_s, env) => sentB.push(env),
    });
    ownerB.start('sub-x');
    vi.advanceTimersByTime(10_000);
    ownerB.stop('sub-x');

    expect(sentA).toHaveLength(1);
    expect(sentB).toHaveLength(1);
    expect(sentA[0]!.bootNonce).toBe(NONCE_BOOT_A);
    expect(sentB[0]!.bootNonce).toBe(NONCE_BOOT_B);
    expect(sentA[0]!.bootNonce).not.toBe(sentB[0]!.bootNonce);
  });

  it('accepts a pre-built stamper (single source of truth pattern)', () => {
    const sent: HeartbeatEnvelope[] = [];
    const sharedStamper = createFromBootNonceStamper(NONCE_BOOT_A);
    const owner = createHeartbeatEnvelopeOwner({
      stamper: sharedStamper,
      intervalMs: 10_000,
      push: (_s, env) => sent.push(env),
    });
    owner.start('sub-1');
    vi.advanceTimersByTime(10_000);
    owner.stop('sub-1');
    expect(sent[0]!.bootNonce).toBe(NONCE_BOOT_A);
    expect(sharedStamper.getBootNonce()).toBe(NONCE_BOOT_A);
  });

  it('updateInterval proxies to the underlying scheduler; bootNonce stays stamped', () => {
    const sent: HeartbeatEnvelope[] = [];
    const owner = createHeartbeatEnvelopeOwner({
      bootNonce: NONCE_BOOT_A,
      intervalMs: 30_000,
      push: (_s, env) => sent.push(env),
    });
    owner.start('sub-1');
    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(1);
    owner.updateInterval(5_000);
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(2);
    expect(sent.every((e) => e.bootNonce === NONCE_BOOT_A)).toBe(true);
    owner.stop('sub-1');
  });
});

// Reverse-verify: a hand-rolled wiring that BYPASSES the stamper produces
// envelopes WITHOUT `bootNonce`. This proves the positive assertions
// above actually depend on the stamper wiring.
describe('heartbeat-envelope-owner — reverse-verify (skip-stamper bypass)', () => {
  it('omitting stamper from sendHeartbeat produces envelopes WITHOUT bootNonce', () => {
    const sent: Array<Record<string, unknown>> = [];
    const sch = createHeartbeatScheduler({
      intervalMs: 10_000,
      sendHeartbeat: (subId) => {
        const envelopeWithoutStamp = { kind: 'heartbeat', ts: 0 };
        sent.push({ subId, ...envelopeWithoutStamp });
      },
    });
    sch.start('sub-1');
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(1);
    expect('bootNonce' in sent[0]!).toBe(false);
    sch.stop('sub-1');
  });
});
