# Review of chapter 01: Cutover audit

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P1-1 (must-fix): HP-3 cold-launch budget has no measured number

**Where**: chapter 01, §"HP-3 — daemon port readiness for preload bridges"
(lines 87-108), and the "Hypothesis" bullet that says "cold electron
launches under e2e take longer than 5s".
**Issue**: the audit narrates that 5s is too short and 30s is "generous"
(referenced via chapter 03 §3) but never records the actually-observed
cold-boot time on dev's primary box. Without a baseline number, the
fixer cannot tell whether Option C `await spawnDaemon` adds 200ms or
3000ms to first-paint, and post-merge regression detection has no
threshold to compare against.
**Why this is P1**: this is the single biggest perf decision in v0.3
(it gates window-show); shipping without a number means we have no
way to verify "regression vs. acceptable" later. Not P0 because the
number can be measured during PR-3 implementation rather than now.
**Suggested fix**: require chapter 03 §3 to land a one-liner
"measured cold-boot daemon-spawn latency on Windows dev box: <X>ms;
Option C budget allowance: ≤500ms first-paint regression". Add a
must-do step in PR-3's acceptance: capture the number in the PR body
before merge. Cross-ref `Risk-1` in chapter 05 §7 (which already
mentions 500ms but doesn't pin where the number gets captured).

### P1-2 (must-fix): No host resource cap inventory for multi-session use

**Where**: chapter 01, the entire "Hot-path inventory" (§§HP-1..HP-13).
**Issue**: the audit catalogs every functional regression but nowhere
defines the implicit resource caps the wave-2 daemon split affects:
per-pty FD count, per-session in-memory buffer, total daemon RSS budget,
SSE EventSource per-session count (one per sid → grows linearly with
open sessions). For a single-user single-machine v0.3, common usage
(≤10 sessions per CLAUDE.md "currentDate" window) should not blow up
loopback HTTP / SSE either, but neither chapter 01 nor 03 enumerates
what "doesn't blow up" means.
**Why this is P1**: without a stated upper bound, the fixer for HP-4
or HP-8 has no way to size the buffer-snapshot (HP-8) or to decide
whether per-sid `EventSource` is fine vs. needs multiplexing. Not P0
because typical dev usage of ≤10 sessions almost certainly works fine
on the wave-2 transport — but the spec should say so explicitly with
one number rather than leave it to assumption.
**Suggested fix**: add a §"Resource caps (single-user v0.3 baseline)"
to chapter 01 (or chapter 03 §1) that records: "≤10 concurrent ptys
expected; per-sid EventSource is acceptable below 20 sids; per-sid
buffer snapshot retention ≤ 1 MiB; total daemon RSS budget ≤ 200 MiB
under nominal load". Even if the numbers are ballpark, having them
written prevents silent drift.

### P2-1 (nice-to-have): HP-10 probe-utils refresh is "diagnostic layer last" — no perf number

**Where**: chapter 01, "Cross-cutting hypotheses" (lines 250-260).
**Issue**: the rationale "fix probe-utils LAST" is sound; however the
audit doesn't note that the current `seedStore` 20s timeout
(`scripts/probe-utils.mjs:362`) and `waitForTerminalReady` 60s timeout
together inflate every CI red signal by 80s of dead-wait time. Once
HP-1 / HP-3 land, dropping those would shave minutes off every red
harness run.
**Why this is P2**: not a correctness issue; just CI cycle-time waste.
Already partially addressed in chapter 04 §2 (drop to 8s / 15s).
Listing it in the audit row would make the win discoverable.
**Suggested fix**: add a one-line note under HP-10 audit verdict:
"perf side-effect: tighter timeouts shave ~80s/red-run".

## Cross-file findings

P1-1 spans chapter 01 (statement), chapter 03 §3 (decision), and
chapter 05 §7 Risk-1 (capture point) — manager should assign all
three to one fixer.

P1-2 belongs in chapter 01 (or chapter 03 §1 if manager prefers
co-location with the daemon contract). One fixer, one section.
