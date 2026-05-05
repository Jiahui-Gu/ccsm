# Review of chapter 04: Probe and harness update (round 2)

Reviewer: R4 (Scalability / performance)
Round: 2

## Round-1 closures

- **P2-2 (`daemon-port-ready-before-render` no perf assertion)** —
  **CLOSED** by CF-7. ch04 §4 budget table now pins the case at
  **first RPC ≤500ms wall-clock + `__ccsmDaemonPortLoadIterations === 0`**;
  case budget ≤5s. Two-pronged assertion catches both the
  Option-A regression (poll succeeds at iteration N>0) and pure latency
  drift. Directly ties to ch03 §3 Option C contract.
- **P2-3 (`reset-between-cases` budget)** — Partially addressed: CF-7
  added the runtime invariant `beforeRef === afterRef` (R5 P1) which
  catches reset-skipped regressions. The ≤200ms time budget per case
  was NOT explicitly added; remains backlog.
- **P2-1 (Set A wall-clock budget for full suite)** — Per-case budgets
  added in §4 budget table per CF-7; SUITE-level wall-clock budget
  (≤8 minutes, >50% regression triggers review) NOT added. Remains
  backlog.

## Findings

No NEW P0/P1/P2 from R4 (all round-1 R4 findings were P2; none
re-escalate per the strictness gradient).

The two unaddressed P2s (suite wall-clock + reset budget) are pure CI
cycle-time concerns. Per `feedback_spec_pipeline_review_strictness.md`,
R4 ship-gate-mechanical findings are mandatory but P2 perf hardening is
v0.4 backlog. CI-hour cost is real but does not block v0.3 green.

## Cross-file findings

None.

## Verdict (R4 angle, ch04)

CLEAN — the only R4 finding that mattered for v0.3 (P2-2,
`daemon-port-ready-before-render` perf assertion) is closed. Remaining
P2s are tracked-but-not-blocking.
