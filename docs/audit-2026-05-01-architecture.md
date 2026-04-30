# Audit Report — 2026-05-01 — Architecture Discipline

**Audit basis:** `~/ccsm-worktrees/pool-4` HEAD `755fcae` (origin/working tip; `working` branch checked out elsewhere, audited via detached HEAD).
**Prior audit:** `docs/audit-2026-04-30-architecture.md`.

## Summary

Architecture remains in **strong shape**. Every MED item from yesterday's audit (M1, M2, M3) is **fixed**. Cross-layer import boundaries are **completely clean**. `madge` finds **zero circular dependencies** when traversing from real entry points (`electron/main.ts`, `src/index.tsx`, `daemon/src/index.ts`). No `*.ts`/`*.tsx` source file exceeds 500 LoC; the prior 800+ god-modules (`electron/main.ts`, `electron/preload.ts`) remain split. SRP discipline (producer/decider/sink) is consistently applied across `notify/`, `sessionWatcher/`, `sessionTitles/`, and `ptyHost/`.

No new findings of HIGH or MED severity.

## HIGH

**None.**

## MED

**None.** All three MED items from 2026-04-30 are fixed (see Resolved section).

## LOW

### L1. Top-20 LoC table (excluding `__tests__`)

| Rank | File | LoC | Notes |
|---|---|---|---|
| 1 | `src/terminal/usePtyAttach.ts` | 477 | Producer+sink hybrid; see L2 |
| 2 | `src/stores/slices/sessionCrudSlice.ts` | 420 | CRUD slice, stable |
| 3 | `electron/commands-loader.ts` | 394 | Disk producer + frontmatter parser |
| 4 | `src/App.tsx` | 393 | Composition root |
| 5 | `electron/window/createWindow.ts` | 356 | Sink (BrowserWindow factory) |
| 6 | `electron/import-scanner.ts` | 346 | JSONL producer |
| 7 | `src/i18n/locales/en.ts` | 343 | Data |
| 8 | `src/components/chrome/TopBanner.tsx` | 326 | UI sink |
| 9 | `electron/main.ts` | 320 | Composition root (+12 LoC vs 30/04) |
| 10 | `src/i18n/locales/zh.ts` | 318 | Data |
| 11 | `src/components/CommandPalette.tsx` | 317 | UI sink |
| 12 | `electron/sessionTitles/index.ts` | 313 | SDK bridge sink (deciders extracted) |
| 13 | `electron/ptyHost/entryFactory.ts` | 311 | Factory sink |
| 14 | `src/components/Sidebar.tsx` | 300 | UI sink |
| 15 | `src/components/sidebar/SessionRow.tsx` | 295 | UI sink |
| 16 | `src/components/sidebar/GroupRow.tsx` | 291 | UI sink |
| 17 | `electron/sessionWatcher/fileSource.ts` | 276 | Producer |
| 18 | `electron/notify/badgePixels.ts` | 271 | Pure sink |
| 19 | `daemon/src/db/migrate-v02-to-v03.ts` | 266 | Migration |
| 20 | `src/components/ImportDialog.tsx` | 263 | UI sink |

**No file past 500 LoC.** None of the previously-flagged god-modules grew past prior baselines. `electron/main.ts` ticked up 320 vs 268 LoC — still well within the composition-root expected range; the increase is documentation comments + the unhandledRejection/uncaughtException safety nets noted in its header.

### L2. `src/terminal/usePtyAttach.ts` (477 LoC) — borderline mixed-concern, but justified

This hook owns the full PTY attach choreography: detach → reset → attach → spawn-on-null fallback → snapshot replay (PR-D #866) → SIGWINCH replay → input wiring → exit classification → state flip. That is a producer (subscribes to `pty.onData` / `pty.onExit`), a decider (chooses between buffer / write-direct based on `snapSeq` and the resize replay handler), and a sink (writes to xterm + state) in one file.

**Why it is acceptable today:**
- The choreography is genuinely sequential and stateful per-attach — splitting it into producer+decider+sink modules would require lifting `snapSeq`, `buffered`, `cancelled`, and `requestedSidRef` into a tracker object that all three modules share, which adds wiring without changing testability (the only test surface is the resulting xterm bytes).
- The decision logic is local (snapSeq null vs number, seq compare) and rule-tableable in <5 lines; centralizing it elsewhere would not reduce duplication.
- Heavy inline comments document each step's contract — the file reads as a sequence diagram, not as tangled logic.

**Watchlist signal, not a blocker.** If this file crosses 600 LoC, or if a second attach mode appears (e.g., daemon-attached vs main-attached), revisit by extracting a `PtyAttachOrchestrator` class.

### L3. Cross-layer import audit: clean

- `grep -nE "from ['\"](\.\./)+electron" src/` → 0 matches
- `grep -nE "from ['\"]electron['\"]" src/` → 0 matches
- `grep -nE "from ['\"](\.\./)+(electron|src)" daemon/src/` → 0 matches
- `grep -nE "from ['\"](\.\./)+src" electron/` → 3 matches, all in `src/shared/` (the by-convention shared subtree; types only):
  - `electron/preload/bridges/ccsmSession.ts:22-23` → `src/shared/sessionState`
  - `electron/sessionWatcher/inference.ts:38` → `src/shared/sessionState`

Acceptable per the established `src/shared/` boundary convention.

### L4. Circular dependencies: clean from real entry points

- `npx madge --circular --extensions ts,tsx electron/main.ts src/index.tsx daemon/src/index.ts` → **No circular dependency found** (151 files processed).
- Both circulars flagged 2026-04-30 are gone:
  - `electron/ptyHost/index.ts ↔ ipcRegistrar.ts` — `ipcRegistrar.ts:12` now imports types from `./lifecycle`, not `./index`.
  - `src/stores/store.ts ↔ persist.ts` — `persist.ts:1-6` now type-imports `Theme/FontSize/FontSizePx` from `./slices/types`.

### L5. SRP discipline in target subsystems: validated

- **`electron/notify/`**: explicit producer (`OscTitleSniffer` in ptyHost) → classifier (`titleStateClassifier`) → tracker (`runStateTracker.ts`, pure, owns per-sid state) → decider (`notifyDecider.ts`, rule-table) → sinks (`sinks/{toast,flash,badge}Sink.ts`) → orchestrator (`sinks/pipeline.ts`) → bootstrap (`bootstrap/installPipeline.ts`). One concern per file; rule additions are single-file.
- **`electron/sessionWatcher/`**: `fileSource.ts` (producer), `emitDecider.ts`, `stateEmitter.ts` / `titleEmitter.ts` (sinks), `pendingRenameFlusher.ts` (sink), `index.ts` 152-line facade. Clean.
- **`electron/sessionTitles/`**: `deciders.ts` holds `classifyError` / `decideRetry` / `decideRequeue` (pure); `index.ts` owns SDK loader + per-sid Maps + IPC surface (sink + state holder). Module header explicitly calls out the split. Clean.
- **`electron/ptyHost/`**: `claudeResolver` / `cwdResolver` / `jsonlResolver` pure; `processKiller` / `dataFanout` sinks; `entryFactory` / `lifecycle` / `ipcRegistrar` clean.
- **`src/stores/slices/`**: `sessionCrudSlice` (CRUD), `sessionRuntimeSlice` (runtime mutations), `sessionTitleBackfillSlice` (backfill), `groupsSlice`, etc. — explicit per-concern split per Task #736 / PR #754; each slice's docstring documents its boundary.

**No mixed-concern modules found.**

### L6. `electron/preload.ts` split landed

Yesterday's L1 watchlist item is resolved. `electron/preload.ts` (was 473 LoC) is now `electron/preload/index.ts` (27 LoC) + `electron/preload/bridges/{ccsmCore,ccsmNotify,ccsmPty,ccsmSession,ccsmSessionTitles}.ts` (53–160 LoC each). Total 520 LoC across 6 files; no single bridge over 160 LoC.

## Resolved since 2026-04-30

| ID | Item | Status |
|---|---|---|
| M1 | `electron/ptyHost/index.ts ↔ ipcRegistrar.ts` circular | **FIXED** — types re-routed to `./lifecycle` |
| M2 | `src/stores/store.ts ↔ persist.ts` circular | **FIXED** — types moved to `./slices/types` |
| M3 | `electron/notify/badgePixels.ts` Phase A/B header rot | **FIXED** — header rewritten without migration language |
| L1 | `electron/preload.ts` 473 LoC | **RESOLVED** — split into `preload/bridges/*.ts` |

## Followups (suggested, none blocking)

1. **Watchlist** `src/terminal/usePtyAttach.ts` — revisit at 600 LoC or on second attach mode.
2. **Watchlist** `electron/main.ts` — currently 320 LoC. If the next round of subsystem additions (daemon protocol, Sentry main-transport, etc.) push it past 400 LoC, extract a `electron/bootstrap/` directory mirroring `electron/notify/bootstrap/`.
3. **Optional CI add** — `npx madge --circular --extensions ts,tsx electron/main.ts src/index.tsx daemon/src/index.ts` as a pre-merge check (mirrors yesterday's L4 suggestion; still not wired).
