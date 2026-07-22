# Test-suite cleanup: surgical consolidation (Phase 1 slice)

Status: Approved (delegated) · Author: Copilot (autopilot) · Date: 2026-07-21

## 1. Background

`C:\Users\jiahuigu\.copilot\session-state\ec18d03d-c2ab-4bca-bd8e-a13033bffa48\files\test-suite-audit.md`
(read-only audit, ~974s agent run) found the CCSM test suite is fundamentally
healthy — deterministic, well-partitioned by runtime, no pervasive
mock-tautology — but flagged a short list of concrete, low-risk cleanups:

1. **Appearance triplication**: the same setter/helper behavior is asserted
   in three files (`tests/appearance.test.ts`, `tests/store-appearance.test.ts`,
   `tests/stores/slices/appearanceSlice.test.ts`).
2. **Title-backfill overlap**: `tests/store-backfill-titles.test.ts` and
   `tests/stores/slices/sessionTitleBackfillSlice.test.ts` both exercise
   `_backfillTitles`, but nearly all of the bridge-driven behavior (patch,
   batch-by-projectKey, multi-project, error handling, empty/null summary,
   no-cwd skip, unknown-sid skip) lives ONLY in the root file today.
3. **Change-detector test**: `tests/lib-motion.test.ts` pins literal token
   values (exact seconds, exact bezier tuples) that mirror the source file
   with zero behavioral signal.
4. **Minor tautology**: `tests/components/Button.test.tsx`'s "renders
   children content" case tests React itself, not `Button`.
5. **Tracked scratch cruft**: `scratch/dogfood-ctrl-wheel-zoom.mjs` and
   `scratch/dogfood-reload-retry-repro.mjs` are git-tracked, unreferenced by
   any runner, eslint-ignored ad-hoc repro scripts.
6. **E2E doc/comment drift**: `docs/reference/e2e-runner.md` describes a
   `scripts/probe-e2e-*.mjs` per-file-probe tier (0 files exist today) and
   references `docs/e2e/single-harness-brainstorm.md` (does not exist,
   confirmed via repo-wide search). The same dead reference also appears in
   comments in `harness-ui.mjs`, `harness-dnd.mjs`,
   `probe-helpers/harness-runner.mjs`, `probe-helpers/reset-between-cases.mjs`.
7. No written testing-strategy reference exists documenting the four test
   tiers, mock policy, and deletion/coverage rules the audit recommends
   going forward.

This spec scopes a **single, low-risk PR** that fixes 1–7 above and nothing
more. It explicitly excludes the E2E→Playwright migration, the DB
corruption-recovery gap, IME un-skip, and any `git mv` of the remaining root
`store-*.test.ts` files — those are separate, higher-risk phases the audit
itself sequences later (§7 Phase 2/3/4 in the audit).

## 2. Goals / non-goals

**Goals**
- Delete duplicate test files only after every unique behavioral assertion
  has a proven home in the canonical file (parity demonstrated by running
  the canonical file green before deleting the duplicate).
- Never decrease the v8 coverage gate (lines 81 / functions 81 / branches 70
  / statements 79); baseline is measured before any edit (§3).
- Rewrite `lib-motion.test.ts` and trim `Button.test.tsx` to remove
  non-behavioral assertions while keeping every real contract.
- Remove dead files/doc references that are independently verifiable as
  unreferenced or nonexistent.
- Add a testing-strategy reference doc so the policy this PR follows is
  written down for future PRs.

**Non-goals (explicitly out of scope for this PR)**
- No E2E harness → `@playwright/test` migration.
- No behavior change to `scripts/run-all-e2e.mjs` (its dead
  `probe-e2e-*.mjs` discovery branch is harmless — it iterates a
  consistently-empty array — and removing it would be a runner behavior
  change requiring TDD investment per the delegation's guardrail; deferred).
- No `git mv` / directory migration of `store-cwd-redirect.test.ts`,
  `store-preferences.test.ts`, `store-pty-exit.test.ts`,
  `store-rename-session.test.ts` — investigated below (§4.3) and found to
  hold unique behavioral assertions not present in any `tests/stores/slices/*`
  file, so they do not qualify under "exact overlap only."
- No package version/tag/release/merge changes. No mobile UX changes.

## 3. Baseline (measured before any edit, npm test / build on this branch @ 0bba44a2)

| Metric | Value |
|---|---|
| Test files | 226 passed (226) |
| Tests | 2086 passed, 1 todo (2087 total) |
| Runtime (vitest run, combined renderer+electron projects) | ~111.5s (transform 34.75s / setup 186.15s / import 207.52s / tests 88.66s) |
| `npm run typecheck` | clean (renderer + `tsconfig.electron.json`) |
| `npm run lint` | clean, 0 warnings (`--max-warnings 0`) |
| `npm run build` | clean (tsc + webpack main/mobile) |
| Coverage — statements | 79.77% (6512/8163) |
| Coverage — branches | 72.31% (3382/4677) |
| Coverage — functions | 82.76% (1489/1799) |
| Coverage — lines | 81.96% (5762/7030) |
| `sessionTitleBackfillSlice.ts` coverage (pre-port) | 97.72% stmts / 87.5% branches / 100% fns / 100% lines (already high because `store-backfill-titles.test.ts` exercises the same slice code indirectly through the assembled store) |
| `appearanceSlice.ts` coverage (pre-port) | 71.21% stmts / 71.66% branches / 87.5% fns / 76% lines |

Note: the coverage gate (`lines 81 / functions 81 / branches 70 / statements
79`) is a floor in `vitest.config.ts`'s coverage thresholds — current numbers
already clear it. Any post-change run must clear the same floor and must not
regress vs. the baseline numbers above.

E2E status: not executed for this PR (no harness or runner behavior changes
are made; doc/comment-only edits carry no runtime risk). Confirmed via
`glob`/`grep`: `scripts/probe-e2e-*.mjs` → 0 matches; `docs/e2e/*` → 0
matches; 13 `scripts/harness-*.mjs` files present and untouched.

## 4. Detailed analysis & decisions

### 4.1 Appearance triplication → consolidate into `appearanceSlice.test.ts`

Diffed all three files line-by-line. `tests/store-appearance.test.ts`
(setter-only, via `useStore`) is a strict subset of
`tests/stores/slices/appearanceSlice.test.ts` (setter cases identical:
`setFontSizePx` sync, `setFontSize` sync, `setTheme`, `setSidebarWidth`
clamp, `resetSidebarWidth`) — **delete outright, no port needed.**

`tests/appearance.test.ts` (pure-helper tests) has 6 assertions NOT present
in `appearanceSlice.test.ts`:
1. `legacyFontSizeToPx(pxToLegacyFontSize(x))` round-trip at both endpoint
   stops (12, 16).
2. `sanitizeFontSizePx` accepting **every** official stop (12/13/14/15/16) —
   slice file only checks 12 and 15.
3. `sanitizeFontSizePx` coercing `null` and `NaN` to the default (14) — slice
   file only checks `99`, `'big'`, `undefined`.
4. `sanitizeSidebarWidth` falling back to default for `NaN` and `undefined`
   specifically (not just a garbage string) — distinct code path
   (`Number.isFinite` guard) from the clamp path already covered.
5. `resolvePersistedSidebarWidth` clamping an out-of-range **persisted px**
   value (50→MIN, 9999→MAX) — untested in the slice file (which only tests
   in-range px and legacy-pct migration).
6. `resolvePersistedSidebarWidth({})` returning the default when nothing is
   persisted — untested in the slice file.

**Action:** port these 6 cases into `appearanceSlice.test.ts`'s "appearance
helpers (pure)" `describe` block, run the file green, then delete
`tests/store-appearance.test.ts` and `tests/appearance.test.ts`.

### 4.2 Title-backfill overlap → consolidate into `sessionTitleBackfillSlice.test.ts`

`tests/stores/slices/sessionTitleBackfillSlice.test.ts` (7 cases) tests
`_applyExternalTitle` thoroughly (6 cases: patch, no-op unchanged, no-op
once non-default, zh default overwrite, pending-manual-rename guard, guard
round-trip) but `_backfillTitles` only in the **no-bridge** case.

`tests/store-backfill-titles.test.ts` (11 cases, via `useStore`) covers
`_backfillTitles` almost entirely: patch default name, patch zh default,
never-overwrite-renamed, batch-by-projectKey (1 IPC call for 3 sids sharing
a project), 1-IPC-per-unique-projectKey across projects, `listForProject`
rejection (silent warn, other projects still patched), no-bridge no-op
(overlaps), null/empty summary ignored, empty-cwd skip (no IPC call at all),
and summary-for-unknown-sid ignored.

Reading `src/stores/slices/sessionTitleBackfillSlice.ts` confirms
`_backfillTitles` depends only on `get().sessions` and
`get()._applyExternalTitle` — both present in the slice harness already
used by `sessionTitleBackfillSlice.test.ts` — so every one of these cases
ports cleanly onto the harness (`h.titles._backfillTitles()`,
`h.state().sessions`) without needing the full `useStore`.

**Action:** port all 10 unique `_backfillTitles` cases (everything except
the already-covered no-bridge case) into `sessionTitleBackfillSlice.test.ts`
using the existing harness + a local `installBridge`/`seed` helper mirrored
from the root file, run the file green, then delete
`tests/store-backfill-titles.test.ts`.

### 4.3 Other root `store-*.test.ts` files — inspected, NOT exact overlap, deferred

| File | Slice equivalent | Overlap verdict |
|---|---|---|
| `store-cwd-redirect.test.ts` (5 cases) | `sessionRuntimeSlice.test.ts` `_applyCwdRedirect` (1 case, 2 assertions: patch + reject-empty) | **Not exact.** Root file uniquely covers: no-op on missing row (no ghost append), no-op + reference-stable state when cwd unchanged, and multi-session isolation (only target session mutates). |
| `store-preferences.test.ts` (7 cases) | none — tests `src/store/preferences.ts`, a distinct module from the `stores/slices/*` domain | **Not exact — no replacement exists at all.** Sole coverage for `hydrateSystemLocale` + cross-checks with `setLanguage`. |
| `store-pty-exit.test.ts` (9 cases) | `sessionRuntimeSlice.test.ts` `_applyPtyExit`/`_clearPtyExit` (covered within the larger `reloadSession` describe block) | **Not exact.** Root file uniquely covers: string-signal classification (`SIGTERM`), numeric-signal classification (`15`), all-null-payload classification, `_clearPtyExit` drops only the named sid (multi-sid), and `_clearPtyExit` on an unknown sid is a reference-stable no-op. |
| `store-rename-session.test.ts` (5 cases) | `sessionCrudSlice.test.ts` (1 case: optimistic local update, no bridge) | **Not exact.** Root file uniquely covers the SDK-writeback three-way outcome contract (`ok` / `no_jsonl` enqueue / `sdk_threw` enqueue+console.error) and the optimistic-before-resolve timing case. |

Per the delegation's explicit guardrail — "change/delete them only when you
can demonstrate exact overlap and name the surviving replacement... No
broad directory migration in this first PR" — **none of these four
qualify.** They are left untouched. Recorded as a deferred recommendation
for a future PR that would `git mv` each into `tests/stores/slices/` and
merge only the genuinely-overlapping cases (e.g. the single reject-empty
assertion in `store-cwd-redirect.test.ts`), preserving every unique case
identified above.

### 4.4 `lib-motion.test.ts` → rewrite to invariants

Keep: monotonic-and-unique duration ordering, `EASING` 4-tuple
shape/type checks, `linear` literal check, `MOTION_PRESETS` structural
checks (`transition.duration`/`ease` presence, `fadeIn`/`fadeOut` opacity
keyframe direction `[0,1]`/`[1,0]`), and the `#192` compatibility-alias
reference-equality checks (`MOTION_SESSION_SWITCH_DURATION === DURATION.standard`,
`MOTION_STANDARD_EASING === EASING.standard`) — these are real regressions
if broken (e.g. an alias silently forking from its source).

Drop: exact-second pins (`DURATION.instant toBeCloseTo 0.08`, etc.),
`DURATION_RAW` exact-second pins, and the exact-bezier-tuple `toEqual`
checks on `EASING.standard`/`enter`/`exit` — these fail in lockstep with any
intentional token tweak and assert zero behavior beyond "the constant is
still the constant."

### 4.5 `Button.test.tsx` → trim

Remove only "renders children content" (tests React's children rendering,
not `Button`). Keep: variant/size `data-*` reflection (`it.each`, real
prop→attribute contract), default variant/size/type, disabled blocks
onClick + `disabled` attribute, className merge, ref forwarding, explicit
`type="submit"` override, `onClick` firing when enabled.

### 4.6 Scratch cruft

Confirmed via repo-wide `grep` for both filenames: zero references outside
the files themselves. `eslint.config.js` ignores `scratch/**` wholesale (not
a per-file reference). Not wired into `scripts/run-all-e2e.mjs` or any
`package.json` script. Safe to delete outright — no named replacement is
required per the audit ("Delete — non-behavioral").

### 4.7 E2E doc drift

Independently verified (glob + grep, not just audit-asserted):
- `scripts/probe-e2e-*.mjs`: 0 files exist.
- `docs/e2e/*`: directory doesn't exist; `single-harness-brainstorm.md` is
  referenced from 5 files (`e2e-runner.md` + 4 script comments) and exists
  in none.

**Action (docs/comments only, zero runtime behavior change):**
- Rewrite `docs/reference/e2e-runner.md`: remove the "per-file probes" tier
  description and the "Cases that can't be merged" section (both describe
  a `probe-e2e-*.mjs` convention that has been fully absorbed into themed
  harnesses), correct the "Adding a new case" guidance to the harness-only
  reality, and drop the dead brainstorm-doc citation.
- Fix the same dead citation in code comments (`harness-ui.mjs`,
  `harness-dnd.mjs`, `probe-helpers/harness-runner.mjs`,
  `probe-helpers/reset-between-cases.mjs`) by pointing at `e2e-runner.md`
  instead. Comment-only edits — no behavior change, so no TDD is required
  for these.
- `scripts/run-all-e2e.mjs`'s dead `probe-e2e-*.mjs` discovery loop is left
  untouched per the delegation's guardrail (removing it is a runner
  behavior change that would need a focused test or extracted pure
  discovery helper under TDD — deferred to the E2E migration phase where
  the runner is being rewritten anyway).

### 4.8 Testing-strategy reference

Add `docs/reference/testing-strategy.md` capturing (from the audit's §5):
four tiers (unit/integration/contract/e2e) with naming/location guidance,
mock-only-at-boundaries policy with a one-line-justification rule for
internal mocks, fake-time/injected-platform/no-real-network seams,
"deletion requires a named, already-green replacement" rule, "coverage
floors are monotonic, never silently lowered" rule, and "no retries for
deterministic Vitest unit/integration/contract tests" policy (retries are
an E2E-tier concept once that migration lands).

## 5. Risk & rollback

- Every deletion is preceded by porting + a green targeted test run of the
  canonical replacement file, so no assertion is ever "deleted first, hope
  full suite catches it."
- Coverage is compared floor-to-floor (baseline in §3) after the full
  change set; any regression blocks the PR until fixed.
- All changes are docs/tests only — zero production code paths touched —
  so blast radius is limited to CI signal quality, not runtime behavior.
- Rollback is a single revert; no migrations, no schema, no data.

## 6. Validation plan

Focused vitest runs after each consolidation step, then the full gate suite
(`npm run typecheck`, `npm run lint`, `npm test`, `npm run coverage`,
`npm run build`), comparing coverage against §3's baseline. No E2E harness
changes are made, so no E2E run is required for this PR; documented as such
in the PR description.
