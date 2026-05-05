# Review of chapter 04: Probe and harness update

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P2-1 (nice-to-have): No CI wall-clock budget for the e2e harness suite

**Where**: chapter 04, §6 "Acceptance signal for chapter 04"
(lines 232-239) and §3 "Set A vs Set B".
**Issue**: the chapter tightens individual probe timeouts (seedStore
20s→8s, waitForTerminalReady 60s→15s, default-timeout work in §2)
but never states a target end-to-end wall-clock for the full Set A
harness run. Without a budget, one fixer can land a "correct but slow"
fix that doubles the green-run time and nobody notices until the CI
queue backs up. This is a real perf consequence of the v0.3 e2e
ironrule §3.1 (zero skip) — every case stays in the gate, so total
runtime matters.
**Why this is P2**: probably already short (Set A is a curated subset)
and timeout reductions help; not a correctness issue. Listed so future
fixers have a number to defend against.
**Suggested fix**: chapter 04 §6 add a final bullet: "full Set A
harness wall-clock on dev's primary box ≤ 8 minutes; CI reports the
number per run; >50% regression triggers a perf review".

### P2-2 (nice-to-have): `daemon-port-ready-before-render` new case has no perf assertion

**Where**: chapter 04, §4 "New harness cases required by spec"
(line 211).
**Issue**: the new case asserts "`window.ccsmPty` works on the very
first RPC (no 5s polling waste)". A correctness assertion. But it's
the perfect place to also assert a TIME bound (e.g. "first
`window.ccsmPty.checkClaudeAvailable()` resolves in ≤Xms after
window load") to lock in the Option C cold-launch contract from
chapter 03 §3. Without this, the very mechanism designed to remove
the 5s wait is not regression-tested.
**Why this is P2**: the case exists and proves correctness; adding a
time bound is hardening, not strictly required. But it's the cheapest
guard against future "fire-and-forget spawn re-introduced" regression.
**Suggested fix**: rewrite the case description: "`window.ccsmPty`
first-RPC resolves in ≤500ms after window-load (asserts Option C
`await spawnDaemon` is in effect)". Document the 500ms tie to chapter
03 §3 budget (see this dir's `03-ptyhost-wiring.R4.review.md` P1-1).

### P2-3 (nice-to-have): `reset-between-cases` has no per-case teardown budget

**Where**: chapter 04, §2 "scripts/probe-helpers/reset-between-cases.mjs"
(lines 162-166).
**Issue**: the chapter requires verifying the store reset semantics
but doesn't state a budget for inter-case reset. If reset is slow
(e.g. waits on `loadState` round-trip), it amplifies across N cases
into significant CI time.
**Why this is P2**: not a correctness issue; CI cost only. Already
mitigated if reset is in-process zustand setState.
**Suggested fix**: §2 add a one-liner: "reset-between-cases MUST
complete in ≤200ms per case; if reset triggers HTTP calls, batch
them".

## Cross-file findings

None.
