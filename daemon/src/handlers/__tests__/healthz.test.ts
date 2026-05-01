import { describe, expect, it } from 'vitest';

import { DAEMON_PROTOCOL_VERSION } from '../../envelope/protocol-version.js';
import {
  HEALTHZ_DAEMON_ACCEPTED_WIRES,
  HEALTHZ_FEATURES,
  HEALTHZ_MIN_CLIENT,
  HEALTHZ_VERSION,
  HEALTHZ_WIRE,
  handleHealthz,
  makeHealthzHandler,
  type HealthzContext,
} from '../healthz.js';

/** Fake-clock helper — the handler reads `ctx.now()` exactly once per call,
 *  so an array-pop counter is enough to verify monotonicity below. */
function makeCtx(overrides: Partial<HealthzContext> = {}): HealthzContext {
  return {
    bootNonce: '01HK9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z',
    pid: 12345,
    version: '0.3.0-test',
    bootedAtMs: 1_000_000,
    now: () => 1_000_000,
    ...overrides,
  };
}

describe('handleHealthz: response shape (frag-6-7 §6.5)', () => {
  it('returns every field documented in the spec body', () => {
    const reply = handleHealthz({}, makeCtx({ now: () => 1_000_500 }));

    // Required scalar fields per §6.5 lines 124-140.
    expect(reply).toMatchObject({
      uptimeMs: 500,
      pid: 12345,
      version: '0.3.0-test',
      bootNonce: '01HK9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z',
      sessionCount: 0,
      subscriberCount: 0,
      migrationState: 'absent',
      swapInProgress: false,
      healthzVersion: HEALTHZ_VERSION,
    });

    // The protocol block is mirrored 1:1 from `daemon.hello` reply
    // (§6.5 "canonical version-negotiation payload, mirrored 1:1").
    expect(reply.protocol).toEqual({
      wire: HEALTHZ_WIRE,
      minClient: HEALTHZ_MIN_CLIENT,
      daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
      daemonAcceptedWires: HEALTHZ_DAEMON_ACCEPTED_WIRES,
      features: HEALTHZ_FEATURES,
    });
  });

  it('omits no documented spec keys (defensive against typo regressions)', () => {
    const reply = handleHealthz({}, makeCtx());
    const keys = Object.keys(reply).sort();
    expect(keys).toEqual(
      [
        'bootNonce',
        'healthzVersion',
        'migrationState',
        'pid',
        'protocol',
        'sessionCount',
        'subscriberCount',
        'swapInProgress',
        'uptimeMs',
        'version',
      ].sort(),
    );
  });

  it('healthzVersion is the spec literal 1 (frag-6-7 §6.5 r3 P1-3)', () => {
    expect(HEALTHZ_VERSION).toBe(1);
    expect(handleHealthz({}, makeCtx()).healthzVersion).toBe(1);
  });

  it('daemonProtocolVersion is the spec literal 1 (frag-3.4.1 §3.4.1.g r9 lock)', () => {
    expect(DAEMON_PROTOCOL_VERSION).toBe(1);
    expect(handleHealthz({}, makeCtx()).protocol.daemonProtocolVersion).toBe(1);
  });

  it("v0.3 daemonAcceptedWires is exactly ['v0.3-json-envelope'] (r3 P1-5)", () => {
    expect(HEALTHZ_DAEMON_ACCEPTED_WIRES).toEqual(['v0.3-json-envelope']);
  });

  it('features array contains the six v0.3-locked capability strings', () => {
    expect(HEALTHZ_FEATURES).toEqual([
      'binary-frames',
      'stream-heartbeat',
      'interceptors',
      'traceId',
      'bootNonce',
      'hello',
    ]);
  });
});

describe('handleHealthz: uptime monotonicity', () => {
  it('uptime increases with the injected clock', () => {
    let now = 1_000_000;
    const ctx = makeCtx({ bootedAtMs: 1_000_000, now: () => now });

    const a = handleHealthz({}, ctx).uptimeMs;
    now = 1_000_250;
    const b = handleHealthz({}, ctx).uptimeMs;
    now = 1_005_000;
    const c = handleHealthz({}, ctx).uptimeMs;

    expect(a).toBe(0);
    expect(b).toBe(250);
    expect(c).toBe(5_000);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('clamps uptime to >=0 on clock rewind (NTP step / hibernate resume)', () => {
    // Spec: /healthz must NEVER error (§6.5 "always returns liveness"),
    // so a backwards clock collapses to 0 instead of throwing or going
    // negative — the supervisor reads liveness, not absolute time.
    const ctx = makeCtx({ bootedAtMs: 5_000, now: () => 1_000 });
    expect(handleHealthz({}, ctx).uptimeMs).toBe(0);
  });
});

describe('handleHealthz: injected providers', () => {
  it('forwards live counter snapshots from the providers', () => {
    let sessions = 7;
    let subs = 13;
    const ctx = makeCtx({
      getSessionCount: () => sessions,
      getSubscriberCount: () => subs,
    });

    const r1 = handleHealthz({}, ctx);
    expect(r1.sessionCount).toBe(7);
    expect(r1.subscriberCount).toBe(13);

    sessions = 0;
    subs = 0;
    const r2 = handleHealthz({}, ctx);
    expect(r2.sessionCount).toBe(0);
    expect(r2.subscriberCount).toBe(0);
  });

  it('migrationState reflects the injected provider', () => {
    for (const state of ['absent', 'pending', 'in-progress', 'done'] as const) {
      const reply = handleHealthz({}, makeCtx({ getMigrationState: () => state }));
      expect(reply.migrationState).toBe(state);
    }
  });

  it('swapInProgress reflects the injected provider (frag-6-7 §6.4 step 4-7)', () => {
    expect(handleHealthz({}, makeCtx({ getSwapInProgress: () => true })).swapInProgress).toBe(true);
    expect(handleHealthz({}, makeCtx({ getSwapInProgress: () => false })).swapInProgress).toBe(false);
  });

  it('defaults: missing providers yield 0 / "absent" / false', () => {
    const reply = handleHealthz({}, makeCtx());
    expect(reply.sessionCount).toBe(0);
    expect(reply.subscriberCount).toBe(0);
    expect(reply.migrationState).toBe('absent');
    expect(reply.swapInProgress).toBe(false);
  });
});

describe('handleHealthz: purity (no I/O, ignores req)', () => {
  it('produces identical replies for identical clocks regardless of req', () => {
    const ctx = makeCtx({ now: () => 1_000_100 });
    const a = handleHealthz({}, ctx);
    const b = handleHealthz({ junk: 'ignored' }, ctx);
    const c = handleHealthz(undefined, ctx);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('does not mutate the injected context', () => {
    const ctx = makeCtx();
    const snapshot = JSON.stringify(ctx);
    handleHealthz({}, ctx);
    expect(JSON.stringify(ctx)).toBe(snapshot);
  });
});

describe('makeHealthzHandler: T16 dispatcher adapter', () => {
  it('returns an async handler that resolves to the same shape', async () => {
    let now = 2_000_000;
    const ctx = makeCtx({ bootedAtMs: 2_000_000, now: () => now });
    const handler = makeHealthzHandler(ctx);

    const r1 = await handler({});
    expect(r1.uptimeMs).toBe(0);

    now = 2_005_000;
    const r2 = await handler({});
    expect(r2.uptimeMs).toBe(5_000);
    expect(r2.healthzVersion).toBe(1);
  });

  it('handler signature is compatible with the Dispatcher.Handler contract', async () => {
    // Compile-time + runtime check: the returned function is `(req) => Promise`.
    const handler = makeHealthzHandler(makeCtx());
    const result = handler('any-req-payload');
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeDefined();
  });
});
