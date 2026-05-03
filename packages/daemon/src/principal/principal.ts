// Principal model + ownership assertions — spec
// `2026-05-03-v03-daemon-split` ch05 §1–§4 (principal-and-ownership).
//
// A Principal identifies the OS-level caller of a daemon RPC. It is derived
// from the listener's peer-credential probe (Listener A on Unix uses
// SO_PEERCRED / getpeereid; on Windows uses NamedPipeServerStream with the
// caller's SID), NEVER from RPC payload. Once a Principal has been built it
// is the immutable subject of every per-session ownership check inside the
// daemon (assertOwnership).
//
// T3.1 scope: pure data + pure functions. No I/O, no peer-cred probe (that
// is T1.4 / T1.5 — the listener constructs Principal and then passes it
// through every handler context).
//
// Out of scope (separate tasks):
//   - Listener A peer-credential probe         → T1.4 / T1.5
//   - Per-handler context propagation wiring   → T2.x (Connect interceptor)
//   - Session ownership column + DB schema     → T5.2
//   - Owner mismatch logging / metrics         → T9.x

/**
 * Origin of a Principal. Locked to three variants per spec ch05 §1:
 *   - 'unix-user' — POSIX uid (numeric, decimal, no leading zeros).
 *   - 'win-sid'   — Windows security identifier (e.g. `S-1-5-21-...`).
 *   - 'test'      — synthetic principal used by unit tests / harnesses.
 *                   Daemon code MUST refuse `test` when running outside
 *                   `NODE_ENV === 'test'` — gating lives in the listener,
 *                   not here, so this module stays pure.
 *
 * Locked: adding a new kind requires a spec amendment so every ownership
 * check stays exhaustive (TypeScript `never` exhaustiveness in the switch
 * inside `makePrincipal`).
 */
export type PrincipalKind = 'unix-user' | 'win-sid' | 'test';

/**
 * Identity of an RPC caller. Immutable by construction — `Object.freeze`
 * is applied in `makePrincipal`. Compare two Principals with `principalKey`,
 * never with `===` on the object reference (different listener invocations
 * produce different object identities for the same OS user).
 */
export interface Principal {
  readonly kind: PrincipalKind;
  /**
   * Stable per-kind identifier:
   *   - kind='unix-user' -> decimal uid string, e.g. `'1000'`. NOT username.
   *   - kind='win-sid'   -> upper-case SID string, e.g. `'S-1-5-21-...-1001'`.
   *   - kind='test'      -> arbitrary opaque tag used by the test harness.
   *
   * Frozen and case-significant for win-sid (Windows treats SID as
   * case-insensitive in some APIs but the canonical form is upper-case;
   * we normalise on construction to avoid `S-1-...` != `s-1-...` mismatches).
   */
  readonly id: string;
}

/**
 * PermissionDenied is the *only* error type produced by ownership checks.
 * Connect-RPC interceptors map this to `Code.PermissionDenied` (the gRPC
 * canonical code) — see ch05 §4. Every other failure mode (DB error,
 * malformed input) maps to a different code, so callers can rely on
 * `instanceof PermissionDenied` to mean "auth/owner mismatch", not
 * "something else broke".
 *
 * The message intentionally does NOT include the full Principal id — only
 * the kind — to avoid leaking SIDs / uids into logs aggregated by other
 * services. Detailed audit records live in the structured-log line emitted
 * by the interceptor (T9.x), not the exception message.
 */
export class PermissionDenied extends Error {
  /** Discriminant for `instanceof` checks across module/realm boundaries. */
  readonly name = 'PermissionDenied' as const;

  /** Caller principal kind (no id — see class doc). */
  readonly callerKind: PrincipalKind;

  /** Owner principal kind recorded against the resource. */
  readonly ownerKind: PrincipalKind;

  constructor(
    message: string,
    opts: { callerKind: PrincipalKind; ownerKind: PrincipalKind },
  ) {
    super(message);
    this.callerKind = opts.callerKind;
    this.ownerKind = opts.ownerKind;
    // Make the prototype chain robust across `tsc` --target downlevel +
    // bundlers (the standard `extends Error` workaround).
    Object.setPrototypeOf(this, PermissionDenied.prototype);
  }
}

/**
 * Construct a frozen Principal. Validates the id format per kind. Throws
 * `TypeError` (NOT PermissionDenied) on malformed input — bad construction
 * is a programmer error, not an auth failure.
 *
 * Validation rules per ch05 §1:
 *   - 'unix-user' id -> /^[0-9]+$/, no leading zeros except literal `'0'`
 *     (root). Empty string rejected.
 *   - 'win-sid'   id -> /^S-\d+-\d+(-\d+)+$/i, upper-cased on construction.
 *     Must have at least 2 sub-authorities (the SID prefix + revision +
 *     identifier authority + at least one sub-authority).
 *   - 'test'      id -> any non-empty string with no whitespace / control
 *     chars (so it round-trips through structured logs).
 */
export function makePrincipal(kind: PrincipalKind, id: string): Principal {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError(`Principal id must be a non-empty string (kind=${kind})`);
  }
  let normalised: string;
  switch (kind) {
    case 'unix-user': {
      if (!/^[0-9]+$/.test(id)) {
        throw new TypeError(`unix-user id must be a decimal uid string, got: ${JSON.stringify(id)}`);
      }
      // Reject leading zeros except for `'0'` itself (root). `'01'` would
      // round-trip differently after Number()->String(), breaking key stability.
      if (id.length > 1 && id.startsWith('0')) {
        throw new TypeError(`unix-user id has leading zero: ${JSON.stringify(id)}`);
      }
      normalised = id;
      break;
    }
    case 'win-sid': {
      // Canonical SID syntax: `S-R-IA-SA[-SA]*` — see Microsoft SID string
      // format. We require `S-`, a numeric revision, a numeric identifier
      // authority, and at least one sub-authority. Case-insensitive match,
      // upper-cased on store.
      if (!/^S-\d+-\d+(-\d+)+$/i.test(id)) {
        throw new TypeError(`win-sid id must match S-R-IA-SA[-SA]*, got: ${JSON.stringify(id)}`);
      }
      normalised = id.toUpperCase();
      break;
    }
    case 'test': {
      // Reject whitespace and ASCII control chars so the id round-trips
      // cleanly through structured logs / DB columns. `:` is intentionally
      // allowed — `principalKey` uses a kind enum prefix, so a colon inside
      // the id never confuses (kind, id) recovery if a parser ever needs it.
      if (!isPrintableNoSpace(id)) {
        throw new TypeError(`test principal id must not contain whitespace/control chars: ${JSON.stringify(id)}`);
      }
      normalised = id;
      break;
    }
    default: {
      // Exhaustiveness guard — adding a new PrincipalKind without updating
      // this switch is a type error.
      const _exhaustive: never = kind;
      throw new TypeError(`unknown principal kind: ${String(_exhaustive)}`);
    }
  }
  return Object.freeze({ kind, id: normalised });
}

/**
 * Returns true iff `s` contains no whitespace and no ASCII control chars
 * (code points 0x00–0x1f and 0x7f). Implemented via `charCodeAt` instead
 * of a control-char regex to avoid the `no-control-regex` ESLint rule
 * (which exists for good reason — control chars in regex literals are
 * easy to miss in code review).
 */
function isPrintableNoSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return false;
  }
  return true;
}

/**
 * Stable string representation of a Principal — used as DB column value
 * (`sessions.owner_principal_key`) and as the comparison key in
 * `assertOwnership`. Format per ch05 §2:
 *
 *     `${kind}:${id}`
 *
 * Examples:
 *   - `unix-user:1000`
 *   - `win-sid:S-1-5-21-1234567890-1234567890-1234567890-1001`
 *   - `test:harness-alice`
 *
 * Locked format — DB rows are persisted with this exact string, so changing
 * it would require a migration.
 */
export function principalKey(p: Principal): string {
  return `${p.kind}:${p.id}`;
}

/**
 * Assert that `caller` matches `sessionOwner`. Throws `PermissionDenied`
 * on mismatch. Pure: no logging, no metrics — the interceptor wraps the
 * throw with structured-log emission.
 *
 * Comparison rules per ch05 §3:
 *   - `kind` MUST match exactly. A `unix-user` caller can NEVER act on a
 *     `win-sid`-owned session even if the ids happen to look similar
 *     (cross-platform daemon state import is forbidden in v0.3 — ch07 §2).
 *   - `id` MUST match exactly after the per-kind normalisation applied by
 *     `makePrincipal`. SID comparison is therefore case-insensitive at
 *     construction time but case-sensitive here — by design, callers must
 *     funnel raw OS data through `makePrincipal` before assertOwnership.
 *
 * Returns `void` on success. Inputs are NOT mutated.
 */
export function assertOwnership(caller: Principal, sessionOwner: Principal): void {
  if (caller.kind !== sessionOwner.kind || caller.id !== sessionOwner.id) {
    throw new PermissionDenied(
      `principal mismatch: caller kind=${caller.kind} does not own resource (owner kind=${sessionOwner.kind})`,
      { callerKind: caller.kind, ownerKind: sessionOwner.kind },
    );
  }
}
