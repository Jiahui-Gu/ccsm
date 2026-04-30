// Daemon protocol-version validator (spec §3.4.1.g + frag-3.4.1 r9 lock).
//
// `daemonProtocolVersion` is an INTEGER (uint, semver-major) — pinned to the
// integer literal in TypeBox per `[manager r9 lock: r8 envelope P1-4 — type
// pinned to integer literal; TypeBox Type.Integer({minimum:1}); compare
// numerically; schema validation REJECTS string values with schema_violation]`
// (spec line 177 / 4063). v0.3 ships `1`. The version bumps ONLY on breaking
// handler-contract changes; additive features go in `protocol.features[]`
// (spec §3.4.1.g version-bump discipline).
//
// Single Responsibility: produce a `{ valid, error? }` decision from a header
// candidate. No I/O, no socket close — caller (adapter) owns the side effect.

import { Type, type Static } from '@sinclair/typebox';

/** Current daemon protocol-version integer. v0.3 = 1. */
export const DAEMON_PROTOCOL_VERSION = 1 as const;

/**
 * TypeBox schema for the `daemonProtocolVersion` header field. Pinned to the
 * exact integer literal of the running daemon so a client carrying any other
 * value (string '1', integer 2, undefined) is rejected at schema validation
 * before dispatch (spec §3.4.1.d).
 */
export const DaemonProtocolVersionSchema = Type.Literal(DAEMON_PROTOCOL_VERSION);

/** Static type derived from the schema; resolves to `1`. */
export type DaemonProtocolVersion = Static<typeof DaemonProtocolVersionSchema>;

export interface ProtocolVersionMismatchError {
  readonly code: 'PROTOCOL_VERSION_MISMATCH';
  readonly expected: number;
  readonly got?: unknown;
}

export type ProtocolVersionCheckResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly error: ProtocolVersionMismatchError };

/**
 * Check the `daemonProtocolVersion` header field against the running daemon's
 * pinned version. Returns a discriminated result; never throws.
 *
 * Rejects:
 *   - missing field (`got` omitted from error)
 *   - non-integer values (string '1', float 1.5, null, etc. — `got` echoed back)
 *   - integers other than `DAEMON_PROTOCOL_VERSION`
 */
export function checkProtocolVersion(
  headers: Readonly<Record<string, unknown>> | null | undefined,
): ProtocolVersionCheckResult {
  if (headers === null || headers === undefined) {
    return {
      valid: false,
      error: { code: 'PROTOCOL_VERSION_MISMATCH', expected: DAEMON_PROTOCOL_VERSION },
    };
  }
  const raw = headers['daemonProtocolVersion'];
  if (raw === undefined) {
    return {
      valid: false,
      error: { code: 'PROTOCOL_VERSION_MISMATCH', expected: DAEMON_PROTOCOL_VERSION },
    };
  }
  // Strict integer literal match — string '1' is a schema violation per the
  // r9 lock (spec line 4063). Use Number.isInteger to guard against floats,
  // NaN, and the `1.0 === 1` JS quirk for non-integers.
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw !== DAEMON_PROTOCOL_VERSION) {
    return {
      valid: false,
      error: {
        code: 'PROTOCOL_VERSION_MISMATCH',
        expected: DAEMON_PROTOCOL_VERSION,
        got: raw,
      },
    };
  }
  return { valid: true };
}
