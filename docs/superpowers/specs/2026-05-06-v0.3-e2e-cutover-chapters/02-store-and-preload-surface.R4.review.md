# Review of chapter 02: Store and preload surface

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P2-1 (nice-to-have): `loadState` round-trip on first paint is on critical path; no latency budget

**Where**: chapter 02, §4 "Hydration ordering" mermaid diagram (lines
169-195), specifically the `Preload->>Daemon: GET /api/data/get?key=…`
arrow.
**Issue**: every cold paint now does one loopback HTTP round-trip
before the store hydrates and the theme effect can flip
`<html>.dark`. The diagram doesn't quote a budget. On a single-user
single-machine box loopback HTTP is sub-ms so this is almost certainly
fine, but I-2 (`renderedAt < hydrateDoneAt`) implicitly assumes the
gap is "not user-visible" without saying how big "not user-visible" is.
**Why this is P2**: loopback HTTP on localhost is typically <5ms; not
a real perf risk in v0.3 single-user. Listed only so a future fixer
adding more `loadState` keys (e.g. multi-key migration) doesn't fan
out per-key calls.
**Suggested fix**: one sentence in §4 invariants: "I-4: total
`loadState` time on cold paint MUST be ≤50ms on dev's primary box;
if multiple keys are loaded, batch into a single
`/api/data/get-many?keys=…` call rather than fan-out".

### P2-2 (nice-to-have): No guidance on `saveState` write coalescing

**Where**: chapter 02, §3 "`window.ccsm.loadState` (HP-2)", in the
required preload-bridge shape (`saveState` definition lines 122-125).
**Issue**: `saveState(key, value)` is one-write-one-RPC. Zustand persist
middleware historically debounces; if the new persist path calls
`saveState` on every store change without debouncing, a busy session
(rename, drag, theme toggle in succession) generates N HTTP POSTs to
the daemon for what used to be one debounced write. Chapter 02 §6
("Out-of-scope") doesn't address this either way.
**Why this is P2**: under typical interactive use the write rate is
low (a few per minute). Only matters if the persist layer was
restructured during wave-2 to drop debouncing — which the audit doesn't
flag.
**Suggested fix**: chapter 02 §3 add a one-liner "MUST: persist layer
debounces `saveState` calls (≥250ms window) — wave-2 cutover MUST NOT
have removed debouncing; verify in `src/stores/persist.ts`".

## Cross-file findings

None.
