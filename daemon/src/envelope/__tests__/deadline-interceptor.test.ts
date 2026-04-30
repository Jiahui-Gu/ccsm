import { describe, expect, it } from 'vitest';

import {
  applyDeadline,
  DEADLINE_HEADER,
  DEFAULT_DEADLINE_MS,
  MAX_DEADLINE_MS,
  MIN_DEADLINE_MS,
  type DeadlineInterceptorContext,
} from '../deadline-interceptor.js';

const ctx = (
  headers: Record<string, string | number>,
  rpcName = 'ccsm.v1/test.method',
): DeadlineInterceptorContext => ({ headers, rpcName });

describe('applyDeadline — accept path', () => {
  it('accepts the lower bound 100 ms', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: 100 }));
    expect(out).toEqual({ deadlineMs: 100 });
  });

  it('accepts a typical 30 s deadline', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: 30_000 }));
    expect(out).toEqual({ deadlineMs: 30_000 });
  });

  it('accepts the upper bound 120 s', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: 120_000 }));
    expect(out).toEqual({ deadlineMs: 120_000 });
  });

  it('parses a numeric string header (canonical wire form)', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: '5000' }));
    expect(out).toEqual({ deadlineMs: 5_000 });
  });

  it('tolerates surrounding whitespace on a string header', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: '  5000  ' }));
    expect(out).toEqual({ deadlineMs: 5_000 });
  });
});

describe('applyDeadline — default path', () => {
  it('returns DEFAULT_DEADLINE_MS when the header is missing', () => {
    const out = applyDeadline(ctx({}));
    expect(out).toEqual({ deadlineMs: DEFAULT_DEADLINE_MS });
    expect(DEFAULT_DEADLINE_MS).toBe(5_000);
  });

  it('returns DEFAULT_DEADLINE_MS when the header is an empty string', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: '' }));
    expect(out).toEqual({ deadlineMs: DEFAULT_DEADLINE_MS });
  });

  it('returns DEFAULT_DEADLINE_MS for a whitespace-only string', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: '   ' }));
    expect(out).toEqual({ deadlineMs: DEFAULT_DEADLINE_MS });
  });
});

describe('applyDeadline — reject path (out of range)', () => {
  it('rejects 99 ms with deadline_too_small', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: 99 }));
    expect(out).toEqual({
      error: {
        code: 'deadline_too_small',
        message: expect.stringContaining(`below minimum ${MIN_DEADLINE_MS}`),
      },
    });
  });

  it('rejects 0 ms with deadline_too_small', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: 0 }));
    expect(out).toMatchObject({ error: { code: 'deadline_too_small' } });
  });

  it('rejects negative deadline with deadline_too_small', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: -1 }));
    expect(out).toMatchObject({ error: { code: 'deadline_too_small' } });
  });

  it('rejects 120001 ms with deadline_too_large', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: 120_001 }));
    expect(out).toEqual({
      error: {
        code: 'deadline_too_large',
        message: expect.stringContaining(`above maximum ${MAX_DEADLINE_MS}`),
      },
    });
  });

  it('rejects a 10-minute deadline with deadline_too_large', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: 600_000 }));
    expect(out).toMatchObject({ error: { code: 'deadline_too_large' } });
  });
});

describe('applyDeadline — reject path (malformed)', () => {
  it('rejects a non-numeric string with deadline_invalid', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: 'abc' }));
    expect(out).toMatchObject({ error: { code: 'deadline_invalid' } });
  });

  it('rejects a fractional string with deadline_invalid', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: '5000.5' }));
    expect(out).toMatchObject({ error: { code: 'deadline_invalid' } });
  });

  it('rejects scientific notation strings with deadline_invalid', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: '5e3' }));
    expect(out).toMatchObject({ error: { code: 'deadline_invalid' } });
  });

  it('rejects a fractional numeric value with deadline_invalid', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: 5_000.5 }));
    expect(out).toMatchObject({ error: { code: 'deadline_invalid' } });
  });

  it('rejects NaN with deadline_invalid', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: Number.NaN }));
    expect(out).toMatchObject({ error: { code: 'deadline_invalid' } });
  });

  it('rejects Infinity with deadline_invalid', () => {
    const out = applyDeadline(ctx({ [DEADLINE_HEADER]: Number.POSITIVE_INFINITY }));
    expect(out).toMatchObject({ error: { code: 'deadline_invalid' } });
  });
});

describe('applyDeadline — purity', () => {
  it('does not mutate the input headers', () => {
    const headers = { [DEADLINE_HEADER]: '5000' };
    const snapshot = { ...headers };
    applyDeadline(ctx(headers));
    expect(headers).toEqual(snapshot);
  });

  it('ignores unrelated headers (single responsibility)', () => {
    // The unknown_xccsm_header warn is the caller's concern; this decider
    // must not branch on or reject for unknown keys.
    const out = applyDeadline(
      ctx({
        [DEADLINE_HEADER]: 1_000,
        'x-ccsm-future-thing': 'whatever',
        'x-trace-id': '01ABCXYZ',
      }),
    );
    expect(out).toEqual({ deadlineMs: 1_000 });
  });
});
