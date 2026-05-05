# Review of chapter 02: Store and preload surface (round 2)

Reviewer: R4 (Scalability / performance)
Round: 2

## Round-1 closures
- (round-1 P2-1 / P2-2 against ch02 — neither was promoted to a fix
  round per the strictness gradient. Both remain open as P2 backlog.)

## Findings

No NEW P0/P1/P2 from R4.

Round-1 P2-1 (`loadState` round-trip ≤50ms budget on cold paint) and
P2-2 (`saveState` debounce ≥250ms guard) remain unaddressed. Both are
single-user low-rate loopback HTTP concerns; under v0.3 typical use
(few writes/min, ≤5 cold loads) neither saturates. The strictness
gradient (R4 ship-gate-mechanical = mandatory; theoretical perf
hardening = v0.4) places both in the v0.4 follow-up bucket.

CF-5 round-1 fix added a `loadState` failure-path (rejection → null +
toast) and extended `__ccsmHydrationTrace` with `loadStateStartedAt /
loadStateResolvedAt` — those R3 timings can DOUBLE as the regression
signal R4 P2-1 was asking for, without writing a hard ≤50ms gate. No
re-escalation needed: a future fixer can add a numeric assertion against
`loadStateResolvedAt - loadStateStartedAt` if the trace shows drift.

## Cross-file findings

None.

## Verdict (R4 angle, ch02)

CLEAN — no R4 P0/P1 ever existed against ch02; round-1 P2 items remain
P2 and are out of v0.3 scope per strictness gradient.
