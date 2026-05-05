# Review of chapter 05: Release slicing & DAG (round 2)

Reviewer: R4 (Scalability / performance)
Round: 2

## Round-1 closures

- **P1-1 (Risk-1 cold-launch enforcement point)** — **CLOSED** by CF-2.
  PR-3 acceptance now MUST carry the measured Win/macOS/Linux p50/p95
  delta vs `35b08d15` in the PR body, and >500ms p95 on any platform
  **automatically** triggers Option B fallback (deterministic, NOT a
  manager judgement call). Risk-1 in §7 explicitly forwards to the
  PR-3 acceptance bullet and ch03 §3 "Cold-spawn budget (measured)".
  Cross-chapter consistency holds.
- **P2-1 (G5/G6/G7 wall-clock budget)** — Not addressed; remains
  backlog (rides ch04 §6 P2-1).
- **P2-2 (No DAG node owns "resource cap baseline" capture)** — Not
  addressed; relevant only if ch01 P1-2 (cap inventory) lands in v0.3.
  Per ch01 r2 review, P1-2 is downgraded to a v0.4 forward-ref → P2-2
  here also dissolves (no v0.3 PR slot needed when the work is v0.4).

## Findings

### P2-1 r2 (nice-to-have): Cap-inventory v0.4 forward-ref echo [REGRESSION → DOWNGRADE]

**Where**: chapter 05, §7 "Risks & open questions" / §6 "Out-of-scope".

**Issue**: if ch01 r2 review's recommendation lands (one-line
forward-ref to v0.4 reliability spec for resource caps), ch05 §6 or §7
should mirror that forward-ref so the deferred-list is discoverable
from the release-slicing chapter. Trivial parity edit.

**Why P2 (not P1)**: pure cross-link hygiene; no ship-gate dependency.

**Suggested fix**: add to ch05 §6 deferred list one bullet
"Resource cap inventory (per-pty FD, ≤10 ptys, ≤20 SSE, per-sid 1 MiB,
RSS ≤200 MiB) — v0.4 reliability spec, alongside ch03 §7 F-1..F-6 and
ch01 §HP-10".

### P2-2 r2 (nice-to-have): SSE pty pipe latency target — Set B PR slot or v0.4 forward-ref [REGRESSION]

**Where**: chapter 05, depending on resolution of ch03 r2 P1-1.

**Issue**: if ch03 §2 lands the proposed §2.x latency/throughput
targets + Set B `pty-sse-burst-drain` probe (preferred resolution per
ch03 r2), ch05 §3 PR-6 acceptance MUST add a one-line bullet "informational
Set B `pty-sse-burst-drain` runs and result reported (not a blocker)".
If ch03 §2 instead defers via F-7 forward-ref to v0.4 reliability spec,
ch05 §6 deferred list should mirror that forward-ref.

**Why P2 (here)**: ch05 echo of ch03's r2 P1; pure consistency.

**Suggested fix**: ride the ch03 r2 P1 fixer (single fixer touches
ch03 §2 + ch05 §3 PR-6 OR ch03 §7 + ch05 §6 — disjoint either way).

## Cross-file findings

P2-1 r2 ↔ ch01 r2 P2-1; P2-2 r2 ↔ ch03 r2 P1-1. Both ride single fixers
already named in those reviews; no NEW cross-file fixer needed.

## Verdict (R4 angle, ch05)

CLEAN — round-1 R4 P1 (Risk-1 enforcement) is closed by CF-2; remaining
items are P2 echoes of decisions made elsewhere.
