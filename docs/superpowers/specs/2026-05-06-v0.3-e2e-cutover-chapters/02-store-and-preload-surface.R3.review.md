# Review of chapter 02: Store and preload surface

Reviewer: R3 (reliability / observability)
Round: r1

## Findings

### P0-1 (BLOCKER): hydration-ordering invariants do not define `loadState` failure path

**Where**: chapter 02, §3 "`window.ccsm.loadState` (HP-2)" Required preload-bridge shape, and §4 "Hydration ordering" Invariants I-1/I-2/I-3.
**Issue**: §3 mandates `loadState` resolves `null` when the key is missing, but says nothing about HTTP 5xx, network-level fetch reject (daemon dead between window-create and first RPC — possible per chapter 03 §3 even after Option C, since main->renderer->daemon is multi-process), or JSON parse error inside `rpcGet`. The §4 sequence diagram assumes `<persisted JSON> | null` always succeeds. `src/stores/persist.ts:60-66` (cited but not quoted) likely has unspecified rejection-handling — reviewer cannot verify since persist.ts is not part of this chapter.
**Why this is P0**: under daemon crash mid-boot (which the spec explicitly does not auto-restart in v0.3 — chapter 03 §7), `loadState` will reject. If persist.ts re-throws, the entire React tree never finishes mount, the harness sees `__ccsmStore` set but no `hydrated:true`, and reports a confusing timeout. This is a known crash recovery path with no design — exactly the R3 bar.
**Suggested fix**: in chapter 02 §3 add: "MUST: `loadState` rejection (HTTP non-2xx, fetch error, JSON parse fail) is caught by `src/stores/persist.ts`, logged via the renderer console with prefix `[persist]`, and treated identically to `null` (continue with defaults, set `hydrated:true`). The renderer MUST surface a one-shot toast `Failed to load preferences; using defaults.` so the user is not silently deprived of their settings. UT in `tests/stores/persist.test.ts` covers all three rejection shapes."

### P1-1 (must-fix): I-3a underspecifies the `theme === 'system'` ∧ `osPrefersDark === undefined` resolution

**Where**: chapter 02, §4 Invariant I-3a (lines 207-211).
**Issue**: The invariant says the case "MUST resolve to either dark or theme-light — never neither" but does not say WHICH one when the OS preference is undefined. SSR-style hydration mismatch could result if a test runner stubs `matchMedia` to return undefined.
**Why this is P1**: a non-deterministic default produces flaky `theme-toggle` tests across CI runners. R3 reliability concern: deterministic defaults under degraded inputs.
**Suggested fix**: pin the tiebreaker explicitly: "When `theme === 'system'` and `osPrefersDark === undefined`, MUST default to `light` (not `dark`). Why: matches the renderer's `:root` CSS default; mismatch would cause first-paint flash."

### P1-2 (must-fix): no observability hook on the hydration sequence

**Where**: chapter 02, §4 sequence diagram (lines 169-195).
**Issue**: HP-6 hydration trace pins `renderedAt`/`hydrateDoneAt`, but the diagram has 4+ async steps between them (`loadState → daemon → response → setState`). When this stage fails or hangs, the only signal is "hydrateDoneAt never set". A debugger has no way to bisect WHICH step hung. Consider a debug case where `loadState` returns valid JSON but `setState` throws inside a slice reducer.
**Why this is P1**: chapter 04 §2's "DOM dump on timeout" is the only debug aid currently in the spec. For hydration races this is insufficient — the DOM is empty either way.
**Suggested fix**: extend the hydration trace shape: `window.__ccsmHydrationTrace = { renderedAt, loadStateStartedAt?, loadStateResolvedAt?, setStateStartedAt?, hydrateDoneAt?, error?: string }`. Each phase pins its timestamp on entry. Probe-utils (chapter 04) prints the full trace on timeout.

### P2-1 (nice-to-have): preload bridge `rpcGet` / `rpcPost` retry semantics are not declared

**Where**: chapter 02, §3 "Required preload-bridge shape" code block (lines 118-129).
**Issue**: The bridge wraps a fetch; under daemon transient hiccup, should it retry? The spec is silent. Chapter 03 §3 talks about a 30s outer watchdog for `getDaemonPort` but not for arbitrary bridge RPCs.
**Why this is P2**: per current scope, daemon stays up; transient HTTP errors are rare. Worth a one-liner for v0.3 to lock the contract though.
**Suggested fix**: add §3 NOTE: "RPC helpers `rpcGet/rpcPost` MUST NOT retry. Caller (`persist.ts`, etc.) decides retry policy. v0.3 callers do not retry; v0.4 may add a wrapper."

## Cross-file findings

- P0-1 touches chapter 02 §3 (contract), `src/stores/persist.ts` (impl, not in chapter), and chapter 04 (toast verification could be a tiny new harness assertion). Single fixer should own all three.
- P1-2 trace shape extension also lands a probe-utils edit in chapter 04 §2. Coordinate.
