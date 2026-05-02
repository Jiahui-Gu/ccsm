# 13 — Release Slicing — R4 (Testability + Ship-Gate Coverage)

## P1 — Phase 0 acceptance "< 10 min on a clean cache; > 0% in cached re-run"

§2 phase 0: "`pnpm install && pnpm run build && pnpm run lint && pnpm run test` runs in CI in < 10 min on a clean cache; > 0% in cached re-run."

"> 0%" is meaningless (any cache hit > 0%); presumably means "non-zero cache hit, demonstrating Turborepo caching works." Pin a concrete number (e.g., "≥ 80% of tasks served from cache on a no-op re-run"). Without it, a misconfigured turbo.json that caches nothing passes the gate.

## P1 — Phase 5 acceptance criterion lists 3 integration tests but ship-gate (c) is not listed; phase 11 binds them

§2 phase 5 done-criterion: "`pty-attach-stream` + `pty-reattach` + `pty-too-far-behind` integration tests green." Phase 11 binds ship-gate (c) — but per chapter 12, gate (c) is the 1-hour soak. The phase 5 → phase 11(c) gap is enormous: phase 5 can complete with all 3 listed tests green and the soak undiscovered. Pin: phase 5 must also include "10-minute soak smoke" as a faster proxy that catches gross regressions; full 1-hour soak runs in phase 11(c).

## P1 — Phase 11 acceptance "all four green on the candidate release tag" — no procedure spec'd

§2 phase 11 + §5 M4: "ship-gate (a)+(b)+(c)+(d) all green on the same commit. Tag candidate."

But (c) is non-blocking-PR (chapter 12 §4.3) → only runs nightly. (d) only runs on schedule or `[installer]` commit. So "all green on the same commit" requires manually triggering both gates against the candidate. Procedure missing. Pin: a `tools/release-candidate.sh` that takes a SHA, dispatches workflow runs for soak + installer, waits, reports.

## P1 — Phase 12 acceptance "≥ 7 days of dogfood with no architectural regression PRs"

Subjective and unmeasurable. Define: "no PR labeled `architecture-regression` lands in the 7-day window; no PR modifies any of the v0.3 'forever-stable' chapters per chapter 15 §3 forbidden-patterns list." Pin the labels + the auto-check.

## P1 — Dependency DAG §3 has phase 8 (Electron migration) "cannot merge until phases 4-7 are merged on the daemon side" — but phase 8 is one PR, so its CI must depend on real daemon binaries built from phases 4-7 merged main

In practice this means phase 8's PR must rebase onto a main that contains 4-7. If 4-7 land in parallel, phase 8 rebases multiple times. Spec doesn't say. Pin merge ordering: 4 → 5 → 6 → 7 (sequential within the daemon side because each builds on the previous); 8 stacks last. Or: 4-7 land in parallel as long as they don't conflict; 8 lands when all four are in main.

## P2 — Trunk-based with "< 600 LOC diff target" except phase 8

Phase 8 is the IPC cutover, by chapter 08 §1 ~entire renderer ported. 600 LOC × 13 IPC channels × refactoring overhead = several thousand LOC easily. Spec accepts this. Reviewers should plan for a long PR review window; add to acceptance criteria "phase 8 PR has at least 2 reviewers + sign-off from author."

## Summary

P0: 0 / P1: 5 / P2: 1
Most-severe: **Phase 11 "all four ship-gates green on the same commit" has no defined procedure given that gates (c) and (d) are nightly-only — release tagging is implicit and prone to "tag, hope, untag" loops.**
