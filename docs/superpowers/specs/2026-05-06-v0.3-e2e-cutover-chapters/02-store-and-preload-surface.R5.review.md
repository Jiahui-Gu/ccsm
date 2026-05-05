# Review of chapter 02: Store and preload surface

Reviewer: R5 (Testability)
Round: 1

## Findings

### P0-1 (BLOCKER): hydration-ordering invariants I-1/I-2/I-3 have no UT lever — only e2e

**Where**: chapter 02, §4 "Hydration ordering (HP-5, HP-6)", invariants I-1/I-2/I-3 (lines 199-216).
**Issue**: I-1 ("`window.__ccsmStore` MUST exist by the time React's first render commits"), I-2 (`renderedAt < hydrateDoneAt`), and I-3 (theme classes applied at least once before any test snapshot) are all observable invariants — but the only verification described is the harness case `startup-paints-before-hydrate` (mentioned in I-2). No unit-test lever exists for any of them, even though I-1 and I-3a are pure synchronous properties (I-1 = module-eval order; I-3a = `resolveEffectiveTheme` projecting `system+undefined` to one of `dark|light`).

Concretely, today at HEAD:

- `tests/app-effects/useThemeEffect.test.tsx` **already exists** (verified via `ls tests/app-effects/`) — chapter 02 §4 "the fixer MUST add a unit test in `tests/app-effects/useThemeEffect.test.tsx`" is misleading; it's an EXTEND, not an ADD. The existing file currently does NOT cover the 6 `{theme} × {osPrefersDark}` combinations that I-3a requires.
- `tests/stores/initialState.test.ts` **does not exist** (verified) — chapter 02 §5 correctly asks for a NEW file.
- No UT exists for I-1 (sync `__ccsmStore` pin). Chapter 02 §2 Fix-A code block is correct in shape but only describes production code, not its UT.

**Why this is P0**: I-1 and I-3a are the cheapest UT-tier guards in the entire spec — each is 1 file × ~10 lines × 100ms runtime. Leaving them e2e-only means the regression signal arrives 60-300s late and on CI only. This contradicts the spec's own §6 chapter-04 acceptance ("`seedStore` resolves within 5s on cold launch in CI") which is itself bottlenecked on something a UT can prove in milliseconds. v0.3 iron rule §3.1 (zero e2e skip) is forward-correct, but the *spirit* of zero-skip-discipline is "don't ship a fix without a regression test"; e2e-only as the *sole* regression test for a sync property is half-measure.

**Suggested fix**: add a §4 "Required UT levers" subsection listing, for each invariant:

| Invariant | Required UT file | Asserts |
|-----------|------------------|---------|
| I-1 | `tests/stores/store-eval-order.test.ts` (NEW) | After `await import('src/stores/store')`, `(globalThis as any).__ccsmStore === useStore` synchronously; assignment runs before any awaited callback. |
| I-2 | (no UT — pure timing; covered by harness `startup-paints-before-hydrate`) | — |
| I-3a | `tests/app-effects/useThemeEffect.test.tsx` (EXTEND existing file; chapter 02 §4 line 227 should change "add a unit test" → "extend the existing tests/app-effects/useThemeEffect.test.tsx") | All 6 of `{light, dark, system} × {osPrefersDark: true, false}` produce exactly one of `<html>.dark` / `<html>.theme-light`; never neither, never both. |
| I-3b | same UT as I-3a | When persisted hydrate sets a different `theme` value, `useThemeEffect` re-applies; when same value, `apply()` ran at least once on initial mount. |
| §5 initial-state coverage | `tests/stores/initialState.test.ts` (NEW per existing §5; keep) | every field used in App.tsx first paint exists. |

Update wording in §4 to fix the false "(new)" claim on `useThemeEffect.test.tsx`. Update wording in §2 Fix-A to reference the new I-1 UT.

### P1-1 (must-fix): "duplicate-store" Fix-B has no automated guard

**Where**: chapter 02, §2 Root cause B (lines 87-102), specifically the line "the fixer CHAPTER 02 implementer MUST `grep -RIn 'create<.*Store' src/` and assert exactly one zustand `create(...)` call for the app store."
**Issue**: a one-time grep at PR-2 land time is not a regression test. A future fixer in v0.4+ adding a second `create(...)` call (e.g., a new feature slice store) won't be caught — the original review would have to recur. R5 angle: "MUST grep" without a CI step is a P1 testability gap.
**Why this is P1**: the duplicate-store failure mode is the silent kind ("seeds go to instance A, reads come from instance B, no error, frozen UI"). Catching it once and never again is fragile.
**Suggested fix**: convert the grep to a Vitest test in `tests/stores/single-instance.test.ts` (NEW):

```ts
import * as glob from 'fast-glob';
import * as fs from 'node:fs';

it('exactly one zustand create<...>() call across src/stores/', () => {
  const files = glob.sync('src/stores/**/*.ts');
  const count = files.flatMap((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return src.match(/\bcreate\s*<[^>]*>\s*\(/g) ?? [];
  }).length;
  expect(count).toBe(1);
});
```

Or equivalent. CI catches the regression; review doesn't have to remember.

### P1-2 (must-fix): §3 daemon-side wiring UT scope is incomplete

**Where**: chapter 02, §3 "Daemon-side wiring" (lines 146-152).
**Issue**: §3 mandates UT in `daemon/api/__tests__/data.test.ts` covering `get(missing) → null`, `get(set value) → that value`, `set(empty key) → 400`. But:
1. `daemon/api/__tests__/` directory does not exist at HEAD (verified) — this is a NEW dir, not an EXTEND. Spec should say so explicitly.
2. The three cases listed do not cover the most-likely-to-regress shape: encoded keys (`encodeURIComponent` round-trip) and large values. Chapter 04 §4 proposes a new harness case `loadstate-roundtrip` for the wire-level round-trip; the daemon-side UT should at minimum cover unicode key (`'theme.zh-CN'`), key with `&` / `?` / `#` (URL-special), value > 100 KiB.
**Why this is P1**: missing the encoding cases is the exact regression that would manifest as "harness passes locally, fails on CI when locale flips" or "tray case fails for one user with a non-ASCII pref name". Cheap to UT.
**Suggested fix**: §3 sentence becomes "add UT in `daemon/api/__tests__/data.test.ts` (NEW directory + file) covering: `get(missing) → null`, `get(set value) → that value`, `set(empty key) → 400 bad_request`, `get/set` with key containing `&?#%` characters round-trips correctly, `set` with value > 100 KiB succeeds (or rejects with `value_too_large` per R2 P2-3 if accepted)."

### P1-3 (must-fix): mermaid hydration sequence assumes one `loadState` call but doesn't pin "one"

**Where**: chapter 02, §4 mermaid diagram (lines 169-195), specifically `React->>Preload: window.ccsm.loadState(STATE_KEY)` (singular).
**Issue**: the diagram and prose imply EXACTLY ONE `loadState` call on cold paint. Today (verified `src/stores/persist.ts:60-66` per HP-2 row) that's true (single key `STATE_KEY`). But the spec doesn't pin "one" as a MUST. R4 P2-1 already raised the latency budget angle; R5 raises the *testability* angle: nothing in the spec lets a fixer assert "no one added a second `loadState` call to the cold path" without manually re-reading the persist code.
**Why this is P1**: a UT can pin this in 5 lines.
**Suggested fix**: add to §4 invariants: "I-5: cold paint MUST issue exactly one `window.ccsm.loadState(STATE_KEY)` call. Verify in `tests/stores/persist.test.ts` (extend if exists, else NEW): mock `window.ccsm.loadState` as a spy, run the cold-paint hydration, assert spy.callCount === 1."

### P2-1 (nice-to-have): §5 initial-state UT field list is illustrative, not exhaustive

**Where**: chapter 02, §5 "Initial state safety", code block (lines 256-269).
**Issue**: the UT lists 6 fields with `// …` after. This invites a half-test where the fixer copy-pastes the 6 and forgets the others. R5: the test should be self-discovering — iterate over a known field allow-list, or compare initial state's keys against a snapshotted reference.
**Why this is P2**: works as-is; P2 because the snapshot-style test is strictly better but the listed test is non-zero coverage.
**Suggested fix**: rewrite UT to snapshot the initial state's top-level keys:

```ts
it('initial state shape is stable (snapshot)', () => {
  const keys = Object.keys(useStore.getState()).sort();
  expect(keys).toMatchInlineSnapshot();  // pinned set; CI fails if a field is dropped
});
```

Plus the explicit `expect(s.hydrated).toBe(false)` for the load-bearing flag.

## Cross-file findings

P0-1 (UT levers for I-1/I-3a) is in scope for chapter 02 only; chapter 01 R5 P1-1 (symptom→lever map) provides the upstream column.

P1-2 (`daemon/api/__tests__/data.test.ts` is NEW dir) cross-cuts chapter 05 PR-1 acceptance — chapter 05 should be updated to say "(new directory + file)" not just "(extend)". Same fixer.

P1-3 (one `loadState` call) cross-cuts chapter 04 §4 `loadstate-roundtrip` harness case — UT pins the "one" property; harness pins the round-trip wire shape. Both needed.
