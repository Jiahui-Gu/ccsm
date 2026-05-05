# Review of chapter 02: Store and preload surface

Reviewer: R2 (security)
Round: 2

## Findings

No new P0/P1 from R2 security in round 2.

Round-1 closures:
- CF-8 loopback bind invariant footer landed at §1 lines ~50-56 (cross-refs ch03 §3 + ch05 §1 G9). Confirmed.

Round-1 P2 carryover (still P2, manager-pinned defer):
- P2-1 `loadState/saveState` key validation (length cap + charset allow-list) — defer.
- P2-2 `__ccsm*` e2e-debug symbols exposed in production builds — defer (pre-existing v0.2; ch02 §6 already targets v0.4 hardening).
- P2-3 persisted-JSON parse path size/depth cap — defer.

No regressions: §3 "Required preload-bridge shape" + §3 "MUST (failure path)" + §3 "MUST (UT)" round-2 additions (CF-5 failure-path + F-02 v0.2 baseline-cite guards) do not widen the surface or alter the trust model — they tighten the missing-key / 5xx / fetch-reject branches to `null + toast` which is strictly safer than throwing into the renderer error path.
