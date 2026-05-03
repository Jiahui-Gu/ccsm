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
