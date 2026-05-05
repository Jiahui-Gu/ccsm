# Review of chapter 00: Overview (round 2)

Reviewer: R3 (reliability / observability)
Round: r2

## Round-1 closures

- **P1-1 (daemon spawn / crash failure-mode policy)** — CLOSED by F-00.
  `00-overview.md` §3.7 "Daemon liveness contract" now pins:
  (a) `spawnDaemon` rejection on boot → electron hard-exit + structured
  stderr per ch03 §6;
  (b) mid-session daemon exit → renderer toast via zustand error slice
  + RPC surfaces disabled until user restart;
  (c) auto-restart explicitly deferred to v0.4 (cross-link ch03 §7).
  The cross-link from ch03 §3 spawn-failure path (CF-2) and ch00 §3.7
  is present and consistent.
- **P1-2 (observability format / stderr capture acceptance)** — CLOSED by
  F-00 + CF-6. `00-overview.md` §6 bullet 6 names the structured
  `[ccsmd] <ISO-8601> <level> <category>: ...` format (cross-link ch03
  §6) and the harness-runner per-case capture requirement (cross-link
  ch04 §2 + ch05 §1 G11 / Risk-1). Acceptance is no longer "tests
  green" only; daemon-side observability is part of the bar.

## Findings

No new P0/P1 from R3 in round 2.

Round-1 P2-1 (post-repair narrative inconsistency in §1 about
fire-and-forget `spawnDaemon`) was a nice-to-have prose nit and is not
re-raised; the iron rule §3.7 + §6 bullet 6 sufficiently bind the
post-repair contract that a confused future reader will follow the
cross-links to ch03.

## Cross-file findings

None. R3 ch00 surface is fully bound to ch03 §6 (stderr) + ch04 §2
(capture) + ch05 §1 G11 (gate). No further chapter coordination needed
on the reliability axis for ch00.
