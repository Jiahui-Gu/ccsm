# 05 — Session and Principal — R4 (Testability + Ship-Gate Coverage)

## P1 — Per-RPC enforcement matrix (§5) has no test asserting "every session-touching handler runs assertOwnership"

§4: "Every session-touching handler runs an `assertOwnership(ctx.principal, session)` check before reading or writing session-scoped state."

This is a security invariant — adding a new RPC that forgets to call `assertOwnership` is a permission-bypass bug. Chapter 12 §3 has `peer-cred-rejection.spec.ts` which tests middleware. There is no per-RPC test asserting "handler X with caller-not-owner returns PERMISSION_DENIED."

Pin: `auth-matrix.spec.ts` driven by a list of (rpc, requires_ownership) pairs (as in §5's table); for each ownership-required RPC, test that a non-owning principal gets PERMISSION_DENIED. Also a meta-test: enumerate all RPC handlers via the proto descriptor and assert every session-id-taking handler appears in the allow-list — catches accidentally-added handlers.

## P1 — Restoring sessions trusts recorded `owner_id` (§7) without integrity check

§7: "The principal is **not** re-derived on daemon restart — the recorded `owner_id` in the row is authoritative."

If `sessions.owner_id` is corrupted (disk bit-flip, user editing the DB), daemon trusts it. Acceptable for v0.3 (single-user machine), but: no test asserts the restore path actually re-spawns claude with the recorded args; no test for "session row with unknown owner_id format." Add `daemon-restart-restore.spec.ts` covering happy path + malformed owner_id (should daemon refuse to restore? log + skip? mark CRASHED?).

## P1 — `principalKey` format string `"local-user:1000"` vs `"local-user:S-1-5-21-..."` is not tested for round-trip safety

`principalKey` is forever-stable. The `:` separator could collide if a future kind's identifier contains `:` (e.g., `"cf-access:sub:with:colons"`). Spec doesn't say identifiers are colon-free. Pin: identifier values MUST not contain `:`; daemon validates on derivation; reject otherwise. Add unit test in `principal.spec.ts` asserting rejection.

## P2 — Crash log + Settings being "open to any local-user principal in v0.3" (§5) — no test that v0.3 doesn't accidentally enforce

A test for "non-owner caller can read CrashService.GetCrashLog and SettingsService.GetSettings" pins the v0.3 promise (relevant when v0.4 adds owner_id and someone might forget the v0.3 rows are global). Add to `auth-matrix.spec.ts`.

## Summary

P0: 0 / P1: 3 / P2: 1
Most-severe: **The "every session-touching handler runs assertOwnership" invariant is enforced only by code review; no test catches a forgotten call in a future PR.**
