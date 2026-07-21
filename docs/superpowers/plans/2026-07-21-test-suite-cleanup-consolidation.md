# Implementation plan: test-suite cleanup surgical consolidation

Spec: `docs/superpowers/specs/2026-07-21-test-suite-cleanup-consolidation-design.md`

Baseline (measured, see spec §3): 226 test files / 2086 tests + 1 todo passed,
~111.5s; typecheck/lint/build clean; coverage 79.77% stmt / 72.31% branch /
82.76% fn / 81.96% lines.

Each step below is a separate commit. After each consolidation step, run the
specific affected test file(s) before deleting anything. Run the full gate
suite once at the end (step 9).

## Step 1 — Docs: commit design spec
Already created. Commit as its own change.

## Step 2 — Docs: commit this plan
Commit as its own change.

## Step 3 — Consolidate appearance triplication
1. Edit `tests/stores/slices/appearanceSlice.test.ts`: add the 6 ported
   cases from `tests/appearance.test.ts` (round-trip endpoints, full
   sanitizeFontSizePx stop coverage, null/NaN garbage coercion,
   sanitizeSidebarWidth NaN/undefined fallback, resolvePersistedSidebarWidth
   out-of-range clamp, resolvePersistedSidebarWidth empty-object default)
   into the "appearance helpers (pure)" describe block.
2. Run `npx vitest run tests/stores/slices/appearanceSlice.test.ts` — must
   be green with the new cases actually asserting (not vacuous).
3. Delete `tests/store-appearance.test.ts` (strict subset, no port needed).
4. Delete `tests/appearance.test.ts` (fully ported).
5. Run `npx vitest run tests/stores/slices/appearanceSlice.test.ts` again
   (sanity) and grep the repo for any other importer of the deleted files'
   exports to confirm nothing else referenced them directly (they only
   export test suites, not reusable code, so this should be a no-op check).
6. Commit.

## Step 4 — Consolidate title-backfill overlap
1. Edit `tests/stores/slices/sessionTitleBackfillSlice.test.ts`: add an
   `installBridge`/`seed` helper pair (mirrored from
   `tests/store-backfill-titles.test.ts`, adapted to the slice harness) and
   port all 10 unique `_backfillTitles` cases (patch default, patch zh
   default, never-overwrite-renamed, batch-by-projectKey single IPC,
   multi-project batching, listForProject rejection silent-warn, null/empty
   summary ignored, empty-cwd skip, unknown-sid ignored) — the existing
   no-bridge case stays as-is (already covered, do not duplicate).
2. Run `npx vitest run tests/stores/slices/sessionTitleBackfillSlice.test.ts`
   — must be green.
3. Delete `tests/store-backfill-titles.test.ts`.
4. Run the slice test file again (sanity).
5. Commit.

## Step 5 — Rewrite lib-motion.test.ts
1. Rewrite `tests/lib-motion.test.ts` per spec §4.4: drop literal-value
   pins, keep monotonicity/shape/preset-structure/alias-identity invariants.
2. Run `npx vitest run tests/lib-motion.test.ts` — green.
3. Commit.

## Step 6 — Trim Button.test.tsx
1. Remove the "renders children content" case from
   `tests/components/Button.test.tsx`.
2. Run `npx vitest run tests/components/Button.test.tsx` — green.
3. Commit.

## Step 7 — Delete scratch cruft
1. Re-confirm zero references via `grep` (already done in analysis phase).
2. Delete `scratch/dogfood-ctrl-wheel-zoom.mjs` and
   `scratch/dogfood-reload-retry-repro.mjs`.
3. Run `npm run lint` (scratch/** is eslint-ignored, so this should be a
   no-op, but confirms the ignore-pattern doesn't now dangle).
4. Commit.

## Step 8 — Fix E2E doc/comment drift
1. Rewrite `docs/reference/e2e-runner.md` per spec §4.7.
2. Fix the dead `docs/e2e/single-harness-brainstorm.md` citation in
   `scripts/harness-ui.mjs`, `scripts/harness-dnd.mjs`,
   `scripts/probe-helpers/harness-runner.mjs`,
   `scripts/probe-helpers/reset-between-cases.mjs` comments only — no
   executable line changes.
3. Run `npm run lint` (comment-only edit, confirms no syntax breakage).
4. Do NOT touch `scripts/run-all-e2e.mjs` logic.
5. Commit.

## Step 9 — Testing-strategy reference doc
1. Create `docs/reference/testing-strategy.md` per spec §4.8.
2. No test impact (docs only).
3. Commit.

## Step 10 — Final validation gates
Run in order, capturing output:
1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. `npm run coverage` — compare all four metrics against baseline; any
   decrease blocks the PR until investigated/fixed.
5. `npm run build`
6. Diff test-file count and test count vs baseline; expect file count down
   by 4 (`store-appearance`, `appearance`, `store-backfill-titles`, minus
   zero net for lib-motion/Button which are rewrites not deletions), test
   count roughly flat to up slightly (ported cases add net-new assertions
   in a few spots, e.g. resolvePersistedSidebarWidth empty-default case).

## Step 11 — Code review
Run the `code-review` subagent against the diff. Fix any high-confidence
findings, then re-run the affected gate(s) from Step 10.

## Step 12 — Push and open PR
1. Push branch.
2. Open a non-draft PR with: spec/plan commit links, exact file
   deletions/rewrites with replacement mapping, baseline vs final
   counts/coverage, all validation command output, review findings, and
   deferred recommendations (the 4 root `store-*.test.ts` files, the
   `run-all-e2e.mjs` dead branch, the full E2E→Playwright migration).
3. Do not merge.
