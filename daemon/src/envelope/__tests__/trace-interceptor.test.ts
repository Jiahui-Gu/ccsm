// Tests for trace-interceptor.ts (frag-3.4.1 §3.4.1.f "trace" slot).
//
// Coverage:
//   - resolveTraceId: caller-supplied wins; empty / whitespace falls through
//     to the minter; minted id uses 32-char hex (16-byte) format.
//   - startTrace + formatCompletionLog: deterministic durationMs computation
//     under an injected clock; Math.max guard against non-monotonic clock.
//   - runWithTrace: round-trip propagates traceId into the handler context;
//     completion log lands once on success and once on throw with code
//     'INTERNAL'; thrown error rethrown unchanged.

import { describe, it, expect } from 'vitest';

import {
  defaultMintTraceId,
  formatCompletionLog,
  resolveTraceId,
  runWithTrace,
  startTrace,
  TRACE_ID_BYTES,
  TRACE_LOG_EVENT,
  type TraceCompletionLog,
} from '../trace-interceptor.js';

describe('resolveTraceId', () => {
  it('returns the caller-supplied traceId when present', () => {
    const out = resolveTraceId({ traceId: '01HZZZCALLERTRACEID0001' }, () => 'minted');
    expect(out).toBe('01HZZZCALLERTRACEID0001');
  });

  it('mints a fresh id when the envelope omits traceId', () => {
    const out = resolveTraceId({}, () => 'minted-stub');
    expect(out).toBe('minted-stub');
  });

  it('mints when the supplied traceId is the empty string', () => {
    const out = resolveTraceId({ traceId: '' }, () => 'minted-stub');
    expect(out).toBe('minted-stub');
  });

  it('mints when the supplied traceId is whitespace-only', () => {
    const out = resolveTraceId({ traceId: '   ' }, () => 'minted-stub');
    expect(out).toBe('minted-stub');
  });

  it('mints when traceId is null (defensive — JSON.parse can produce null)', () => {
    const out = resolveTraceId({ traceId: null }, () => 'minted-stub');
    expect(out).toBe('minted-stub');
  });

  it('default minter produces 32-char hex (16 bytes)', () => {
    const id = defaultMintTraceId();
    expect(id).toMatch(/^[0-9a-f]+$/);
    expect(id).toHaveLength(TRACE_ID_BYTES * 2);
  });

  it('default minter is non-deterministic (entropy check)', () => {
    const a = defaultMintTraceId();
    const b = defaultMintTraceId();
    expect(a).not.toBe(b);
  });
});

describe('startTrace + formatCompletionLog', () => {
  it('records start time from the injected clock', () => {
    const span = startTrace('ccsm.v1/healthz', 'trace-a', () => 1000);
    expect(span).toEqual({ method: 'ccsm.v1/healthz', traceId: 'trace-a', startedMs: 1000 });
  });

  it('computes durationMs from start to completion clock reading', () => {
    const span = startTrace('ccsm.v1/healthz', 'trace-a', () => 1000);
    const log = formatCompletionLog(span, 'ok', () => 1042);
    expect(log).toEqual<TraceCompletionLog>({
      event: TRACE_LOG_EVENT,
      method: 'ccsm.v1/healthz',
      traceId: 'trace-a',
      durationMs: 42,
      code: 'ok',
    });
  });

  it('clamps negative duration to 0 (non-monotonic clock guard)', () => {
    const span = startTrace('ccsm.v1/healthz', 'trace-a', () => 5000);
    const log = formatCompletionLog(span, 'ok', () => 4000);
    expect(log.durationMs).toBe(0);
  });

  it('passes through arbitrary error code strings', () => {
    const span = startTrace('ccsm.v1/x', 'trace-z', () => 0);
    const log = formatCompletionLog(span, 'MIGRATION_PENDING', () => 7);
    expect(log.code).toBe('MIGRATION_PENDING');
  });
});

describe('runWithTrace — round-trip', () => {
  it('propagates the resolved traceId into the handler context', async () => {
    const sink: TraceCompletionLog[] = [];
    let seenTraceId = '';
    const out = await runWithTrace<string>({
      envelope: { traceId: 'caller-trace-1' },
      method: 'ccsm.v1/daemon.hello',
      handler: async (ctx) => {
        seenTraceId = ctx.traceId;
        return { value: 'hello-reply' };
      },
      sink: (r) => sink.push(r),
      clock: stepClock([100, 105]),
    });
    expect(out).toBe('hello-reply');
    expect(seenTraceId).toBe('caller-trace-1');
    expect(sink).toEqual([
      {
        event: TRACE_LOG_EVENT,
        method: 'ccsm.v1/daemon.hello',
        traceId: 'caller-trace-1',
        durationMs: 5,
        code: 'ok',
      },
    ]);
  });

  it('mints a traceId when the envelope omits one and propagates the same id to the log', async () => {
    const sink: TraceCompletionLog[] = [];
    let seenTraceId = '';
    await runWithTrace<number>({
      envelope: {},
      method: 'ccsm.v1/healthz',
      handler: async (ctx) => {
        seenTraceId = ctx.traceId;
        return { value: 1 };
      },
      sink: (r) => sink.push(r),
      mintTraceId: () => 'minted-xyz',
      clock: stepClock([10, 20]),
    });
    expect(seenTraceId).toBe('minted-xyz');
    expect(sink).toHaveLength(1);
    expect(sink[0]?.traceId).toBe('minted-xyz');
  });

  it('records completion log THEN rethrows on handler failure with code=INTERNAL', async () => {
    const sink: TraceCompletionLog[] = [];
    const boom = new Error('handler exploded');
    await expect(
      runWithTrace<never>({
        envelope: { traceId: 'caller-trace-2' },
        method: 'ccsm.v1/daemon.shutdown',
        handler: async () => {
          throw boom;
        },
        sink: (r) => sink.push(r),
        clock: stepClock([200, 250]),
      }),
    ).rejects.toBe(boom);
    expect(sink).toEqual([
      {
        event: TRACE_LOG_EVENT,
        method: 'ccsm.v1/daemon.shutdown',
        traceId: 'caller-trace-2',
        durationMs: 50,
        code: 'INTERNAL',
      },
    ]);
  });

  it('honours a handler-supplied non-ok code without throwing', async () => {
    const sink: TraceCompletionLog[] = [];
    await runWithTrace<null>({
      envelope: { traceId: 't' },
      method: 'ccsm.v1/daemon.hello',
      handler: async () => ({ value: null, code: 'NOT_IMPLEMENTED' }),
      sink: (r) => sink.push(r),
      clock: stepClock([0, 1]),
    });
    expect(sink[0]?.code).toBe('NOT_IMPLEMENTED');
  });
});

/**
 * Build a deterministic clock stub that yields successive readings on each
 * call. The trace pipeline reads the clock at most twice per RPC (start +
 * completion); tests pass a 2-element array and assert the resulting span.
 */
function stepClock(readings: readonly number[]): () => number {
  let i = 0;
  return () => {
    const v = readings[Math.min(i, readings.length - 1)];
    i += 1;
    return v as number;
  };
}
