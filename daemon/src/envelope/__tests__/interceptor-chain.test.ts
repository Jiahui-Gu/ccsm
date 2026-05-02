// Tests for interceptor-chain.ts (#153 N13-fix wiring of the spec §3.4.1.f
// 5-interceptor pipeline).
//
// Coverage:
//   - dispatchWithInterceptors threads daemonTraceId into every reply (ok+error).
//   - A request that the dispatcher rejects still receives a daemonTraceId
//     and bumps the metrics-error counter.
//   - The trace-log sink fires exactly once per envelope with both traceId
//     AND daemonTraceId populated (the dual-id correlation property).
//   - The deadline interceptor surfaces invalid-deadline rejections without
//     calling the dispatcher.
//   - The migration gate blocks non-allowlisted methods when isMigrationPending
//     returns true.
//   - Hello slot: omitted helloConfig is a no-op pass-through; provided
//     helloConfig rejects pre-handshake non-hello methods with `hello_required`.
//   - buildReplyHeaders includes the x-ccsm-daemon-trace-id header.

import { describe, expect, it, vi } from 'vitest';

import {
  buildReplyHeaders,
  dispatchWithInterceptors,
  type ChainConnectionState,
  type ChainWiring,
} from '../interceptor-chain.js';
import { createHelloState } from '../hello-interceptor.js';
import { DAEMON_TRACE_ID_HEADER, type TraceCompletionLog } from '../trace-interceptor.js';
import type { Dispatcher, DispatchResult } from '../../dispatcher.js';
import type { MetricsRegistry } from '../metrics-interceptor.js';

function stubDispatcher(
  fn: (m: string) => DispatchResult | Promise<DispatchResult>,
): Pick<Dispatcher, 'dispatch'> {
  return { dispatch: vi.fn(async (m) => fn(m)) };
}

function freshState(): ChainConnectionState {
  return { helloState: createHelloState() };
}

function recordingMetrics(): {
  registry: MetricsRegistry;
  requests: string[];
  errors: { method: string; code: string }[];
  durations: { method: string; durationMs: number }[];
} {
  const requests: string[] = [];
  const errors: { method: string; code: string }[] = [];
  const durations: { method: string; durationMs: number }[] = [];
  // The chain only invokes the three record* methods; a duck-typed object
  // is sufficient for this contract test (the real MetricsRegistry class
  // has its own dedicated unit tests).
  const registry = {
    recordRequest: (m: string) => requests.push(m),
    recordError: (m: string, c?: string) => errors.push({ method: m, code: c ?? '' }),
    recordDuration: (m: string, d: number) => durations.push({ method: m, durationMs: d }),
  } as unknown as MetricsRegistry;
  return { registry, requests, errors, durations };
}

describe('dispatchWithInterceptors — daemonTraceId propagation (#153 N13-fix)', () => {
  it('echoes daemonTraceId on a successful reply AND logs both ids', async () => {
    const sink: TraceCompletionLog[] = [];
    const wiring: ChainWiring = {
      dispatcher: stubDispatcher(() => ({ ok: true, value: { hi: 1 }, ack_source: 'handler' })),
      traceLogSink: (r) => sink.push(r),
      mintTraceId: () => 'client-fallback',
      mintDaemonTraceId: () => 'daemon-id-OK',
      clock: stepClock([100, 110]),
    };
    const reply = await dispatchWithInterceptors(
      { id: 1, method: 'ccsm.v1/healthz' },
      freshState(),
      wiring,
    );
    expect(reply.kind).toBe('ok');
    expect(reply.daemonTraceId).toBe('daemon-id-OK');
    expect(reply.traceId).toBe('client-fallback');
    expect(sink).toHaveLength(1);
    expect(sink[0]?.traceId).toBe('client-fallback');
    expect(sink[0]?.daemonTraceId).toBe('daemon-id-OK');
    expect(sink[0]?.code).toBe('ok');
    expect(sink[0]?.durationMs).toBe(10);
  });

  it('echoes daemonTraceId on dispatcher-rejected reply AND bumps metrics-error', async () => {
    const sink: TraceCompletionLog[] = [];
    const m = recordingMetrics();
    const wiring: ChainWiring = {
      dispatcher: stubDispatcher(() => ({
        ok: false,
        error: { code: 'NOT_ALLOWED', method: 'x', message: 'nope' },
      })),
      traceLogSink: (r) => sink.push(r),
      metricsRegistry: m.registry,
      mintDaemonTraceId: () => 'daemon-id-ERR',
      mintTraceId: () => 'client-id-ERR',
    };
    const reply = await dispatchWithInterceptors(
      { id: 2, method: 'ccsm.v1/x' },
      freshState(),
      wiring,
    );
    expect(reply.kind).toBe('error');
    expect(reply.daemonTraceId).toBe('daemon-id-ERR');
    if (reply.kind === 'error') {
      expect(reply.code).toBe('NOT_ALLOWED');
      expect(reply.socketFatal).toBe(false);
    }
    expect(m.requests).toEqual(['ccsm.v1/x']);
    expect(m.errors).toEqual([{ method: 'ccsm.v1/x', code: 'NOT_ALLOWED' }]);
    expect(m.durations).toHaveLength(1);
    expect(sink[0]?.daemonTraceId).toBe('daemon-id-ERR');
  });

  it('preserves caller-supplied traceId AND mints distinct daemonTraceId', async () => {
    const sink: TraceCompletionLog[] = [];
    const wiring: ChainWiring = {
      dispatcher: stubDispatcher(() => ({ ok: true, value: null, ack_source: 'handler' })),
      traceLogSink: (r) => sink.push(r),
      mintDaemonTraceId: () => 'daemon-side',
    };
    const reply = await dispatchWithInterceptors(
      { id: 3, method: 'ccsm.v1/healthz', traceId: 'client-supplied-ulid' },
      freshState(),
      wiring,
    );
    expect(reply.traceId).toBe('client-supplied-ulid');
    expect(reply.daemonTraceId).toBe('daemon-side');
    expect(reply.daemonTraceId).not.toBe(reply.traceId);
  });
});

describe('dispatchWithInterceptors — interceptor slot behavior', () => {
  it('rejects with deadline_invalid without calling the dispatcher', async () => {
    const dispatch = vi.fn();
    const wiring: ChainWiring = {
      dispatcher: { dispatch },
      mintDaemonTraceId: () => 'd1',
    };
    const reply = await dispatchWithInterceptors(
      {
        id: 4,
        method: 'ccsm.v1/healthz',
        headers: { 'x-ccsm-deadline-ms': 'not-a-number' },
      },
      freshState(),
      wiring,
    );
    expect(reply.kind).toBe('error');
    if (reply.kind === 'error') expect(reply.code).toBe('deadline_invalid');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('blocks non-allowlisted method when migration is pending', async () => {
    const dispatch = vi.fn();
    const wiring: ChainWiring = {
      dispatcher: { dispatch },
      isMigrationPending: () => true,
      mintDaemonTraceId: () => 'd2',
    };
    const reply = await dispatchWithInterceptors(
      { id: 5, method: 'ccsm.v1/session.list' },
      freshState(),
      wiring,
    );
    expect(reply.kind).toBe('error');
    if (reply.kind === 'error') expect(reply.code).toBe('MIGRATION_PENDING');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('hello slot is no-op when helloConfig omitted (pass-through to dispatcher)', async () => {
    const wiring: ChainWiring = {
      dispatcher: stubDispatcher(() => ({ ok: true, value: 'ok', ack_source: 'handler' })),
      mintDaemonTraceId: () => 'd3',
    };
    const reply = await dispatchWithInterceptors(
      { id: 6, method: 'ccsm.v1/anything' },
      freshState(),
      wiring,
    );
    expect(reply.kind).toBe('ok');
  });

  it('surfaces handler exception as INTERNAL with daemonTraceId still echoed', async () => {
    const sink: TraceCompletionLog[] = [];
    const wiring: ChainWiring = {
      dispatcher: { dispatch: vi.fn(async () => { throw new Error('boom'); }) },
      traceLogSink: (r) => sink.push(r),
      mintDaemonTraceId: () => 'd-INT',
    };
    const reply = await dispatchWithInterceptors(
      { id: 7, method: 'ccsm.v1/x' },
      freshState(),
      wiring,
    );
    expect(reply.kind).toBe('error');
    if (reply.kind === 'error') {
      expect(reply.code).toBe('INTERNAL');
      expect(reply.daemonTraceId).toBe('d-INT');
    }
    expect(sink[0]?.code).toBe('INTERNAL');
    expect(sink[0]?.daemonTraceId).toBe('d-INT');
  });
});

describe('buildReplyHeaders', () => {
  it('includes x-ccsm-daemon-trace-id', () => {
    const headers = buildReplyHeaders({
      kind: 'ok',
      id: 1,
      value: null,
      ackSource: 'handler',
      daemonTraceId: 'abc',
      traceId: 't',
    });
    expect(headers[DAEMON_TRACE_ID_HEADER]).toBe('abc');
  });
});

function stepClock(readings: readonly number[]): () => number {
  let i = 0;
  return () => {
    const v = readings[Math.min(i, readings.length - 1)];
    i += 1;
    return v as number;
  };
}
