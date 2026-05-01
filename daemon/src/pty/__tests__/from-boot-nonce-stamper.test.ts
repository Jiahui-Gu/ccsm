import { describe, expect, it, vi } from 'vitest';

import {
  createFromBootNonceStamper,
  type BootChangedFrame,
} from '../from-boot-nonce-stamper.js';

// Two distinct ULIDs (Crockford 26-char form) used throughout the suite.
// Same shape as `daemon/src/index.ts:16` mints via `ulid()`.
const NONCE_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NONCE_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

describe('createFromBootNonceStamper — construction', () => {
  it('rejects empty string nonce (defensive — early-init wiring foot-gun)', () => {
    expect(() => createFromBootNonceStamper('')).toThrow(TypeError);
  });

  it('rejects non-string nonce (defensive — undefined cast at wiring)', () => {
    expect(() =>
      createFromBootNonceStamper(undefined as unknown as string),
    ).toThrow(TypeError);
  });

  it('accepts a non-empty ULID-shaped nonce', () => {
    expect(() => createFromBootNonceStamper(NONCE_A)).not.toThrow();
  });
});

describe('FromBootNonceStamper.getBootNonce', () => {
  it('returns the bound nonce verbatim', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    expect(stamper.getBootNonce()).toBe(NONCE_A);
  });

  it('is stable across calls within one stamper (per-boot lifetime)', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    expect(stamper.getBootNonce()).toBe(NONCE_A);
    expect(stamper.getBootNonce()).toBe(NONCE_A);
    expect(stamper.getBootNonce()).toBe(NONCE_A);
  });

  it('a fresh stamper for a fresh boot returns a fresh nonce', () => {
    // Mocks the source-of-truth pattern: supervisor reboot → fresh
    // ulid() → fresh stamper. Renderer reconnect bridge (T69) detects
    // the change via heartbeat-frame nonce mismatch.
    const mintNonce = vi
      .fn<() => string>()
      .mockReturnValueOnce(NONCE_A)
      .mockReturnValueOnce(NONCE_B);
    const firstBoot = createFromBootNonceStamper(mintNonce());
    const secondBoot = createFromBootNonceStamper(mintNonce());
    expect(firstBoot.getBootNonce()).toBe(NONCE_A);
    expect(secondBoot.getBootNonce()).toBe(NONCE_B);
    expect(firstBoot.getBootNonce()).not.toBe(secondBoot.getBootNonce());
    expect(mintNonce).toHaveBeenCalledTimes(2);
  });
});

describe('FromBootNonceStamper.stamp', () => {
  it('attaches bootNonce to a heartbeat-shaped envelope (spec §3.5.1.4 line 101)', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    const heartbeat = stamper.stamp({
      kind: 'heartbeat' as const,
      ts: 1_700_000_000_000,
      traceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    expect(heartbeat).toEqual({
      kind: 'heartbeat',
      ts: 1_700_000_000_000,
      traceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      bootNonce: NONCE_A,
    });
  });

  it('attaches bootNonce to a chunk-shaped envelope (fan-out emission)', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    const chunk = stamper.stamp({
      kind: 'chunk' as const,
      seq: 42,
      payload: 'hello',
    });
    expect(chunk.bootNonce).toBe(NONCE_A);
    expect(chunk.kind).toBe('chunk');
    expect(chunk.seq).toBe(42);
  });

  it('attaches bootNonce to a snapshot envelope', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    const snapshot = stamper.stamp({
      kind: 'snapshot' as const,
      sessionId: 'sess-1',
      seq: 0,
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(snapshot.bootNonce).toBe(NONCE_A);
    expect(snapshot.sessionId).toBe('sess-1');
  });

  it('does NOT mutate the input envelope (returns a fresh object)', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    const input: { kind: 'heartbeat'; ts: number } = {
      kind: 'heartbeat',
      ts: 1,
    };
    const stamped = stamper.stamp(input);
    expect(stamped).not.toBe(input);
    expect(input).toEqual({ kind: 'heartbeat', ts: 1 });
    expect('bootNonce' in input).toBe(false);
  });

  it('daemon-bound nonce wins over a forwarded input bootNonce (anti-spoof)', () => {
    // Mirrors `boot-nonce-precedence.ts` posture: a producer that
    // accidentally forwards a client-provided envelope must not be
    // able to spoof the boot identity on outbound emissions.
    const stamper = createFromBootNonceStamper(NONCE_A);
    const stamped = stamper.stamp({
      kind: 'heartbeat' as const,
      bootNonce: NONCE_B, // attacker-supplied / stale value
      ts: 0,
    });
    expect(stamped.bootNonce).toBe(NONCE_A);
  });

  it('stamps the same nonce across many emissions for one boot (lifetime stability)', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    for (let seq = 0; seq < 100; seq++) {
      const frame = stamper.stamp({ kind: 'chunk' as const, seq });
      expect(frame.bootNonce).toBe(NONCE_A);
    }
  });
});

describe('FromBootNonceStamper.compareFromBootNonce', () => {
  it("returns 'match' when client nonce equals bound nonce", () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    expect(stamper.compareFromBootNonce(NONCE_A)).toBe('match');
  });

  it("returns 'mismatch' when client nonce differs (daemon respawn detected)", () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    expect(stamper.compareFromBootNonce(NONCE_B)).toBe('mismatch');
  });

  it("returns 'absent' when client omits the field (first-time subscribe)", () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    expect(stamper.compareFromBootNonce(undefined)).toBe('absent');
  });

  it("returns 'absent' on empty string (defensive serializer parity)", () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    expect(stamper.compareFromBootNonce('')).toBe('absent');
  });

  it('uses strict equality (case-sensitive ULID comparison)', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    // Crockford ULID is UPPERCASE; lowercase variant must mismatch.
    expect(stamper.compareFromBootNonce(NONCE_A.toLowerCase())).toBe(
      'mismatch',
    );
  });
});

describe('FromBootNonceStamper.buildBootChangedFrame', () => {
  it('emits the spec-shaped bootChanged envelope (§3.5.1.4 line 103)', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    const frame: BootChangedFrame = stamper.buildBootChangedFrame();
    expect(frame).toEqual({
      kind: 'bootChanged',
      bootNonce: NONCE_A,
      snapshotPending: true,
    });
  });

  it('always carries the daemon CURRENT nonce (so client updates in one frame)', () => {
    const stamper = createFromBootNonceStamper(NONCE_B);
    const frame = stamper.buildBootChangedFrame();
    expect(frame.bootNonce).toBe(NONCE_B);
    expect(frame.snapshotPending).toBe(true);
  });

  it('returns a fresh object each call (no shared reference leak)', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    const a = stamper.buildBootChangedFrame();
    const b = stamper.buildBootChangedFrame();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('FromBootNonceStamper — end-to-end resubscribe flow', () => {
  it('match path: client supplies prior nonce → no bootChanged emitted', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    // Wiring layer pseudo-code that consumers will follow:
    const decision = stamper.compareFromBootNonce(NONCE_A);
    expect(decision).toBe('match');
    // On 'match', the wiring layer honours fromSeq and does NOT emit
    // bootChanged. The stamper has no side effects on its own.
  });

  it('mismatch path: client carries stale nonce → bootChanged + fresh snapshot', () => {
    // Simulates daemon respawn: client last saw NONCE_B, daemon now
    // mints NONCE_A. Renderer reconnect bridge (T69) consumes the
    // bootChanged frame and renders the divider.
    const stamper = createFromBootNonceStamper(NONCE_A);
    const decision = stamper.compareFromBootNonce(NONCE_B);
    expect(decision).toBe('mismatch');
    const bootChanged = stamper.buildBootChangedFrame();
    expect(bootChanged.bootNonce).toBe(NONCE_A);
    expect(bootChanged.snapshotPending).toBe(true);
    // Wiring layer follows with a fresh snapshot from seq 0; stamps
    // the daemon-current nonce on it.
    const snapshot = stamper.stamp({
      kind: 'snapshot' as const,
      sessionId: 'sess-1',
      seq: 0,
      bytes: new Uint8Array(),
    });
    expect(snapshot.bootNonce).toBe(NONCE_A);
  });

  it('absent path: first-time subscribe → treated as match, no bootChanged', () => {
    const stamper = createFromBootNonceStamper(NONCE_A);
    expect(stamper.compareFromBootNonce(undefined)).toBe('absent');
    // Heartbeats / chunks still carry the daemon nonce so the client
    // can record it for the NEXT resubscribe.
    const heartbeat = stamper.stamp({ kind: 'heartbeat' as const, ts: 0 });
    expect(heartbeat.bootNonce).toBe(NONCE_A);
  });
});
