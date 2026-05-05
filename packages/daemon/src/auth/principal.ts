// Principal — in-process discriminated union for the entity an RPC call is
// attributed to. Mirrors the proto `Principal` oneof from
// `packages/proto/src/ccsm/v1/common.proto` (forever-stable wire schema —
// spec ch04 §2). v0.3 ships exactly one variant (`local-user`); v0.4 adds
// `cf-access` as a NEW variant of the discriminated union — the existing
// `local-user` shape MUST NOT change.
//
// Spec refs:
//   - ch05 §1 Principal model (TypeScript shape).
//   - ch05 §2 v0.3 single-principal invariant.
//   - ch05 §3 derivation rules per transport (consumed by the per-OS
//     extractors under ./peer-info/).
//   - ch15 §3 #7 principalKey parser MUST first-colon-split (indexOf
//     based) so v0.4 keys whose `value` contains `:` (e.g.
//     `cf-access:auth0|abc:def`) round-trip cleanly. See `parsePrincipalKey`.
//
// SRP: this module is pure type declarations + a single `principalKey` pure
// function. No I/O, no transport awareness. The interceptor (./interceptor.ts)
// reads `PeerInfo` from the Connect contextValues and emits a `Principal`;
// downstream handlers only ever read `Principal` from the same contextValues
// surface — they do NOT see `PeerInfo`.

/**
 * The set of principal kinds the daemon recognises.
 *
 * v0.3 — only `local-user`.
 * v0.4 — adds `cf-access` (NEW oneof variant on the wire); plumbed through
 *        the same `Principal` discriminated union, no field renames.
 *
 * Forever-stable string literal: the discriminator value is the same string
 * used as the `kind:` prefix in `principalKey` (spec ch05 §1).
 */
export type Principal = {
  readonly kind: 'local-user';
  /**
   * OS-native identifier rendered as a string. Numeric uid on linux/mac,
   * full SID string on Windows (spec ch05 §2). Always non-empty when the
   * extractor succeeds; empty `uid` is treated as a derivation failure.
   */
  readonly uid: string;
  /**
   * OS-reported display name. Best-effort; empty string when lookup fails.
   * Advisory only — never used for authorization (spec ch05 §2).
   */
  readonly displayName: string;
};

/**
 * Canonical string used as the `owner_id` column value in SQLite. Format is
 * `<kind>:<identifier>` and is forever-stable: v0.3 rows for
 * `local-user:1000` (linux uid) or `local-user:S-1-5-21-...` (Windows SID)
 * remain valid forever (spec ch05 §1 + ch07 §3).
 *
 * Pure function: total over the closed `Principal` union; the `switch`
 * exhaustiveness check forces an update here when a new kind is added in
 * v0.4. The fallthrough `_exhaustive` cast is the standard
 * never-narrowing trick that makes the compiler reject an unhandled kind.
 */
export function principalKey(p: Principal): string {
  switch (p.kind) {
    case 'local-user':
      return `local-user:${p.uid}`;
    default: {
      const _exhaustive: never = p.kind;
      throw new Error(`unhandled principal kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Parse a `principalKey` string back into its `{ kind, value }` parts.
 *
 * Forbidden rule (spec ch15 §3 #7): the implementation MUST use
 * `key.indexOf(':')` and slice on the FIRST colon — `split(':')[0/1]` is
 * banned because v0.4 will introduce keys whose `value` legitimately
 * contains additional colons (e.g. `cf-access:auth0|abc:def`, where the
 * Cloudflare Access JWT `sub` claim embeds an Auth0 IdP-prefixed id).
 * Splitting on every colon would drop the suffix and break round-trip,
 * silently rewriting `owner_id` rows the next time a query rebuilds the
 * key. The first-colon-split rule is the wire-stable parse contract that
 * keeps every existing v0.3 row valid forever.
 *
 * Pure: no I/O, no allocations beyond the two `slice` substrings. Throws
 * synchronously on malformed input (no colon at all) — callers always have
 * a `principalKey` from `principalKey()` above or from a SQLite
 * `owner_id` column populated by the same function, so a missing colon
 * indicates corruption and SHOULD surface immediately rather than be
 * silently coerced. The returned `kind` is intentionally typed as
 * `string` (not the `Principal['kind']` literal union) because parsing
 * is the inverse of *string formatting*, not of validation: this function
 * is round-trip safe over any `${kind}:${value}` string and does NOT
 * promise `kind` is a recognised variant. Callers that need that check
 * should narrow afterwards.
 */
export function parsePrincipalKey(key: string): { kind: string; value: string } {
  const i = key.indexOf(':');
  if (i < 0) {
    throw new Error(`invalid principalKey: ${key} (missing ":")`);
  }
  return { kind: key.slice(0, i), value: key.slice(i + 1) };
}
