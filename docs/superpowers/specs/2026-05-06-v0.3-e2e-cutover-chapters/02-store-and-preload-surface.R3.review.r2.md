# Review of chapter 02: Store and preload surface (round 2)

Reviewer: R3 (reliability / observability)
Round: r2

## Round-1 closures

- **P0-1 (loadState failure path undefined)** — CLOSED by CF-5.
  `02-store-and-preload-surface.md` §3 now contains a "MUST (failure
  path)" subsection enumerating exactly the three rejection modes from
  the round-1 finding (HTTP 5xx, `fetch` reject, JSON parse error),
  pins them as equivalent to missing-key (`null` resolve), mandates
  the one-shot toast via the zustand error slice, AND tags
  `__ccsmHydrationTrace.loadStateError` with one of `"http_5xx" |
  "fetch_reject" | "parse_error"` for probe dump. The "MUST (UT)"
  block adds `tests/stores/persist.test.ts` (NEW) covering all three
  rejection cases asserting (i) resolve=null, (ii) one toast emitted,
  (iii) no throw out of `persist.ts`. Reliability invariant is now
  binding at UT tier.
- **P1-1 (theme === 'system' ∧ osPrefersDark === undefined tiebreak)** —
  CLOSED via manager-pinned tiebreak in §4 I-3a. The invariant now
  hard-pins `light` as the fallback, with v0.2 baseline citation
  (`35b08d15:src/stores/slices/appearanceSlice.ts:resolveEffectiveTheme`
  short-circuits boolean → false → light). v0.3 also forbids
  introducing the three-state `osPrefersDark === undefined` branch.
  R3 reliability concern (deterministic default under degraded input)
  is satisfied; R1 baseline preservation is also satisfied via the
  cite.
- **P1-2 (no observability hook on hydration sequence)** — CLOSED by
  CF-5. §4 carries the extended `__ccsmHydrationTrace` shape table
  with `renderedAt / loadStateStartedAt / loadStateResolvedAt /
  loadStateError / setStateStartedAt / setStateCompletedAt /
  hydrateDoneAt`, and ch04 §2 `waitForTerminalReady` timeout dump now
  also writes `tmp/e2e-logs/<run-id>/<case>.hydration-trace.json`
  with the full object so an on-call can bisect WHICH async step
  stalled. End-to-end observability loop closed.

## Findings

No new P0/P1 from R3 in round 2.

Round-1 P2-1 (preload bridge `rpcGet/rpcPost` retry semantics) was a
P2 in round 1 and is not re-raised; the §3 contract is silent on
retry which is acceptable for v0.3 (callers do not retry; the failure
path resolves `null` + toast). A v0.4 wrapper is the right home if
needed.

### Note (not a P0/P1)

The mermaid sequence diagram in §4 was not updated to render the new
trace pin points (`loadStateStartedAt / loadStateResolvedAt /
setStateStartedAt / setStateCompletedAt`). The text contract in the
trace table is the authoritative source and the diagram is an
illustration; this is prose-only, no reliability impact, no fixer
action required.

## Cross-file findings

None. The CF-5 closure already coordinated ch02 §3/§4 with ch04 §2
trace-dump consumption; both sides are consistent.
