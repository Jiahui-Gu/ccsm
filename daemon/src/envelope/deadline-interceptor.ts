// L1 envelope deadline interceptor (spec §3.4.1.f deadlineInterceptor + §3.4.1.c
// reserved-headers paragraph; cross-frag bound to frag-3.5.1 §3.5.1.3 unary
// AbortSignal composition).
//
// Reads the reserved `x-ccsm-deadline-ms` header, validates it sits inside the
// canonical [100 ms .. 120 s] envelope, and resolves a numeric deadline in
// milliseconds. The default of 5000 ms mirrors the daemon-side hello reply
// `defaults.deadlineMs` field (spec §3.4.1.g) so a client that omits the
// header gets the same deadline the daemon advertises.
//
// Single Responsibility: this module is a PURE header-policy decider. It does
// NOT install timers, does NOT wire `AbortSignal.timeout`, does NOT compose
// signals — those are the caller's job (interceptor pipeline owns that
// composition per spec §3.4.1.f). It also does NOT emit the
// `unknown_xccsm_header` warn line (separate concern; same interceptor in the
// pipeline emits it but logging is a sink, not a decision).

/** Lower clamp bound for the resolved deadline (spec §3.4.1.c / §3.4.1.f). */
export const MIN_DEADLINE_MS = 100;

/** Upper clamp bound for the resolved deadline (spec §3.4.1.c / §3.4.1.f). */
export const MAX_DEADLINE_MS = 120_000;

/**
 * Default deadline applied when the client omits `x-ccsm-deadline-ms`. Mirrors
 * the daemon hello reply `defaults.deadlineMs` (spec §3.4.1.g, frag-3.5.1
 * §3.5.1.3 — "5s for unary RPCs").
 */
export const DEFAULT_DEADLINE_MS = 5_000;

/** Canonical reserved header key (spec §3.4.1.c reserved-headers list). */
export const DEADLINE_HEADER = 'x-ccsm-deadline-ms';

export interface DeadlineInterceptorContext {
  /**
   * Envelope headers as parsed by the wire-format layer (spec §3.4.1.c). Keys
   * are case-insensitive on the wire; the caller is responsible for
   * lower-casing keys before they reach this interceptor (the upstream
   * `traceInterceptor` already normalizes). Values may arrive as `string`
   * (canonical form for an incoming JSON envelope) or `number` (a programmatic
   * caller may set it directly without going through `JSON.stringify`).
   */
  readonly headers: Record<string, string | number>;
  /** Method name solely for diagnostics; this interceptor does not branch on it. */
  readonly rpcName: string;
}

/** Canonical error codes the interceptor can emit (spec §3.4.1.c reject path). */
export type DeadlineErrorCode = 'deadline_too_small' | 'deadline_too_large' | 'deadline_invalid';

export interface DeadlineResult {
  readonly deadlineMs: number;
}

export interface DeadlineRejection {
  readonly error: {
    readonly code: DeadlineErrorCode;
    readonly message: string;
  };
}

/**
 * Resolve the per-RPC deadline from envelope headers.
 *
 * Returns either `{ deadlineMs }` (caller wires `AbortSignal.timeout` from
 * this) or `{ error }` (caller writes a `schema_violation`-shaped reject frame
 * and short-circuits the interceptor chain — same posture as the schema
 * validator at spec §3.4.1.d).
 *
 * Header resolution rules (spec §3.4.1.c + task brief):
 *   - Missing / `undefined` / `null` / empty string → `DEFAULT_DEADLINE_MS`.
 *   - Non-numeric string (e.g. `"abc"`) → reject `deadline_invalid`.
 *   - Non-integer numeric (NaN, Infinity, fractional) → reject `deadline_invalid`.
 *   - Integer < `MIN_DEADLINE_MS` → reject `deadline_too_small`.
 *   - Integer > `MAX_DEADLINE_MS` → reject `deadline_too_large`.
 *   - Otherwise → `{ deadlineMs: <integer> }`.
 *
 * Note on "clamp" wording (spec §3.4.1.c uses "clamped 100ms ≤ x ≤ 120s"):
 * the v0.3 lock per task brief is REJECT on out-of-range, not silent clamp,
 * so a buggy v0.5 web client cannot accidentally hide an absurd 10-minute
 * deadline behind a silent 120 s coercion — easier to detect during the
 * v0.5 cutover. The bounds themselves match the spec; only the policy on
 * violation is "reject" not "coerce".
 */
export function applyDeadline(
  ctx: DeadlineInterceptorContext,
): DeadlineResult | DeadlineRejection {
  const raw = ctx.headers[DEADLINE_HEADER];

  if (raw === undefined || raw === null || raw === '') {
    return { deadlineMs: DEFAULT_DEADLINE_MS };
  }

  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else {
    // String path: tolerate leading/trailing whitespace from a sloppy client
    // but reject anything else (including hex / scientific / `+5000`).
    const trimmed = raw.trim();
    if (trimmed === '') {
      return { deadlineMs: DEFAULT_DEADLINE_MS };
    }
    if (!/^-?\d+$/.test(trimmed)) {
      return reject(
        'deadline_invalid',
        `header ${DEADLINE_HEADER}=${JSON.stringify(raw)} is not an integer`,
      );
    }
    value = Number.parseInt(trimmed, 10);
  }

  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return reject(
      'deadline_invalid',
      `header ${DEADLINE_HEADER}=${JSON.stringify(raw)} is not a finite integer`,
    );
  }

  if (value < MIN_DEADLINE_MS) {
    return reject(
      'deadline_too_small',
      `header ${DEADLINE_HEADER}=${value} below minimum ${MIN_DEADLINE_MS}`,
    );
  }
  if (value > MAX_DEADLINE_MS) {
    return reject(
      'deadline_too_large',
      `header ${DEADLINE_HEADER}=${value} above maximum ${MAX_DEADLINE_MS}`,
    );
  }

  return { deadlineMs: value };
}

function reject(code: DeadlineErrorCode, message: string): DeadlineRejection {
  return { error: { code, message } };
}
