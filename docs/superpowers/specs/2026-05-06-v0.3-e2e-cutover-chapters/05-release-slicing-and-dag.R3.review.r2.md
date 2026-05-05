# Review of chapter 05: Release slicing and DAG (round 2)

Reviewer: R3 (reliability / observability)
Round: r2

## Round-1 closures

- **P1-1 (PR-3 has no rollback plan for spawn failure)** — CLOSED by
  CF-2. `05-release-slicing-and-dag.md` PR-3 Acceptance now carries:
  (a) UT block requiring all four `daemon-spawner.test.ts` cases
  including `code: 'startup_timeout'` for the 10s hard upper bound;
  (b) cold-launch budget block requiring a measured p50/p95 table
  vs `35b08d15` for Win / macOS / Linux with the deterministic
  500ms threshold and automatic Option B fallback.
  §7 Risk-1 was rewritten with the same enforcement point — "Any
  platform showing >500ms p95 regression automatically triggers
  fallback to Option B" — explicitly NOT a manager deliberation.
  The spawn-failure rollback path (catch + 1 retry + native dialog +
  non-zero exit) is in ch03 §3 "Spawn failure path"; the PR-3
  acceptance demands it via UT. Loop closed.
- **P1-2 (G8 has no daemon-side observability gate)** — CLOSED by CF-6.
  §1 added G11 "Daemon stderr capture across a full Set A run shows
  ZERO `error`-level records" with the exact grep tooling
  (`grep -cE '\] [0-9T:.\-]+Z error ' tmp/e2e-logs/<run-id>/*.electron.log`
  MUST return 0). The gate is mechanical, anchored on the structured
  prefix (so unstructured noise containing the word "error" does not
  false-positive), and explicitly blocks merge regardless of test
  colour. Reliability/observability loop closed.

## Findings

No new P0/P1 from R3 in round 2.

Round-1 P2-1 (PR ordering does not wave the reliability/observability
work explicitly) was CLOSED by §5 "R3 cross-cut note (CF-6 reliability
hardening)" paragraph naming PR-3 (failure path, port counter), PR-6
(SSE dedup contract), PR-8 (probe timeout dumps) as cross-cuts riding
existing wave slots, and explicitly fencing the deferred sigkill TTL /
cap / 4 boundary UTs to v0.4 (cross-link ch03 §7). The dispatch order
itself is unchanged. Not re-raised as P2 either.

### Notes (not P0/P1)

- G10 was rewritten to keep only the v0.2 baseline assertion
  (`attach-replay-from-headless-buffer` Set A green) per CF-3
  manager round-1 decision; the NEW `sigkill-reattach` case stays
  Set B informational. This is the correct R1+R3 outcome — R3 does
  not re-litigate sigkill TTL / cap / cwd reliability semantics for
  v0.3, they live in v0.4 (F-1..F-6 in ch03 §7). The chapter is
  internally consistent.
- PR-6 acceptance correctly splits (a) v0.2 baseline restoration
  (Set A `attach-replay-from-headless-buffer` green) from (b) NEW
  sigkill-reattach harness case as Set B informational with explicit
  "MUST NOT block PR-6 merge or v0.3 release" wording. CF-3 manager
  decision is faithfully encoded.
- The two-consecutive-runs language in G5/G6/G7 is now bound to
  "same CI workflow invocation" (not two separate PR triggers), which
  prevents accidental gate dilution. Reliability gate is well-defined.

## Cross-file findings

None. R3 round-1 cross-cuts (PR-3 spawn failure path → ch03 §3;
G11 stderr-clean gate → ch03 §6 + ch04 §2) all closed.
