# Review of chapter 01: Cutover audit (round 2)

Reviewer: R4 (Scalability / performance)
Round: 2

## Round-1 closures

- **P1-1 (cold-launch budget has no measured number)** — **CLOSED** by
  CF-2. ch01 §HP-3 now narrates the ≤500ms p95 budget vs `35b08d15`,
  and PR-3 acceptance (ch05 §3) carries the measured Win/macOS/Linux
  table requirement. Cross-chapter consistency holds (ch01 / ch03 §3
  "Cold-spawn budget (measured)" / ch05 §7 Risk-1).
- **P2-1 (HP-10 perf side-effect note)** — Not addressed; remains P2.
  Restated below as P2-1 r2 only because it costs one line.

## Findings

### P2-1 r2 (nice-to-have): Resource cap inventory (round-1 P1-2) — DOWNGRADE to P2 with v0.4 forward-ref [REGRESSION → DOWNGRADE]

**Where**: chapter 01, "Hot-path inventory" (HP-1..HP-13).

**Round-1 status**: P1-2 asked for a §"Resource caps (single-user v0.3
baseline)" enumerating per-pty FD count, ≤10 concurrent ptys, ≤20 SSE
EventSources, per-sid buffer ≤1 MiB, daemon RSS ≤200 MiB.

**Round-2 reassessment**: per `feedback_spec_pipeline_review_strictness.md`
("R4 ship-gate 可机械验证 必修全部" but "R3 reliability 真实致死路径 保;
理论性堆叠 → v0.4 follow-up"), this finding is **not ship-gate
mechanical** — it documents nominal-load defaults rather than gating any
green/red signal. CF-3 round-1 manager decision already deferred sigkill
TTL/cap to v0.4 reliability spec, which is the natural home for the rest
of the cap inventory (per-sid buffer, RSS budget). Forcing it into v0.3
would inflate scope without unblocking any harness case.

**Why not P1 anymore**: v0.3 is single-user single-machine with ≤10
typical ptys; under that load every cap above is ballpark and not
measurable in CI. There is no harness lever that fails today because
caps are unwritten — symptom catalog S1-S9 do not reference resource
exhaustion. R4 round-1 acknowledged P1 was already on the boundary.

**Suggested fix**: ch01 add **one line** under HP-10 verdict (or a new
§"Resource caps — see v0.4 reliability spec") forward-referencing the
v0.4 reliability spec PR placeholder where the cap inventory will land
alongside CF-3 deferred items (sigkill TTL/cap, F-1..F-6 in ch03 §7).
Example: "Resource caps (per-pty FD, ≤10 concurrent ptys, per-sid SSE
EventSource ≤20, per-sid buffer ≤1 MiB, daemon RSS ≤200 MiB) are
nominal-load defaults; specification deferred to v0.4 reliability spec
alongside ch03 §7 F-1..F-6." That single forward-ref discharges the
finding without inflating v0.3.

### P2-2 r2 (nice-to-have): HP-10 probe-utils perf side-effect note (round-1 P2-1, unchanged) [REGRESSION]

**Where**: chapter 01, "Cross-cutting hypotheses" lines 250-260
(approximate; verify against current head).

**Round-1 status**: P2-1 — add one-line "perf side-effect: tighter
timeouts shave ~80s/red-run".

**Round-2 status**: still not addressed. Trivial one-line edit; manager
may bundle into a future ch01 polish pass or accept as v0.4 backlog
(per strictness gradient — pure CI cost, not ship-gate). No re-escalation.

## Cross-file findings

- P2-1 r2 (cap inventory v0.4 forward-ref) interacts with ch05 §7 / ch03
  §7 deferred lists; if accepted, the same forward-ref line should
  appear in ch05 §7 (close round-1 ch05 P2-2). One fixer, two one-line
  additions.

## Verdict (R4 angle, ch01)

CLEAN — round-1's only P1 (cold-launch budget) is closed by CF-2; the
remaining items are P2 and per the strictness gradient should not block
v0.3 ship.
