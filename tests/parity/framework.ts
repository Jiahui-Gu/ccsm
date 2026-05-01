// T07 — parity-test framework (M1 first PR; load-bearing for M2 bridge swap).
//
// Spec: docs/superpowers/specs/2026-05-01-v0.4-web-design.md
//   - ch03 §7   (test discipline per swap PR)
//   - ch03 §7.1 (parity-test framework: assertParity + ignoreFields + coerce)
//   - ch08 §3   (L2 daemon Connect handler unit + contract tests)
//   - ch08 §8   (reverse-verify discipline; equivalence is the gating mechanism)
//   - ch09 §2 T07 deliverable
//
// Single Responsibility (producer / decider / sink):
//   - PRODUCER: this module produces a "passed" or "diverged" verdict per case.
//   - DECIDER: `defaultEquivalence` (deep-equal under ignoreFields/coerce) is
//     the single decision point — a test author can swap it via the
//     `equivalence` option (escape hatch for type-widening cases per ch03 §7.1's
//     "normalizationStrategy" + reverse-verify discipline).
//   - SINK: throwing `ParityDivergenceError` is the only side effect — vitest
//     converts the throw into a test failure with the diff as message body.
//     This module does NOT log, does NOT write fixtures, does NOT touch
//     network. Fixture recording (RECORD_PARITY=1) is a separate scope (T09+).
//
// Why the framework lives at `tests/parity/` (not `daemon/__tests__/parity/`
// as the spec suggests): the parity case crosses three layers — daemon
// envelope handler + daemon Connect handler + electron preload bridge
// equivalence. Placing it under `daemon/__tests__/` would imply a daemon-only
// concern; the cross-cutting location matches `tests/electron-load-smoke.test.ts`
// + `tests/persist-shape.test.ts` precedent for cross-layer assertions. Manager
// confirmed at task #1086 dispatch.

import { isDeepStrictEqual } from 'node:util';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Equivalence options shared by `assertParity` and `defaultEquivalence`.
 *
 * - `ignoreFields`: dotted paths whose values are dropped from BOTH sides
 *   before comparison. Use for fields that are non-deterministic by design
 *   (timestamps, ULIDs, trace-ids, PIDs). Per ch03 §7.1 the framework MUST
 *   handle these without forcing per-RPC custom code.
 *
 * - `coerce`: per-field normalizer applied to BOTH sides before comparison.
 *   Use when v0.3 returns `unknown`-typed scalars (e.g. `pid: number | string`)
 *   and v0.4 returns a single typed shape — coerce both to the canonical
 *   type, then compare.
 */
export interface ParityOptions {
  readonly ignoreFields?: readonly string[];
  readonly coerce?: Readonly<Record<string, (value: unknown) => unknown>>;
}

/**
 * Equivalence function signature. Default is `defaultEquivalence` (deep-equal
 * under {@link ParityOptions}); test authors may pass their own to handle
 * the type-widening cases of ch03 §7.1 ("normalizationStrategy") or to
 * reverse-verify the test (override to `() => true` and confirm a divergent
 * case still PASSES — that proves equivalence is the gate).
 */
export type EquivalenceFn = (
  envelopeResp: unknown,
  connectResp: unknown,
  opts?: ParityOptions,
) => boolean;

/**
 * One parity case. The framework calls both transports in parallel, then
 * compares the responses via `equivalence`.
 */
export interface ParityCase<TResp = unknown> {
  /** Human-readable case ID. Surfaces in failure messages. */
  readonly name: string;

  /** Invokes the v0.3 envelope path. */
  readonly envelopeCall: () => Promise<TResp>;

  /** Invokes the v0.4 Connect path. */
  readonly connectCall: () => Promise<TResp>;

  /**
   * Equivalence function. Defaults to {@link defaultEquivalence} (deep-equal
   * under {@link tolerantFields} / {@link coerce}). Pass your own to opt into
   * the type-widening normalization of ch03 §7.1, or to reverse-verify the
   * case (pass `() => true`).
   */
  readonly equivalence?: EquivalenceFn;

  /**
   * Convenience alias for {@link ParityOptions.ignoreFields}, surfaced at the
   * top level because every parity case in M1 needs at least the trace-id +
   * timestamp ignore. Internally folded into the options passed to
   * `equivalence`.
   */
  readonly tolerantFields?: readonly string[];

  /** Per-field coercion. See {@link ParityOptions.coerce}. */
  readonly coerce?: ParityOptions['coerce'];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when envelope and Connect responses are not equivalent under the
 * supplied (or default) equivalence function. The message body contains a
 * side-by-side diff so the failing PR shows the offending fields without the
 * developer needing to grep two huge JSON blobs.
 */
export class ParityDivergenceError extends Error {
  public readonly envelopeResp: unknown;
  public readonly connectResp: unknown;

  constructor(args: {
    caseName?: string;
    envelopeResp: unknown;
    connectResp: unknown;
    diff: string;
  }) {
    const head = args.caseName
      ? `parity divergence in ${args.caseName}`
      : 'parity divergence';
    super(`${head}\n${args.diff}`);
    this.name = 'ParityDivergenceError';
    this.envelopeResp = args.envelopeResp;
    this.connectResp = args.connectResp;
  }
}

// ---------------------------------------------------------------------------
// Default equivalence + assertion
// ---------------------------------------------------------------------------

/**
 * Default equivalence: deep-equal under ignoreFields + coerce. Used by
 * `assertParity` and `runParityCase` when no override is supplied.
 *
 * Implementation is `node:util.isDeepStrictEqual` after stripping ignore-fields
 * and applying coerce. Both inputs are normalized through the same pipeline
 * to keep the operation symmetric.
 */
export const defaultEquivalence: EquivalenceFn = (envelopeResp, connectResp, opts) => {
  const a = normalize(envelopeResp, opts);
  const b = normalize(connectResp, opts);
  return isDeepStrictEqual(a, b);
};

/**
 * Low-level assertion. Throws {@link ParityDivergenceError} if the two
 * responses are not deep-equal under the supplied options. Used by
 * `runParityCase` when no `equivalence` override is given; also exported so
 * tests outside the framework (e.g. M2 bridge-swap PRs) can reuse the same
 * comparison engine without going through the full case runner.
 */
export function assertParity(
  envelopeResp: unknown,
  connectResp: unknown,
  opts?: ParityOptions,
  caseName?: string,
): void {
  if (defaultEquivalence(envelopeResp, connectResp, opts)) return;
  throw new ParityDivergenceError({
    caseName,
    envelopeResp,
    connectResp,
    diff: renderDiff(normalize(envelopeResp, opts), normalize(connectResp, opts)),
  });
}

// ---------------------------------------------------------------------------
// Case runner
// ---------------------------------------------------------------------------

/**
 * Run a parity case: invoke both transports in parallel, then assert
 * equivalence. Throws {@link ParityDivergenceError} on mismatch (which vitest
 * surfaces as a test failure with the diff as message). Errors thrown by
 * either transport are propagated as-is — they are NOT swallowed as a
 * divergence, because a transport-level error means the test environment is
 * broken (not that the bridge is wrong).
 *
 * Per ch08 §8 reverse-verify discipline, passing `equivalence: () => true`
 * causes any divergent case to pass — useful for reverse-verifying that the
 * equivalence function is the gating mechanism, not some happy-path
 * coincidence in the rest of the test setup.
 */
export async function runParityCase<TResp>(c: ParityCase<TResp>): Promise<void> {
  // Parallel invocation per ch03 §7.1 — keeps the case runtime bounded by
  // max(envelope, connect) rather than the sum, which matters when the
  // corpus grows to ~46 RPCs (ch02 §1).
  const [envelopeResp, connectResp] = await Promise.all([
    c.envelopeCall(),
    c.connectCall(),
  ]);

  const equivalence = c.equivalence ?? defaultEquivalence;
  const opts: ParityOptions = {
    ignoreFields: c.tolerantFields,
    coerce: c.coerce,
  };

  if (equivalence(envelopeResp, connectResp, opts)) return;

  throw new ParityDivergenceError({
    caseName: c.name,
    envelopeResp,
    connectResp,
    diff: renderDiff(normalize(envelopeResp, opts), normalize(connectResp, opts)),
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Apply ignoreFields + coerce to one response. Returns a deep clone; the
 * input is not mutated. We deep-clone via `structuredClone` so callers can
 * pass live response objects without worrying about test contamination.
 */
function normalize(value: unknown, opts: ParityOptions | undefined): unknown {
  if (opts === undefined || (!opts.ignoreFields && !opts.coerce)) {
    return safeClone(value);
  }
  const cloned = safeClone(value);
  if (opts.ignoreFields) {
    for (const path of opts.ignoreFields) {
      deletePath(cloned, path);
    }
  }
  if (opts.coerce) {
    for (const [path, fn] of Object.entries(opts.coerce)) {
      coercePath(cloned, path, fn);
    }
  }
  return cloned;
}

/** structuredClone falls back to JSON round-trip for environments that lack it. */
function safeClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON path for non-structured-cloneable values
      // (functions, symbols). Parity responses are always JSON-shaped per
      // ch02 §1 (Connect/Protobuf wire), so the JSON fallback is faithful.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Delete a value at a dotted path. No-op if the path is absent. */
function deletePath(root: unknown, path: string): void {
  const segments = path.split('.');
  let cursor: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    if (typeof cursor !== 'object' || cursor === null) return;
    cursor = (cursor as Record<string, unknown>)[segments[i]!];
  }
  if (typeof cursor === 'object' && cursor !== null) {
    delete (cursor as Record<string, unknown>)[segments[segments.length - 1]!];
  }
}

/** Apply coerce fn to the value at a dotted path. No-op if the path is absent. */
function coercePath(
  root: unknown,
  path: string,
  fn: (v: unknown) => unknown,
): void {
  const segments = path.split('.');
  let cursor: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    if (typeof cursor !== 'object' || cursor === null) return;
    cursor = (cursor as Record<string, unknown>)[segments[i]!];
  }
  if (typeof cursor !== 'object' || cursor === null) return;
  const tail = segments[segments.length - 1]!;
  if (!(tail in (cursor as Record<string, unknown>))) return;
  (cursor as Record<string, unknown>)[tail] = fn(
    (cursor as Record<string, unknown>)[tail],
  );
}

/**
 * Render a side-by-side diff of two normalized values. Output format:
 *
 *     envelope (v0.3):
 *     <indented JSON>
 *
 *     connect  (v0.4):
 *     <indented JSON>
 *
 *     differing fields:
 *     - <path>: <env value> vs <connect value>
 *
 * No external diff dep yet — the codebase has no `diff` / `json-diff` package
 * and adding one purely for the framework scaffold isn't justified at M1
 * scale. If M2 bridge-swap PRs find the diff hard to read, swap in `jest-diff`
 * (small, no transitive deps) — the renderDiff fn is the single seam.
 */
function renderDiff(a: unknown, b: unknown): string {
  const lines: string[] = [];
  lines.push('envelope (v0.3):');
  lines.push(indent(stringify(a)));
  lines.push('');
  lines.push('connect  (v0.4):');
  lines.push(indent(stringify(b)));
  const fieldDiffs = collectFieldDiffs(a, b, '');
  if (fieldDiffs.length > 0) {
    lines.push('');
    lines.push('differing fields:');
    for (const fd of fieldDiffs) {
      lines.push(`- ${fd}`);
    }
  }
  return lines.join('\n');
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n');
}

/**
 * Walk both values in parallel, collect per-leaf differences as
 * "path: a vs b" strings. Bounded at 50 lines so a wholly-divergent response
 * doesn't drown the test report.
 */
function collectFieldDiffs(
  a: unknown,
  b: unknown,
  path: string,
  out: string[] = [],
): string[] {
  if (out.length >= 50) return out;
  if (isDeepStrictEqual(a, b)) return out;
  const aIsObj = typeof a === 'object' && a !== null && !Array.isArray(a);
  const bIsObj = typeof b === 'object' && b !== null && !Array.isArray(b);
  if (aIsObj && bIsObj) {
    const keys = new Set([
      ...Object.keys(a as Record<string, unknown>),
      ...Object.keys(b as Record<string, unknown>),
    ]);
    for (const k of keys) {
      const child = path ? `${path}.${k}` : k;
      collectFieldDiffs(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        child,
        out,
      );
    }
    return out;
  }
  // Leaf or array: emit one line.
  out.push(`${path || '<root>'}: ${stringify(a)} vs ${stringify(b)}`);
  return out;
}
