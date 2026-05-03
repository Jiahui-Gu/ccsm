// Single source of truth for ErrorDetail emission on the daemon side.
// Spec ch02 §3 / §6, ch04 §2.
//
// T2.5 scope: a tiny, pure-decider module that
//   1. enumerates the v0.3 forever-stable `ErrorDetail.code` strings as a
//      closed string-literal union, so call sites cannot drift;
//   2. maps each standard code to its forever-stable Connect `Code`
//      mapping (ch02 §5 `daemon.starting` → UNAVAILABLE; ch04 §3
//      `version.client_too_old` → FAILED_PRECONDITION; ch04 §2 / §7.1
//      `request.missing_id` → INVALID_ARGUMENT; ch05 §4 / §5
//      `session.not_owned` → PERMISSION_DENIED);
//   3. exposes one builder + one thrower so handlers write
//
//        throwError('session.not_owned', undefined, { session_id });
//
//      instead of hand-rolling `new ConnectError(..., Code.X, undefined,
//      [{ desc: ErrorDetailSchema, value: { code, message, extra } }])`
//      at every call site.
//
// SRP: pure decider only. NO I/O, NO logging, NO global state. Callers
// (handlers, middleware) own the side effect of throwing into Connect.
// `throwError` is sugar over `buildError` — `buildError` returns a
// `ConnectError` so handlers that need to attach the error to a stream
// or wrap it can use the value form.
//
// Forever-stable surface (per spec ch04 §2 / §8 additivity rule):
//   - The 4 codes below MUST NOT be renamed, removed, or repurposed in
//     any v0.3.x patch. v0.4+ may ADD new codes by extending the
//     `STANDARD_ERROR_MAP` table; the closed-enum type widens
//     automatically (it is derived from `keyof typeof`).
//   - Connect code mappings MUST NOT change for an existing string code
//     once it ships — Electron / web / iOS clients branch on the pair
//     `(connect_code, error_detail.code)`.
//
// Layer 1 — alternatives checked:
//   - Hand-rolling ConnectError at each handler: 30+ call sites would
//     drift on the code-string spelling and on the Connect-code mapping
//     (ch04 §7.1 #4 round-trip test pins the strings, but doesn't pin
//     the daemon emission). Single source of truth is cheaper than
//     spec-test-drift.
//   - Generating the table from proto: ErrorDetail is a free-form
//     message in `common.proto` (the codes are documentation-only); the
//     proto file deliberately does NOT enumerate codes (open set per
//     ch04 §2). The TS-side closed enum is the v0.3 emission contract,
//     not the wire contract.
//   - Reusing a third-party "structured error" lib (e.g. @bufbuild
//     google.rpc.Status helpers): Connect-ES v2's `OutgoingDetail`
//     shape `{ desc, value }` is already the canonical attach point.
//     A wrapper adds zero value over a 5-line helper.

import { Code, ConnectError } from '@connectrpc/connect';
import { ErrorDetailSchema } from '@ccsm/proto';

/**
 * Forever-stable v0.3 standard `ErrorDetail.code` → Connect `Code`
 * mapping. Each row pins the spec section that locks both the string
 * code and the Connect code, so a reviewer can grep one identifier and
 * find the source of truth.
 *
 * Adding a new row in v0.4+: append only. Renaming or removing a row is
 * a breaking change at the wire level (`buf breaking` won't catch it
 * because the strings live in TS, not in `common.proto` — reviewers
 * MUST treat this table like a forever-stable proto enum).
 */
export const STANDARD_ERROR_MAP = {
  // ch02 §5 — Listener A connect during boot (Supervisor /healthz 503).
  'daemon.starting': Code.Unavailable,
  // ch04 §3 — Hello negotiation: client.proto_min_version > daemon.proto_version.
  'version.client_too_old': Code.FailedPrecondition,
  // ch04 §2 / §7.1 — RequestMeta validation: empty request_id.
  'request.missing_id': Code.InvalidArgument,
  // ch05 §4 / §5 — per-RPC ownership enforcement matrix.
  'session.not_owned': Code.PermissionDenied,
} as const satisfies Record<string, Code>;

/**
 * Closed string-literal union of v0.3 standard `ErrorDetail.code`
 * values. ts-only typecheck enforces that `throwError` / `buildError`
 * cannot be called with an arbitrary string (drift detection).
 *
 * Derived from `STANDARD_ERROR_MAP` so adding a row in the table
 * widens the type automatically — there is no second list to keep in
 * sync.
 */
export type StandardErrorCode = keyof typeof STANDARD_ERROR_MAP;

/**
 * Default human-readable messages per code. Used when a caller does
 * NOT pass a `message` override. Strings are advisory (UI may show);
 * they are NOT a wire contract — the wire contract is the code string.
 *
 * Kept aligned with `packages/proto/test/contract/error-detail-roundtrip.spec.ts`
 * so the contract test's fixture messages match what the daemon emits
 * by default. Drift here is harmless on the wire but helps reviewers
 * verify the round-trip test reflects real daemon behavior.
 */
const DEFAULT_MESSAGES: Record<StandardErrorCode, string> = {
  'daemon.starting': 'Daemon is still starting; retry in 200ms.',
  'version.client_too_old':
    'Client proto_min_version exceeds daemon proto_version.',
  'request.missing_id':
    'request_id is required and must be a non-empty UUIDv4.',
  'session.not_owned': 'Session is owned by a different principal.',
};

/**
 * Construct a `ConnectError` carrying an `ErrorDetail` proto in the
 * Connect-ES v2 outgoing-details slot. Returns the value so callers
 * that need to attach the error to a stream (e.g. server-streaming
 * RPCs that emit then close-with-error) can use it without throwing.
 *
 * Most call sites should use `throwError` instead.
 *
 * @param code     Standard error code (closed enum).
 * @param message  Optional human override; defaults to `DEFAULT_MESSAGES[code]`.
 * @param extra    Optional `map<string,string>` payload (e.g.
 *                 `{ session_id, principal, daemon_proto_version }`).
 *                 Keys are open per ch04 §7.1; reviewers SHOULD reuse
 *                 existing key names where possible.
 */
export function buildError(
  code: StandardErrorCode,
  message?: string,
  extra?: Readonly<Record<string, string>>,
): ConnectError {
  const connectCode = STANDARD_ERROR_MAP[code];
  const humanMessage = message ?? DEFAULT_MESSAGES[code];
  return new ConnectError(humanMessage, connectCode, undefined, [
    {
      desc: ErrorDetailSchema,
      value: {
        code,
        message: humanMessage,
        extra: extra ? { ...extra } : {},
      },
    },
  ]);
}

/**
 * Throw a `ConnectError` carrying an `ErrorDetail` for the given
 * standard code. The return type is `never` so TypeScript narrows
 * control flow at the call site (e.g. `if (!s) throwError(...)` makes
 * `s` non-nullable below).
 */
export function throwError(
  code: StandardErrorCode,
  message?: string,
  extra?: Readonly<Record<string, string>>,
): never {
  throw buildError(code, message, extra);
}
