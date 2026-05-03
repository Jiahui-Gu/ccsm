// packages/daemon/test/crash/rate-limit.spec.ts
//
// `sqlite_op` rate-limit (spec ch09 §1: "one entry per ~60s per code-class
// to prevent flooding"). Kept separate from capture.spec.ts because it
// drives a stepped clock — bundling with the per-source matrix would
// muddle two concerns.

import { describe, it, expect, vi } from 'vitest';

import {
  CAPTURE_SOURCES,
  SQLITE_RATE_LIMIT_MS,
  SqliteRateLimiter,
  type CrashSink,
  type SqliteErrorBus,
  type SqliteErrorInfo,
  installCaptureSources,
} from '../../src/crash/sources.js';

function makeFakeSqliteBus(): {
  bus: SqliteErrorBus;
  fire: (info: SqliteErrorInfo) => void;
} {
  const cbs: Array<(info: SqliteErrorInfo) => void> = [];
  return {
    bus: {
      onError(cb) {
        cbs.push(cb);
        return () => {
          const i = cbs.indexOf(cb);
          if (i >= 0) cbs.splice(i, 1);
        };
      },
    },
    fire: (info) => {
      for (const cb of cbs.slice()) cb(info);
    },
  };
}

describe('SqliteRateLimiter', () => {
  it('allows the first emit per code-class', () => {
    const lim = new SqliteRateLimiter();
    expect(lim.shouldEmit('SQLITE_BUSY', 0)).toBe(true);
    expect(lim.shouldEmit('SQLITE_IOERR', 0)).toBe(true);
  });

  it('drops a same-class emit within the window', () => {
    const lim = new SqliteRateLimiter();
    expect(lim.shouldEmit('SQLITE_BUSY', 0)).toBe(true);
    expect(lim.shouldEmit('SQLITE_BUSY', SQLITE_RATE_LIMIT_MS - 1)).toBe(false);
  });

  it('allows a same-class emit after the window expires', () => {
    const lim = new SqliteRateLimiter();
    expect(lim.shouldEmit('SQLITE_BUSY', 0)).toBe(true);
    expect(lim.shouldEmit('SQLITE_BUSY', SQLITE_RATE_LIMIT_MS)).toBe(true);
  });

  it('windows are independent per code-class', () => {
    const lim = new SqliteRateLimiter();
    expect(lim.shouldEmit('SQLITE_BUSY', 0)).toBe(true);
    expect(lim.shouldEmit('SQLITE_IOERR', 1)).toBe(true);
    expect(lim.shouldEmit('SQLITE_BUSY', 1)).toBe(false);
    expect(lim.shouldEmit('SQLITE_IOERR', 2)).toBe(false);
  });

  it('reset() clears all classes', () => {
    const lim = new SqliteRateLimiter();
    lim.shouldEmit('SQLITE_BUSY', 0);
    lim.reset();
    expect(lim.shouldEmit('SQLITE_BUSY', 1)).toBe(true);
  });

  it('honours a custom window', () => {
    const lim = new SqliteRateLimiter(1000);
    expect(lim.shouldEmit('x', 0)).toBe(true);
    expect(lim.shouldEmit('x', 999)).toBe(false);
    expect(lim.shouldEmit('x', 1000)).toBe(true);
  });
});

describe('sqlite_op source rate-limiting (end-to-end via installCaptureSources)', () => {
  it('emits the first error per code-class then drops repeats within 60s', () => {
    const sink: CrashSink = vi.fn();
    const { bus, fire } = makeFakeSqliteBus();
    let now = 1_000_000;
    const off = installCaptureSources({
      sources: CAPTURE_SOURCES.filter((s) => s.source === 'sqlite_op'),
      sink,
      now: () => now,
      hooks: { sqliteErrors: bus },
    });

    // First BUSY error — emitted.
    fire({ codeClass: 'SQLITE_BUSY', redactedSql: '?', message: 'busy 1' });
    expect(sink).toHaveBeenCalledTimes(1);

    // Same class, +30s — dropped.
    now += 30_000;
    fire({ codeClass: 'SQLITE_BUSY', redactedSql: '?', message: 'busy 2' });
    expect(sink).toHaveBeenCalledTimes(1);

    // Different class, same instant — emitted (independent window).
    fire({ codeClass: 'SQLITE_IOERR', redactedSql: '?', message: 'ioerr 1' });
    expect(sink).toHaveBeenCalledTimes(2);

    // Same BUSY class, +60s from FIRST emit — emitted again.
    now = 1_000_000 + SQLITE_RATE_LIMIT_MS;
    fire({ codeClass: 'SQLITE_BUSY', redactedSql: '?', message: 'busy 3' });
    expect(sink).toHaveBeenCalledTimes(3);

    off();
  });

  it('rate-limit state is per-install (no cross-install bleed)', () => {
    const sink1: CrashSink = vi.fn();
    const sink2: CrashSink = vi.fn();
    const { bus: bus1, fire: fire1 } = makeFakeSqliteBus();
    const { bus: bus2, fire: fire2 } = makeFakeSqliteBus();
    const now = (): number => 5_000;

    const off1 = installCaptureSources({
      sources: CAPTURE_SOURCES.filter((s) => s.source === 'sqlite_op'),
      sink: sink1,
      now,
      hooks: { sqliteErrors: bus1 },
    });
    const off2 = installCaptureSources({
      sources: CAPTURE_SOURCES.filter((s) => s.source === 'sqlite_op'),
      sink: sink2,
      now,
      hooks: { sqliteErrors: bus2 },
    });

    fire1({ codeClass: 'SQLITE_BUSY', redactedSql: '?', message: 'a' });
    fire2({ codeClass: 'SQLITE_BUSY', redactedSql: '?', message: 'b' });

    // Each install has its own limiter — both should emit.
    expect(sink1).toHaveBeenCalledTimes(1);
    expect(sink2).toHaveBeenCalledTimes(1);

    off1();
    off2();
  });
});
