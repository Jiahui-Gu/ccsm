import { describe, expect, it } from 'vitest';

import {
  defaultMemoryUsageProvider,
  handleStats,
  makeStatsHandler,
  STATS_VERSION,
  type MemorySnapshot,
  type StatsContext,
} from '../stats.js';

/** Pinned-memory helper — tests inject deterministic counter values so
 *  the snapshot is byte-for-byte predictable. */
function makeCtx(overrides: Partial<StatsContext> = {}): StatsContext {
  return {
    getMemoryUsage: () => ({ rss: 100_000, heapUsed: 50_000 }),
    ...overrides,
  };
}

describe('handleStats: response shape (frag-6-7 §6.5 line 150)', () => {
  it('returns every field documented in the spec body', () => {
    const reply = handleStats({}, makeCtx());

    expect(reply).toEqual({
      statsVersion: STATS_VERSION,
      rss: 100_000,
      heapUsed: 50_000,
      ptyBufferBytes: 0,
      openSockets: 0,
    });
  });

  it('omits no documented spec keys (defensive against typo regressions)', () => {
    const reply = handleStats({}, makeCtx());
    const keys = Object.keys(reply).sort();
    expect(keys).toEqual(
      [
        'heapUsed',
        'openSockets',
        'ptyBufferBytes',
        'rss',
        'statsVersion',
      ].sort(),
    );
  });

  it('statsVersion is the spec literal 1 (frag-6-7 §6.5 r2 obs P1-4 + r3 P1-3)', () => {
    expect(STATS_VERSION).toBe(1);
    expect(handleStats({}, makeCtx()).statsVersion).toBe(1);
  });

  it('statsVersion lives ONLY on /stats (r3 P1-3 split — not on /healthz)', () => {
    // This is a structural assertion: the /stats reply MUST carry
    // statsVersion, and a sister assertion in healthz.test.ts verifies
    // /healthz does NOT carry it (it carries healthzVersion instead).
    const reply = handleStats({}, makeCtx());
    expect(reply).toHaveProperty('statsVersion');
    expect(reply).not.toHaveProperty('healthzVersion');
  });
});

describe('handleStats: injected providers (counter zero-state defaults)', () => {
  it('forwards live memory snapshots from the provider', () => {
    let rss = 1_000_000;
    let heapUsed = 500_000;
    const ctx = makeCtx({ getMemoryUsage: () => ({ rss, heapUsed }) });

    const r1 = handleStats({}, ctx);
    expect(r1.rss).toBe(1_000_000);
    expect(r1.heapUsed).toBe(500_000);

    rss = 2_000_000;
    heapUsed = 800_000;
    const r2 = handleStats({}, ctx);
    expect(r2.rss).toBe(2_000_000);
    expect(r2.heapUsed).toBe(800_000);
  });

  it('forwards live ptyBufferBytes from the provider', () => {
    let bytes = 16_384;
    const ctx = makeCtx({ getPtyBufferBytes: () => bytes });

    expect(handleStats({}, ctx).ptyBufferBytes).toBe(16_384);
    bytes = 0;
    expect(handleStats({}, ctx).ptyBufferBytes).toBe(0);
    bytes = 262_144;
    expect(handleStats({}, ctx).ptyBufferBytes).toBe(262_144);
  });

  it('forwards live openSockets from the provider', () => {
    let sockets = 3;
    const ctx = makeCtx({ getOpenSockets: () => sockets });

    expect(handleStats({}, ctx).openSockets).toBe(3);
    sockets = 0;
    expect(handleStats({}, ctx).openSockets).toBe(0);
    sockets = 42;
    expect(handleStats({}, ctx).openSockets).toBe(42);
  });

  it('defaults: missing optional providers yield 0', () => {
    const reply = handleStats({}, makeCtx());
    expect(reply.ptyBufferBytes).toBe(0);
    expect(reply.openSockets).toBe(0);
  });

  it('all providers wired together produces the combined snapshot', () => {
    const ctx: StatsContext = {
      getMemoryUsage: () => ({ rss: 12_345_678, heapUsed: 9_876_543 }),
      getPtyBufferBytes: () => 65_536,
      getOpenSockets: () => 7,
    };
    expect(handleStats({}, ctx)).toEqual({
      statsVersion: 1,
      rss: 12_345_678,
      heapUsed: 9_876_543,
      ptyBufferBytes: 65_536,
      openSockets: 7,
    });
  });
});

describe('handleStats: purity (no I/O, ignores req)', () => {
  it('produces identical replies for identical providers regardless of req', () => {
    const ctx = makeCtx();
    const a = handleStats({}, ctx);
    const b = handleStats({ junk: 'ignored' }, ctx);
    const c = handleStats(undefined, ctx);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('does not mutate the injected context', () => {
    const ctx: StatsContext = {
      getMemoryUsage: () => ({ rss: 1, heapUsed: 2 }),
      getPtyBufferBytes: () => 3,
      getOpenSockets: () => 4,
    };
    const before = {
      hasMem: typeof ctx.getMemoryUsage,
      hasPty: typeof ctx.getPtyBufferBytes,
      hasSock: typeof ctx.getOpenSockets,
    };
    handleStats({}, ctx);
    expect({
      hasMem: typeof ctx.getMemoryUsage,
      hasPty: typeof ctx.getPtyBufferBytes,
      hasSock: typeof ctx.getOpenSockets,
    }).toEqual(before);
  });
});

describe('makeStatsHandler: T16 dispatcher adapter', () => {
  it('returns an async handler that resolves to the same shape', async () => {
    let rss = 200_000;
    const ctx: StatsContext = {
      getMemoryUsage: () => ({ rss, heapUsed: 100_000 }),
      getPtyBufferBytes: () => 1024,
      getOpenSockets: () => 2,
    };
    const handler = makeStatsHandler(ctx);

    const r1 = await handler({});
    expect(r1).toEqual({
      statsVersion: 1,
      rss: 200_000,
      heapUsed: 100_000,
      ptyBufferBytes: 1024,
      openSockets: 2,
    });

    rss = 300_000;
    const r2 = await handler({});
    expect(r2.rss).toBe(300_000);
    expect(r2.statsVersion).toBe(1);
  });

  it('handler signature is compatible with the Dispatcher.Handler contract', async () => {
    // Compile-time + runtime check: the returned function is `(req) => Promise`.
    const handler = makeStatsHandler(makeCtx());
    const result = handler('any-req-payload');
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeDefined();
  });

  it('the wrapped handler produces a structurally-stable reply across calls', async () => {
    const handler = makeStatsHandler(makeCtx());
    const a = await handler({});
    const b = await handler({});
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });
});

describe('defaultMemoryUsageProvider: production wiring helper', () => {
  it('returns a function that surfaces real process.memoryUsage() values', () => {
    const provider = defaultMemoryUsageProvider();
    const snap: MemorySnapshot = provider();

    // We cannot pin exact values, but rss and heapUsed must be positive
    // integers when read from a live Node process.
    expect(typeof snap.rss).toBe('number');
    expect(typeof snap.heapUsed).toBe('number');
    expect(snap.rss).toBeGreaterThan(0);
    expect(snap.heapUsed).toBeGreaterThan(0);
    expect(Number.isInteger(snap.rss)).toBe(true);
    expect(Number.isInteger(snap.heapUsed)).toBe(true);
  });

  it('produces a snapshot whose shape exactly matches MemorySnapshot', () => {
    const snap = defaultMemoryUsageProvider()();
    expect(Object.keys(snap).sort()).toEqual(['heapUsed', 'rss']);
  });
});
