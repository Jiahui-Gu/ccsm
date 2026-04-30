# Audit Report — 2026-04-30 — Architecture Discipline

**Audit basis:** `~/ccsm-worktrees/pool-4` HEAD `4f77036` on `refactor/main-extract-ipc-lifecycle` (2 commits ahead of origin/working at audit time, both topical refactors that landed as PR #578).

## Summary

The codebase is in **strong shape architecturally**. Recent SRP refactors (Tasks #678, #690, #721, #722, #729, #738, #742, #743, #744) have landed and the producer/decider/sink discipline is enforced. Cross-layer import boundaries are completely clean (zero violations). Two minor circular dependencies exist, both type-only / re-export-driven. No god-modules have grown past 500 LoC.

## HIGH

**None.** No boundary breach, no runtime circular, no uncontrolled god-module growth.

## MED

### M1. Circular dep: `electron/ptyHost/index.ts ↔ electron/ptyHost/ipcRegistrar.ts`
- `madge` reports `Found 1 circular dependency: ptyHost/index.ts > ptyHost/ipcRegistrar.ts`
- **Cause:** `index.ts` imports `registerPtyIpc` from `./ipcRegistrar`; `ipcRegistrar.ts:12` `import type { AttachResult, PtySessionInfo } from './index'`
- **Impact:** Type-only — TS erases at runtime; types are themselves re-exported in `index.ts` from `./lifecycle`
- **Fix:** Change `ipcRegistrar.ts:12` to `import type { AttachResult, PtySessionInfo } from './lifecycle';` — one-line.

### M2. Circular dep: `src/stores/store.ts ↔ src/stores/persist.ts`
- `madge` reports `Found 1 circular dependency: stores/store.ts > stores/persist.ts`
- **Cause:** `store.ts` imports runtime + types from `./persist`; `persist.ts:1-6` type-imports `Theme, FontSize, FontSizePx` from `./store`
- **Impact:** Type-only edge; would dissolve if those types were in `slices/types.ts` or `prefsTypes.ts`
- **Fix:** Move `Theme, FontSize, FontSizePx` declarations into `src/stores/slices/types.ts` (or new `prefsTypes.ts`); update both imports.

### M3. Phase-A migration scaffolding still on disk: `electron/notify/badgePixels.ts`
- `badgePixels.ts:13-14` documents itself as "Phase A: copy of helpers in `electron/notify/badge.ts`. Phase B will switch the import and delete the originals."
- **Reality:** Phase B shipped. `badge.ts` is now a 31-line facade composing `badgeStore` + `sinks/badgeSink`. `badgePixels.ts` (275 LoC) is the live module.
- **Fix:** Update header comment in `electron/notify/badgePixels.ts:1-14` — drop Phase A/B language.

## LOW

### L1. `electron/preload.ts` is largest source file (473 LoC)
- Pure wiring; no decision logic. Below 500-LoC threshold and within SRP (single sink: "expose IPC bridge").
- **No action.** If it crosses 500 split per namespace into `electron/preload/bridges/*.ts` (work appears in-flight).

### L2. Top-10 LoC table
| Rank | File | LoC | Status |
|---|---|---|---|
| 1 | `electron/preload.ts` | 473 | OK, see L1 |
| 2 | `src/components/CwdPopover.tsx` | 448 | growing, dual-mode |
| 3 | `src/App.tsx` | 438 | shrinking from 500+ |
| 4 | `src/stores/slices/sessionCrudSlice.ts` | 404 | stable |
| 6 | `electron/commands-loader.ts` | 393 | not on watchlist |
| 8 | `electron/window/createWindow.ts` | 344 | new (extracted from main) |
| 9 | `src/components/CommandPalette.tsx` | 341 | UI sink |
| 10 | `src/components/chrome/TopBanner.tsx` | 326 | UI sink |
| ~ | `electron/main.ts` | **268** | was 800+ god-module — major SRP win |
| ~ | `src/stores/store.ts` | 272 | shrunk |

**No file past 500 LoC.** None of previously-flagged god-modules grew past prior baselines.

### L3. Cross-layer import audit: clean
- `grep -rn "from ['\"]\\.\\./.*electron" src/` → 0
- `grep -rn "from ['\"]electron['\"]" src/` → 0
- `grep -rn "from ['\"].*components" src/stores/` → 0
- `grep -rn "from ['\"]\\.\\./\\.\\./src" electron/` → 0
- Preload exception: `electron/preload.ts:3-7` type-imports from `src/shared/ipc-types` — by-convention shared subtree, acceptable.

### L4. SRP discipline in target subsystems: validated
- `electron/notify/`: Producer (OscTitleSniffer in ptyHost), decider (notifyDecider.ts pure), state-tracker (runStateTracker.ts), sinks ({toastSink,flashSink,badgeSink}), pipeline orchestrator (sinks/pipeline.ts), bootstrap (bootstrap/installPipeline.ts). titleStateBridge no longer exists.
- `electron/sessionWatcher/`: documented producer/decider/sink split; index.ts a 152-line facade; reverse imports to sessionTitles excised.
- `electron/ptyHost/`: SRP layout per index.ts:22-31; jsonlResolver/cwdResolver/claudeResolver pure; processKiller/dataFanout sinks; entryFactory/lifecycle/ipcRegistrar clean.
- **No mixed-concern modules found.**

### L5. Notify decider duplication risk: still nil
- Single source of truth (`notifyDecider.ts:5-15` rule table + `evalRules()` switch). Adding a rule = touch one file.

### L6. `installPipeline.ts` reaches across subsystems (intentional)
- Imports from `../sinks/pipeline`, `../../ptyHost`, `../../sessionWatcher`. This is the composition root sink — acceptable pattern.

## Followups (suggested order, none blocking)

1. **M1** — One-line type-import fix to drop ptyHost circular. ~2 min.
2. **M3** — Reword badgePixels.ts header. ~2 min.
3. **M2** — Move shared theme/font types out of store.ts into slices/types.ts. ~10 min.
4. Add `npx madge --circular --extensions ts,tsx electron/main.ts src/index.tsx` to CI as pre-merge guard.
