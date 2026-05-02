// Tests for metrics-interceptor.ts (frag-3.4.1 §3.4.1.f "metrics" slot).
//
// Coverage:
//   - 10 calls round-trip → requests counter == 10, errors == 1 when one of
//     them recorded an error (task-brief assertion).
//   - per-method isolation; per-code error breakdown.
//   - histogram bucketing: samples land in the smallest bucket whose `le`
//     bound covers them; oversized samples land in `+Inf`.
//   - snapshot deep-frozen so handlers cannot mutate the live registry.
//   - Prometheus formatter emits a counter+histogram block per method and
//     escapes label values.

import { describe, it, expect } from 'vitest';

import {
  HISTOGRAM_BUCKETS_MS,
  MetricsRegistry,
} from '../metrics-interceptor.js';

describe('MetricsRegistry — request / error counters', () => {
  it('counts 10 requests and 1 error end-to-end', () => {
    const reg = new MetricsRegistry();
    for (let i = 0; i < 10; i += 1) {
      reg.recordRequest('ccsm.v1/healthz');
    }
    reg.recordError('ccsm.v1/healthz', 'INTERNAL');
    const snap = reg.snapshot();
    expect(snap['ccsm.v1/healthz']?.requests).toBe(10);
    expect(snap['ccsm.v1/healthz']?.errors).toBe(1);
    expect(snap['ccsm.v1/healthz']?.errorsByCode).toEqual({ INTERNAL: 1 });
  });

  it('keeps per-method counters isolated', () => {
    const reg = new MetricsRegistry();
    reg.recordRequest('ccsm.v1/healthz');
    reg.recordRequest('ccsm.v1/daemon.hello');
    reg.recordRequest('ccsm.v1/daemon.hello');
    reg.recordError('ccsm.v1/daemon.hello', 'hello_replay');
    const snap = reg.snapshot();
    expect(snap['ccsm.v1/healthz']?.requests).toBe(1);
    expect(snap['ccsm.v1/healthz']?.errors).toBe(0);
    expect(snap['ccsm.v1/daemon.hello']?.requests).toBe(2);
    expect(snap['ccsm.v1/daemon.hello']?.errors).toBe(1);
    expect(snap['ccsm.v1/daemon.hello']?.errorsByCode).toEqual({ hello_replay: 1 });
  });

  it('breaks errors down by code when supplied', () => {
    const reg = new MetricsRegistry();
    reg.recordError('m', 'INTERNAL');
    reg.recordError('m', 'INTERNAL');
    reg.recordError('m', 'MIGRATION_PENDING');
    reg.recordError('m'); // unkeyed — total bumps but no code sub-counter
    const snap = reg.snapshot();
    expect(snap['m']?.errors).toBe(4);
    expect(snap['m']?.errorsByCode).toEqual({ INTERNAL: 2, MIGRATION_PENDING: 1 });
  });
});

describe('MetricsRegistry — duration histogram', () => {
  it('places samples in the smallest covering bucket', () => {
    const reg = new MetricsRegistry();
    reg.recordDuration('m', 0); // <= 1
    reg.recordDuration('m', 3); // <= 5
    reg.recordDuration('m', 50); // <= 50
    reg.recordDuration('m', 99); // <= 100
    const snap = reg.snapshot();
    const buckets = snap['m']?.durationBuckets ?? [];
    // HISTOGRAM_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 120000]
    const idxLe1 = HISTOGRAM_BUCKETS_MS.indexOf(1);
    const idxLe5 = HISTOGRAM_BUCKETS_MS.indexOf(5);
    const idxLe50 = HISTOGRAM_BUCKETS_MS.indexOf(50);
    const idxLe100 = HISTOGRAM_BUCKETS_MS.indexOf(100);
    expect(buckets[idxLe1]).toBe(1);
    expect(buckets[idxLe5]).toBe(1);
    expect(buckets[idxLe50]).toBe(1);
    expect(buckets[idxLe100]).toBe(1);
    expect(snap['m']?.durationCount).toBe(4);
    expect(snap['m']?.durationSumMs).toBe(0 + 3 + 50 + 99);
  });

  it('lands oversize samples in the +Inf bucket', () => {
    const reg = new MetricsRegistry();
    reg.recordDuration('m', 999_999);
    const snap = reg.snapshot();
    const buckets = snap['m']?.durationBuckets ?? [];
    expect(buckets[buckets.length - 1]).toBe(1);
    expect(snap['m']?.durationCount).toBe(1);
  });

  it('clamps negative durations to 0', () => {
    const reg = new MetricsRegistry();
    reg.recordDuration('m', -10);
    const snap = reg.snapshot();
    expect(snap['m']?.durationSumMs).toBe(0);
    // Sample lands in the first bucket (<= 1).
    expect(snap['m']?.durationBuckets[0]).toBe(1);
  });
});

describe('MetricsRegistry — snapshot immutability', () => {
  it('returns a deep-frozen object', () => {
    const reg = new MetricsRegistry();
    reg.recordRequest('m');
    const snap = reg.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap['m'])).toBe(true);
    expect(Object.isFrozen(snap['m']?.errorsByCode)).toBe(true);
    expect(Object.isFrozen(snap['m']?.durationBuckets)).toBe(true);
  });

  it('snapshot does not reflect post-snapshot mutations (defensive copy)', () => {
    const reg = new MetricsRegistry();
    reg.recordRequest('m');
    const snap = reg.snapshot();
    reg.recordRequest('m');
    expect(snap['m']?.requests).toBe(1);
    expect(reg.snapshot()['m']?.requests).toBe(2);
  });
});

describe('MetricsRegistry — Prometheus exposition', () => {
  it('emits HELP/TYPE blocks and method-keyed series', () => {
    const reg = new MetricsRegistry();
    reg.recordRequest('ccsm.v1/healthz');
    reg.recordRequest('ccsm.v1/healthz');
    reg.recordError('ccsm.v1/healthz', 'INTERNAL');
    reg.recordDuration('ccsm.v1/healthz', 7);
    const text = reg.formatPrometheus();
    expect(text).toContain('# TYPE ccsm_envelope_requests_total counter');
    expect(text).toContain('ccsm_envelope_requests_total{method="ccsm.v1/healthz"} 2');
    expect(text).toContain('# TYPE ccsm_envelope_errors_total counter');
    expect(text).toContain(
      'ccsm_envelope_errors_total{method="ccsm.v1/healthz",code=""} 1',
    );
    expect(text).toContain(
      'ccsm_envelope_errors_total{method="ccsm.v1/healthz",code="INTERNAL"} 1',
    );
    expect(text).toContain('# TYPE ccsm_envelope_duration_ms histogram');
    expect(text).toContain('ccsm_envelope_duration_ms_count{method="ccsm.v1/healthz"} 1');
    expect(text).toContain('ccsm_envelope_duration_ms_sum{method="ccsm.v1/healthz"} 7');
    expect(text).toContain('le="+Inf"');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes special characters in label values', () => {
    const reg = new MetricsRegistry();
    reg.recordError('quote"method', 'has\nnewline');
    const text = reg.formatPrometheus();
    expect(text).toContain('quote\\"method');
    expect(text).toContain('has\\nnewline');
  });
});

describe('MetricsRegistry — reset', () => {
  it('drops all per-method counters', () => {
    const reg = new MetricsRegistry();
    reg.recordRequest('m');
    reg.recordError('m', 'X');
    reg.reset();
    expect(reg.snapshot()).toEqual({});
  });
});
