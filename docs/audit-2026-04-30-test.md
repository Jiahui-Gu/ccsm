# Audit Report — D5: Test Coverage (2026-04-30)

**Scope:** `~/ccsm-worktrees/pool-5` @ origin/working (HEAD `83d40e8`)

## Summary

| Severity | Count | Items |
|---|---|---|
| HIGH | 0 | — |
| MED | 1 | 43 source files have no detectable companion `*.test.*` |
| LOW | 3 | Coverage actuals not measured this run; threshold typo in brief vs config; one notify file untested |

## 1. Unauthorized test skips — PASS (0 matches)
`grep -rnE "(it|test|describe)\.(skip|todo|only)" tests/ electron/` → 0.

## 2. `E2E_SKIP` usage — PASS
Only the env-var pattern present:
- `scripts/run-all-e2e.mjs:60` — `const skipRaw = (process.env.E2E_SKIP || '').trim();`
- `scripts/run-all-e2e.mjs:91` — diagnostic log of env-derived list.
- No hardcoded skip list anywhere.

## 3. E2E case count + harness inventory

No `scripts/probe-e2e-*.mjs` files left (all absorbed into harnesses).

| Harness | LoC | Cases | Notes |
|---|---:|---:|---|
| `scripts/harness-real-cli.mjs` | 3221 | **26** (24 shared + 2 standalone) | CASE_REGISTRY at L3096-3123 |
| `scripts/harness-ui.mjs` | 1685 | **15** (L1614-1676) | Hidden-mode shared launch |
| `scripts/harness-dnd.mjs` | 226 | **1** | Visible-mode dnd-kit isolated |
| **Total** | 5132 | **42** | |

Recent additions: `badge-fire + clear-on-focus`, `spaces-in-cwd` (PR #577 / Tasks #786, #787); 8 trimmed (PR #569); 9 converted to RTL (PR #568); macOS dnd fallback (PR #562).

**Estimated wall time:** `HARNESS_TIMEOUT_MS = 5 * 60_000` per harness; 42 cases ~5-10 min on clean Windows host.

## 4. Source files with zero detectable tests — MED (43 files)

Heuristic: `*.ts/*.tsx` under `src/` + `electron/` (excluding `*.d.ts`, `__tests__/`, `*.test.*`), basename not referenced by any `from .../<base>` import or `describe('...<base>...')` in tests.

```
src/components/AppShell.tsx
src/components/AppSkeleton.tsx
src/components/chrome/TopBanner.tsx
src/components/ClaudeMissingGuide.tsx
src/components/cwd/CwdPopoverPanel.tsx
src/components/ImportDialog.tsx
src/components/InstallerCorruptBanner.tsx
src/components/settings/AppearancePane.tsx
src/components/TerminalPane.tsx
src/components/ui/{ConfirmDialog,Dialog,IconButton,InlineRename,StateGlyph,Tooltip}.tsx
src/components/WindowControls.tsx
src/lib/{cn,motion}.ts
electron/db-validate.ts
electron/ipc/windowIpc.ts
electron/lifecycle/appLifecycle.ts
electron/notify/bootstrap/installPipeline.ts
electron/notify/sinks/{badgeSink,flashSink,pipeline,toastSink}.ts
electron/prefs/{crashReporting,notifyEnabled}.ts
electron/preload/bridges/{ccsmCore,ccsmNotify,ccsmPty,ccsmSession,ccsmSessionTitles}.ts
electron/ptyHost/{claudeResolver,dataFanout,ipcRegistrar}.ts
electron/sentry/init.ts
electron/sessionWatcher/{fileSource,pendingRenameFlusher,stateEmitter,titleEmitter}.ts
electron/testHooks.ts
electron/tray/createTray.ts
```

Priority targets (highest blast radius):
- `electron/notify/sinks/pipeline.ts` + `bootstrap/installPipeline.ts` — wire onto runStateTracker.test.ts pattern.
- `electron/ptyHost/claudeResolver.ts` — pure I/O lookup; spec it.
- `electron/sessionWatcher/{fileSource,stateEmitter,titleEmitter}.ts` — sink emitters still lack UTs.
- `src/components/ui/{ConfirmDialog,Dialog,InlineRename,Tooltip}.tsx` — RTL guards cheap; PR #568 pattern.

## 5. Coverage actuals — LOW (gated, not measured)

`npm run coverage` wired (`package.json:31`, `vitest.config.ts:22-45`, `@vitest/coverage-v8` per PR #584). Configured thresholds: lines 60 / functions 60 / branches 50 / statements 60.

Comment in config (L36-38) confirms thresholds NOT enforced in CI yet ("for this initial roll-out") — that's a follow-up.

**Not executed by audit (read-only role).** Recommend running and pasting totals + per-module breakdown for the 43 untested files.

## 6. Dogfood-bug PR regression coverage — PASS (spot-check)

| PR | Subject | Regression test? |
|---|---|---|
| #767 | gate flash on `hasObservedRunning` | YES — `runStateTracker.test.ts` (+76 lines) |
| #520 | clear `sessionNamesFromRenderer` on session delete | NO — implementation-only commit; worth a follow-up unit test |
| #503 | (no commit hit by `git log --grep="#503"`) | Cannot spot-check |

**Action:** file a small task to backfill UT for #520 leak fix.

## Recommended next actions

1. **MED**: Triage 43-file no-tests list; pick top 6 high-criticality electron-side (notify/sinks + sessionWatcher emitters + claudeResolver) for one backfill PR.
2. **LOW**: Run `npm run coverage` from writeable session; capture totals.
3. **LOW**: Add `#520` regression UT; flip vitest thresholds to CI-enforced (drop "not enforced" caveat).
4. **LOW**: Add 1-line CI lint re-running §1 grep against `tests/ electron/` to keep `.skip/.only/.todo` at zero permanently.
