# Review of chapter 03: ptyHost wiring (round 2)

Reviewer: R4 (Scalability / performance)
Round: 2

## Round-1 closures

- **P1-1 (Option C cold-launch unmeasured)** — **CLOSED** by CF-2.
  ch03 §3 now has "Cold-spawn budget (measured)" subsection with
  baseline = `35b08d15`, ≤500ms p95 budget per platform, automatic
  Option B fallback trigger, and a per-platform p50/p95 table
  (`<TBD by PR-3>` placeholder). PR-3 acceptance enforces capture in
  PR body. Decision section explicitly conditional on the budget.
- **P1-3 (sigkill-reattach buffer cap unspecified)** — **CLOSED via
  defer**. Manager decision round-1 (R1 strict) deferred all sigkill
  TTL/cap/eviction semantics to v0.4 (see ch03 §4 + §7 F-1..F-6).
  Per the strictness gradient ("R3 reliability — 真实致死路径 保;
  其余 v0.4"), the cap finding rides the same defer. ch03 §4
  v0.3-scope explicitly restores ONLY v0.2 attach-replay; no new cap
  rule means no cap rule to specify in v0.3.

## Findings

### P1-1 r2 [REGRESSION]: SSE `pty:data` pipe latency / throughput target still unowned

**Where**: chapter 03, §2 "SSE event delivery" (G-1..G-5 are all
correctness; no latency/throughput line).

**Round-1 status**: P1-2 — add §2.x "Latency / throughput targets":
target p99 producer→paint ≤20ms, per-sid sustained ≥1 MiB/s, one Set B
probe driving `yes | head -c 1MB`.

**Round-2 status**: NOT addressed. CF-6 round-1 added G-5 (reconnect
dedup contract, `seq` numbering, 64 KiB renderer queue, four
boundary UTs) — all CORRECTNESS, none latency. The 64 KiB queue cap
is the only quantitative cap added; it bounds reconnect-window memory,
not steady-state throughput. There is still no per-event latency
budget, no sustained throughput target, and no Set B harness probe
asserting the pipe drains a 1 MiB burst.

**Why this remains P1 (not downgraded)**: per the strictness gradient,
R4 ship-gate-mechanical findings stay P1. SSE pty pipe IS a hot path
(highest event frequency in the app). Without a written target, the
exact symptom R4 round-1 warned about ("claude output feels laggy"
reported post-merge) has no contract to debug against — and there is
no green/red signal to mechanically defend "it's still fast enough."
G-5's 64 KiB queue cap further makes throughput-vs-cap a real concern:
a slow renderer or stalled SSE socket reaches the cap and surfaces
`daemon_unavailable`; with no upstream throughput target, we cannot
say what producer rate is "supposed to" exhaust 64 KiB.

**Why P1 not P0**: typical interactive `claude` output is well below
saturation; no current symptom blocks v0.3 today.

**Suggested fix (minimal — under 10 spec lines)**: chapter 03 §2 add
a §2.x "Latency / throughput targets (informational, Set B)":

- Target: producer→renderer-paint p99 latency ≤20ms on dev's primary
  box for ≤5 concurrent sessions of token-by-token output.
- Target: per-sid sustained drain ≥1 MiB/s (xterm consumer is the
  expected bottleneck, not the SSE pipe).
- Cross-link to G-5: under sustained back-pressure exceeding the 64 KiB
  renderer queue, `daemon_unavailable` MUST surface (already specified);
  the throughput target establishes when that signal indicates a real
  regression vs. an expected slow renderer.
- Set B harness probe `pty-sse-burst-drain` (NEW, informational): writes
  1 MiB via `yes | head -c 1048576`, asserts drain ≤1.5s end-to-end.
  Set B = informational, not blocking PR-6 merge.

The numbers can be ballpark; the writing matters. Set B classification
keeps v0.3 ship unblocked while pinning the contract.

**Alternative (acceptable defer)**: if manager prefers, defer the entire
§2.x to v0.4 reliability spec alongside CF-3 sigkill items. In that
case ch03 §7 deferred list MUST add "F-7: SSE pty pipe latency /
throughput targets + Set B drain probe". Forward-ref in §2 so the hole
is not silently dropped. **Either landing the §2.x or the F-7 forward-ref
satisfies this finding** — what's not acceptable is leaving §2 as it
stands with no acknowledgement of the missing target.

## Cross-file findings

P1-1 r2 (SSE latency target) is local to ch03; if landed as Set B probe,
ch04 §3 informational table needs a one-row entry, ch05 §4 Set B
regression-tracking section already references how Set B regressions are
escalated — both ride the same fixer. If deferred via F-7, ch05 §7 and
ch00 §7 deferred lists ride the same forward-ref.

## Verdict (R4 angle, ch03)

NEEDS_ROUND_3 conditional: round-1 P1-2 (SSE pipe target) is the only
remaining R4 P1 against ch03; resolution is a single ≤10-line edit OR a
single F-7 forward-ref. Either lands → CLEAN. Manager picks the path;
fixer executes once.
