# Audit Report — Test Coverage (2026-05-01)

**Scope:** `~/ccsm-worktrees/pool-5` @ origin/working tip `755fcae` (`feat(daemon/envelope): T12 daemonProtocolVersion + x-ccsm-boot-nonce precedence (#654)`).

Prior baseline: `docs/audit-2026-04-30-test.md` @ `83d40e8`.

## Summary

| Severity | Count | Items |
|---|---:|---|
| HIGH | 0 | — |
| MED  | 2 | (a) `daemon/src/**` missing from `vitest.config.ts` coverage `include`; (b) 17 source files still have no detectable test (down from 43, but 11 are repeat offenders — drift not fixed since 2026-04-30). |
| LOW  | 3 | (a) Coverage thresholds still NOT enforced in CI (config comment unchanged since #802); (b) e2e wall-time grew by +1 case net (43 vs 42); (c) #520 regression UT still missing (open from prior audit). |

## 1. Unauthorized skips — PASS (0)

`grep -rnE "(it|test|describe)\.(skip|only|todo)\(|^\s*(xit|xdescribe|fit|fdescribe)\("` against `**/*.test.{ts,tsx}` → **0 matches**.

`E2E_SKIP=` usage:
- `scripts/run-all-e2e.mjs:60,91` — env-var read + diagnostic log.
- `.github/workflows/e2e.yml:114,119` — `E2E_SKIP: harness-real-cli` on the public-CI job (no `claude` binary on hosted runners, justified at L104).
- `docs/reference/e2e-runner.md:109` — documentation.

No hardcoded skip lists. PASS.

## 2. E2E case count + wall time

| Harness | LoC | Cases | Source |
|---|---:|---:|---|
| `scripts/harness-real-cli.mjs` | 3559 | **28** (26 shared + 2 standalone) | `CASE_REGISTRY` L3432-3461 |
| `scripts/harness-ui.mjs`       | 1662 | **14** | `cases: [...]` L1590-1654 |
| `scripts/harness-dnd.mjs`      | 226  | **1**  | L223-225 |
| **Total** | 5447 | **43** | — |

Δ vs prior audit (42 → 43): **+1 net case**. New entries vs 2026-04-30:
- `harness-real-cli`: `import-lands-in-focused-group`, `default-cwd-from-userCwds-lru`, `new-session-focus-cli`, `pty-pid-stable-across-switch`, `cwd-picker-{top-default,top-chevron,browse,no-shortcut}`, `sidebar-group-no-newsession-cluster` (count went 26 → 28; some prior entries pruned).
- `harness-ui`: stable at 14 (was 15 — one removed; comment trail in file shows `cap-skip-launch-bundle-shape` retained, others removed in #740 Batch 3.1 already counted last time).

`HARNESS_TIMEOUT_MS = 5 * 60_000` per harness; estimated wall ~5-10 min on clean Win 11 host (unchanged).

No standalone `scripts/probe-e2e-*.mjs` files exist — full absorption into harnesses preserved.

## 3. Untested source files — MED (17 files)

Heuristic (run script — see appendix): walk `src/`, `electron/`, `daemon/src/` for `.ts`/`.tsx` (excluding `*.d.ts`, `*.test.*`, `__tests__/`, `index.{ts,tsx}` barrels). Match against test corpus (`tests/`, `electron/**/__tests__/`, `daemon/**/__tests__/`) using both:
- import path regex `(['"`])(?:[^'"`]*[/\\])?<stem>(\.[tj]sx?)?\1`
- `describe('…<stem>…')`
- companion test file `…/<stem>.test.{ts,tsx}`

Pool: 165 source files. Untested: **17** (down from 43 in 2026-04-30 audit — most of the gap was a stale heuristic that excluded colocated `__tests__/` dirs, not actual coverage gain; ~28 files were already covered last week. Real coverage growth this week is ~0).

### Top 17 untested by LoC

```
LOC   PATH
264   src/components/ImportDialog.tsx
162   src/components/cwd/CwdPopoverPanel.tsx
161   electron/preload/bridges/ccsmCore.ts
141   electron/testHooks.ts
133   electron/preload/bridges/ccsmSession.ts
127   electron/lifecycle/appLifecycle.ts
126   src/components/TerminalPane.tsx
120   src/components/settings/AppearancePane.tsx
115   src/components/ui/ContextMenu.tsx
 94   electron/preload/bridges/ccsmPty.ts
 76   electron/ipc/systemIpc.ts
 75   src/components/ui/Tooltip.tsx
 56   electron/preload/bridges/ccsmSessionTitles.ts
 54   electron/preload/bridges/ccsmNotify.ts
 51   electron/agent/read-default-model.ts
 35   electron/ipc/windowIpc.ts
 33   src/shared/ipc-types.ts (types-only — likely not testable; OK to exclude)
```

### Repeat offenders vs prior audit (drift = NOT fixed in 1 week)

11 of 17 appeared in 2026-04-30 list:
`ImportDialog`, `CwdPopoverPanel`, `TerminalPane`, `AppearancePane`, `Tooltip`, `appLifecycle`, `windowIpc`, `testHooks`, `ccsmCore`, `ccsmSession`, `ccsmPty`, `ccsmSessionTitles`, `ccsmNotify`. (Previous list also flagged `notify/sinks/*`, `sessionWatcher/*` emitters, `ConfirmDialog/Dialog/InlineRename/StateGlyph/IconButton`, `installPipeline`, `claudeResolver`, `crashReporting/notifyEnabled`, `dataFanout/ipcRegistrar`, `tray/createTray`, `db-validate`, `cn/motion`, `sentry/init`, `pendingRenameFlusher` — all of those now show colocated tests, so they pass).

### New entries this audit (3, all small)

- `electron/ipc/systemIpc.ts` (76 LoC) — IPC handler for system queries.
- `electron/agent/read-default-model.ts` (51 LoC) — reads the user's default-model preference; pure I/O, easy to spec.
- `src/shared/ipc-types.ts` (33 LoC) — types only; exclude from goal.

### Priority backfill targets

1. **`electron/preload/bridges/*` (5 files, 498 LoC)** — these are the contextBridge surface; a single contract test asserting each `expose*` shape would cover all 5 cheaply. Touched by every renderer call; zero unit cost = high blast radius.
2. **`electron/lifecycle/appLifecycle.ts`** — quit/relaunch path; pair with `singleInstance.ts` (already tested) for one suite.
3. **`src/components/ImportDialog.tsx`** (264 LoC, largest untested) — has e2e via `import-resume`/`import-lands-in-focused-group` cases, but no unit test for the dialog branching (empty-groups vs populated).
4. **`electron/agent/read-default-model.ts`** — easy win, file I/O + parse only.

## 4. `vitest.config.ts` audit — MED (a)

**Glob `include` (test discovery):** PASS — covers `tests/**`, `electron/**/__tests__/**`, `daemon/**/__tests__/**`.

**Coverage `include`:** `['src/**/*.{ts,tsx}', 'electron/**/*.ts']` — `daemon/src/**` missing.

This is a regression in scope: the daemon now has 13 colocated test files in `daemon/src/{db,envelope}/__tests__/`, but their executions never report against `daemon/src/**` source LoC because it's outside the `include`. `npm run coverage` artifacts (lcov.info) silently omit daemon coverage — CI can't see daemon regressions, and dev `text` reporter under-reports.

**Fix:** add `'daemon/src/**/*.ts'` to `coverage.include` in `vitest.config.ts:26`.

**Thresholds:** unchanged from PR #802 — lines 60 / functions 60 / branches 50 / statements 60, **NOT enforced** (comment L37-39 explicit). Carry-over LOW from prior audit.

## 5. Carry-overs from 2026-04-30 audit

| Item | Status | Severity |
|---|---|---|
| #520 regression UT for `sessionNamesFromRenderer` cleanup on session delete | NOT filed/landed | LOW |
| Flip vitest thresholds to CI-enforced | NOT done | LOW |
| `npm run coverage` actuals captured | NOT in this audit (read-only role); PR body of #802 has the original numbers | LOW |
| 1-line CI lint to keep `.skip/.only/.todo` at zero | NOT added (manual grep clean this audit, but no automation) | LOW |

## Recommended next actions

1. **MED** — Add `daemon/src/**/*.ts` to `vitest.config.ts` `coverage.include` (1-line fix; reviewer can do it inline with the next test PR).
2. **MED** — One small backfill PR covering `electron/preload/bridges/*` (5 files) with a single contract test; this is the highest-leverage shrinkage of the untested list.
3. **LOW** — Backfill UT for `read-default-model.ts` and `ImportDialog.tsx` empty-vs-populated branching.
4. **LOW** — File the still-missing #520 regression UT (open from last audit).
5. **LOW** — Add a CI lint step (1-line grep) to keep `.skip/.only/.todo` at zero permanently — manual verification has been clean for 2 audits, lock it in.

## Appendix — script used for §3

Walks `src/`, `electron/`, `daemon/src/` excluding `*.d.ts`, `*.test.*`, `__tests__/` dirs, and `index.{ts,tsx}` barrels. Walks `tests/`, `electron/**/__tests__/`, `daemon/**/__tests__/` for tests. Matches each source basename against test corpus via path-suffix import regex, `describe('…')` substring, and companion `<stem>.test.{ts,tsx}` filename. (Inline ad-hoc node script; not committed.)
