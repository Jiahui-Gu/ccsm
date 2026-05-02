// L1 envelope metrics interceptor (spec §3.4.1.f built-in interceptor list —
// slot "metrics", LAST in the chain, runs after trace / hello / deadline /
// migrationGate so a request rejected by an upstream interceptor still
// increments the appropriate counter via its own `recordError(method, code)`
// call site).
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//     §3.4.1.f built-in interceptor list ("metrics" — per-method counters).
//   - Same fragment §3.4.1.h SUPERVISOR_RPCS list — `/stats` is an existing
//     supervisor RPC; the metrics snapshot produced here is the data backing
//     that endpoint (handler wiring is out of scope for this module — the
//     handler queries `MetricsRegistry.snapshot()` / `formatPrometheus()`).
//
// Single Responsibility (producer / decider / sink):
//   - This module owns ONE thing: an in-memory per-method counter table.
//     - `recordRequest(method)`               — bump request counter.
//     - `recordError(method, code?)`          — bump error counter (optionally
//                                              per error-code sub-counter).
//     - `recordDuration(method, durationMs)`  — push into the per-method
//                                              histogram bucket array.
//     - `snapshot()`                          — read-only structured snapshot.
//     - `formatPrometheus()`                  — text-exposition for `/metrics`.
//     - `reset()`                             — test-facing wipe.
//   - It does NOT read the wall-clock (caller passes pre-computed durationMs
//     from the trace span), does NOT subscribe to any event bus, does NOT
//     spawn timers, does NOT touch the network. The HTTP / envelope handler
//     that surfaces `/stats` calls `formatPrometheus()` synchronously.

/**
 * Histogram bucket boundaries in milliseconds. Bucket `i` counts samples with
 * `durationMs <= HISTOGRAM_BUCKETS_MS[i]`; the implicit `+Inf` bucket is the
 * total request count (Prometheus convention). Boundaries cover the v0.3
 * envelope deadline range [100 ms .. 120 s] plus sub-100 ms cells for fast
 * supervisor RPCs (`/healthz`).
 */
export const HISTOGRAM_BUCKETS_MS: readonly number[] = [
  1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 120_000,
] as const;

/** Per-method counter snapshot (read-only). */
export interface MethodCounters {
  readonly requests: number;
  readonly errors: number;
  /**
   * Errors bucketed by wire code (`'hello_required'`, `'MIGRATION_PENDING'`,
   * `'INTERNAL'`, etc.). Kept as a plain object so JSON serialisation in
   * `/stats` is one line; ordering is insertion-order which is fine for
   * forensic dumps.
   */
  readonly errorsByCode: Readonly<Record<string, number>>;
  /**
   * Histogram bucket counts aligned with {@link HISTOGRAM_BUCKETS_MS}. Length
   * is `HISTOGRAM_BUCKETS_MS.length + 1`; the trailing entry is the `+Inf`
   * bucket (samples larger than any defined boundary).
   */
  readonly durationBuckets: readonly number[];
  /** Sum of all observed `durationMs` samples. Prometheus convention. */
  readonly durationSumMs: number;
  /** Count of `recordDuration` calls. Equals sum of `durationBuckets` entries. */
  readonly durationCount: number;
}

/** Full registry snapshot, keyed by method name. */
export type MetricsSnapshot = Readonly<Record<string, MethodCounters>>;

interface MutableMethodCounters {
  requests: number;
  errors: number;
  errorsByCode: Map<string, number>;
  durationBuckets: number[];
  durationSumMs: number;
  durationCount: number;
}

/**
 * Per-method in-memory counter table. One instance per daemon process; the
 * supervisor wires it into the envelope dispatcher (and into the `/stats`
 * handler). Tests instantiate a fresh registry per case for isolation.
 *
 * Concurrency note: Node's event loop is single-threaded, so `recordX` calls
 * are atomic by construction. No locking needed.
 */
export class MetricsRegistry {
  private readonly methods = new Map<string, MutableMethodCounters>();

  private getOrCreate(method: string): MutableMethodCounters {
    let entry = this.methods.get(method);
    if (entry === undefined) {
      entry = {
        requests: 0,
        errors: 0,
        errorsByCode: new Map(),
        // +1 for the `+Inf` bucket.
        durationBuckets: new Array(HISTOGRAM_BUCKETS_MS.length + 1).fill(0),
        durationSumMs: 0,
        durationCount: 0,
      };
      this.methods.set(method, entry);
    }
    return entry;
  }

  /** Bump the per-method request counter. Call once per inbound envelope. */
  recordRequest(method: string): void {
    this.getOrCreate(method).requests += 1;
  }

  /**
   * Bump the per-method error counter (and optionally a per-code sub-counter).
   * Pass `code` for finer breakdown in the snapshot — omit when the caller
   * only knows that *something* failed.
   */
  recordError(method: string, code?: string): void {
    const entry = this.getOrCreate(method);
    entry.errors += 1;
    if (code !== undefined && code !== '') {
      entry.errorsByCode.set(code, (entry.errorsByCode.get(code) ?? 0) + 1);
    }
  }

  /**
   * Push a `durationMs` observation into the histogram. Negative values are
   * clamped to 0 (cf. {@link formatCompletionLog} which does the same on a
   * non-monotonic clock).
   */
  recordDuration(method: string, durationMs: number): void {
    const entry = this.getOrCreate(method);
    const sample = Math.max(0, durationMs);
    entry.durationSumMs += sample;
    entry.durationCount += 1;
    let placed = false;
    for (let i = 0; i < HISTOGRAM_BUCKETS_MS.length; i += 1) {
      if (sample <= (HISTOGRAM_BUCKETS_MS[i] as number)) {
        entry.durationBuckets[i] = (entry.durationBuckets[i] as number) + 1;
        placed = true;
        break;
      }
    }
    if (!placed) {
      // +Inf bucket.
      const last = entry.durationBuckets.length - 1;
      entry.durationBuckets[last] = (entry.durationBuckets[last] as number) + 1;
    }
  }

  /**
   * Read-only snapshot for `/stats` (JSON) consumers. Deep-frozen so a buggy
   * handler cannot mutate the live registry through the snapshot reference.
   */
  snapshot(): MetricsSnapshot {
    const out: Record<string, MethodCounters> = {};
    for (const [method, entry] of this.methods) {
      const errorsByCode: Record<string, number> = {};
      for (const [code, count] of entry.errorsByCode) {
        errorsByCode[code] = count;
      }
      out[method] = Object.freeze({
        requests: entry.requests,
        errors: entry.errors,
        errorsByCode: Object.freeze(errorsByCode),
        durationBuckets: Object.freeze(entry.durationBuckets.slice()),
        durationSumMs: entry.durationSumMs,
        durationCount: entry.durationCount,
      });
    }
    return Object.freeze(out);
  }

  /**
   * Format the registry as Prometheus text-exposition v0.0.4. Suitable for
   * `/metrics` HTTP endpoint output. Three families per method:
   *   - `ccsm_envelope_requests_total{method="..."}`
   *   - `ccsm_envelope_errors_total{method="...",code="..."}`
   *   - `ccsm_envelope_duration_ms_bucket{method="...",le="..."}` (+ _sum / _count)
   */
  formatPrometheus(): string {
    const lines: string[] = [];
    lines.push('# HELP ccsm_envelope_requests_total Total envelope requests by method.');
    lines.push('# TYPE ccsm_envelope_requests_total counter');
    for (const [method, entry] of this.methods) {
      lines.push(`ccsm_envelope_requests_total{method="${escapeLabel(method)}"} ${entry.requests}`);
    }
    lines.push('# HELP ccsm_envelope_errors_total Total envelope errors by method and code.');
    lines.push('# TYPE ccsm_envelope_errors_total counter');
    for (const [method, entry] of this.methods) {
      // Always emit a `code=""` aggregate so dashboards have a stable series
      // even on methods that have never failed.
      lines.push(
        `ccsm_envelope_errors_total{method="${escapeLabel(method)}",code=""} ${entry.errors}`,
      );
      for (const [code, count] of entry.errorsByCode) {
        lines.push(
          `ccsm_envelope_errors_total{method="${escapeLabel(method)}",code="${escapeLabel(code)}"} ${count}`,
        );
      }
    }
    lines.push('# HELP ccsm_envelope_duration_ms Envelope handler duration in milliseconds.');
    lines.push('# TYPE ccsm_envelope_duration_ms histogram');
    for (const [method, entry] of this.methods) {
      let cumulative = 0;
      for (let i = 0; i < HISTOGRAM_BUCKETS_MS.length; i += 1) {
        cumulative += entry.durationBuckets[i] as number;
        lines.push(
          `ccsm_envelope_duration_ms_bucket{method="${escapeLabel(method)}",le="${HISTOGRAM_BUCKETS_MS[i] as number}"} ${cumulative}`,
        );
      }
      cumulative += entry.durationBuckets[entry.durationBuckets.length - 1] as number;
      lines.push(
        `ccsm_envelope_duration_ms_bucket{method="${escapeLabel(method)}",le="+Inf"} ${cumulative}`,
      );
      lines.push(
        `ccsm_envelope_duration_ms_sum{method="${escapeLabel(method)}"} ${entry.durationSumMs}`,
      );
      lines.push(
        `ccsm_envelope_duration_ms_count{method="${escapeLabel(method)}"} ${entry.durationCount}`,
      );
    }
    // Prometheus exposition requires a trailing newline.
    return `${lines.join('\n')}\n`;
  }

  /** Test-facing wipe — drops all per-method counters. */
  reset(): void {
    this.methods.clear();
  }
}

/** Escape Prometheus label-value characters per text-exposition spec. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
