# Review of chapter 01: Cutover audit (round 2)

Reviewer: R3 (reliability / observability)
Round: r2

## Round-1 closures

- **P1-1 (HP-12 leaked-daemon detection mechanism)** — CLOSED by F-01.
  HP-12 verdict line in `01-cutover-audit.md` now carries the forward
  reference: "If/when leak detected: ch04 §2 reset-between-cases hook
  is the planned mechanism (deferred to v0.4 unless v0.3 incident
  triggers promotion)." This satisfies the round-1 P1 ask (HP-12
  escape clause is no longer un-actionable) while honouring the
  manager defer (per `feedback_spec_pipeline_review_strictness.md`
  R3 "保必需" gradient — promotion only on incident, full PID-liveness
  detector lands in v0.4).
- **P1-2 (HP-3 cold-launch budget table missing)** — CLOSED by CF-2.
  HP-3 gained "Open Q5 (blocks PR-3 dispatch)" pinning a measured
  p50/p95 cold-spawn table on Win / macOS / Linux against the
  `35b08d15` baseline, with the 500ms regression threshold and
  automatic Option B fallback. PR-3 cannot dispatch with the table
  empty. The cold-launch budget chain is now consistent across
  ch01 HP-3 → ch03 §3 "Cold-spawn budget (measured)" → ch05 PR-3
  Acceptance + Risk-1.

## Findings

No new P0/P1 from R3 in round 2.

Round-1 P2-1 ("hydration-ordering thread" omits `loadState` HTTP
rejection failure-mode) was effectively absorbed by CF-5 (ch02 §3
landed the failure-path: HTTP 5xx / fetch reject / parse error all
resolve `null` + toast + trace-tag). The HP entry in ch01 itself does
not need a rewrite — the thread now correctly closes through ch02 §3
without further audit-level wording in ch01.

## Cross-file findings

None. The two cross-cuts from round 1 — HP-12 leak detection (ch01 +
ch04 §2) and cold-launch budget (ch01 HP-3 + ch03 §3 + ch05 PR-3 / §7
Risk-1) — are both fully closed across their respective chapters.
