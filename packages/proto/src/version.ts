// PROTO_VERSION — single source of truth for the v1 minor wire version.
//
// Bumped IF AND ONLY IF a `.proto` file changes in a way that affects the
// wire (added field with semantic meaning a v0.3 daemon doesn't support,
// new RPC, deprecation that flips behavior, etc.). Pure additive changes
// that older daemons can ignore SHOULD still bump; the negotiation
// contract in chapter 04 §3 lets clients embed a `proto_min_version`
// floor independently.
//
// Drift check (`packages/proto/scripts/version-drift-check.mjs`, surfaced
// as `pnpm --filter @ccsm/proto run version-drift-check`) asserts:
//
//   PROTO_VERSION  >=  PROTO_VERSION at most-recent `v*` git tag
//
// Regression fails the PR. See spec ch11 §7 and ch04 §3 for the full
// negotiation contract.
//
// Forever-stable per chapter 04 §1: the constant lives in the @ccsm/proto
// public surface so daemon and clients (electron, future web/ios) read
// from one place.

export const PROTO_VERSION = 1;
