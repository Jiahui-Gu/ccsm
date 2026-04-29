# Daily Full-Stack Audit — 2026-04-30 — Summary

7 read-only Explore subagents ran in parallel across pools 1-7 covering D1 persistence, D2 docs, D3 code-rot, D4 architecture, D5 tests, D6 git/PR, D7 deps. Per-domain reports in sibling files.

## HIGH (action required, surfaced to user)

| # | Domain | Finding | Recommended next step |
|---|---|---|---|
| H1 | D6 git | 32 residual stashes in shared object DB; many tagged `WIP`/`temp`/`abandoned`/`(no branch)` | One-shot triage session: `git stash list` → drop obvious WIP/abandoned (drop highest N first to avoid index shift) |
| H2 | D6 git | Worktree branches orphaned: pool-3 `reviewer-cleanup` (no origin counterpart), pool-4 `refactor/main-extract-ipc-lifecycle` (already merged via #578) | `git worktree remove pool-3 && git branch -D reviewer-cleanup`; `cd pool-4 && git checkout working && git reset --hard origin/working` |
| H3 | D7 deps | 4 dogfood-bug-vs-e2e gaps: PR #526 (cwd Browse OS picker), PR #519 (notify always-fires), PR #531 (OSC 0 arm), BUG-186 batch JSONs no `caseBug186*` | File 4 follow-up tasks: probe additions to harness-real-cli/harness-ui |
| H4 | D7 deps | `vitest` 2.1.8 → 4.1.5 (+2 majors); v3→v4 has config + `expect.extend` type breaks | Single dedicated PR; bump + run full vitest suite, fix breakages |

## MED (queued, no immediate action)

| # | Domain | Finding |
|---|---|---|
| M1 | D1 persistence | Memory contradicts behavior: `feedback_full_autonomy_until_list_empty.md` says "暂停 AskUserQuestion" but `feedback_questions_via_askuserquestion.md` says "every clarifying question through AskUserQuestion". Resolve by scoping the autonomy override to dispatched-task-execution only |
| M2 | D2 docs | `docs/mvp-design.md` describes wrong stack ("Tauri shell, Rust", "ttyd embed") — current stack is Electron 41 + Node + xterm.js direct. Major rewrite or archive |
| M3 | D2 docs | `docs/mvp-design.md` "Out of MVP scope" lists features already shipped (notifications, badge, OSC 0 detect). Reconcile or note "shipped in v0.x post-MVP" |
| M4 | D3 code-rot | Orphaned production modules with surviving tests: `src/lib/attachments.ts`, `src/mentions/registry.ts`, `diffFromToolInput` in `src/utils/diff.ts`. Delete impl+tests in single PR if features confirmed cut |
| M5 | D3 code-rot | `src/mock/data.ts` (57 LoC) — zero importers. Delete |
| M6 | D4 architecture | `src/stores/store.ts ↔ src/stores/persist.ts` circular (type-only). Move `Theme/FontSize/FontSizePx` to `slices/types.ts` |
| M7 | D4 architecture | `electron/notify/badgePixels.ts:1-14` Phase A header lies — Phase B shipped. Reword |
| M8 | D5 tests | 43 source files have no detectable companion test. Top-priority backfills: `electron/notify/sinks/pipeline.ts`, `electron/notify/bootstrap/installPipeline.ts`, `electron/ptyHost/claudeResolver.ts`, `electron/sessionWatcher/{fileSource,stateEmitter,titleEmitter}.ts` |
| M9 | D6 git | 86 unmerged remote branches >7d old (mostly 2026-04-21/22 abandoned migration spike cohorts). Manager triage |
| M10 | D6 git | PR #427 `spike/ttyd-embed` — draft, throwaway-tagged, 3d quiet. Close + delete branch |
| M11 | D7 deps | `typescript` 5.7.2 → 6.0.3, `@types/node` 22 → 25, `lucide-react` 0.469 → 1.14. Single chore(deps) batch after vitest lands |

## LOW (applied autonomously this run, see § Applied below)

| # | Domain | Finding | Status |
|---|---|---|---|
| L1 | D1 persistence | Broken hook ref: hook says `feedback_reviewer_in_worktree.md`, file is `feedback_reviewer_use_pr_worktree.md` | RENAMED file to canonical name |
| L2 | D3 code-rot | `classifyPtyExit` re-exported from `src/components/TerminalPane.tsx:9` — dead self-only re-export | DROPPED |
| L3 | D4 architecture | `electron/ptyHost/ipcRegistrar.ts:12` type-imports from `./index` causing circular; move to `./lifecycle` | FIXED |
| L4 | D2 docs | README mentions wrong crash-reporting toggle path | DEFERRED — needs README rewrite, not a one-line fix |
| L5 | D6 git | pool-1 detached HEAD | DEFERRED — pool-1 is the audit pool, this session's CWD |

## Applied this run

1. Renamed `~/.claude/projects/C--Users-jiahuigu/memory/feedback_reviewer_use_pr_worktree.md` → `feedback_reviewer_in_worktree.md` (D1 H4 → reclassified L1; hook now resolves).
2. Edited `electron/ptyHost/ipcRegistrar.ts:12` — type-import source `./index` → `./lifecycle`. Drops one madge circular (D4 M1).
3. Edited `src/components/TerminalPane.tsx:9` — removed dead `classifyPtyExit` re-export (D3 M3).
4. Edited `electron/notify/badgePixels.ts:1-14` — dropped stale Phase A/B language (D4 M3).

No production behavior changes. All four are textual / type-only / dead-code edits.

## Cross-domain themes

- **Memory drift outpaces behavior changes** (D1, D2): autonomy/AskUserQuestion + mvp-design stack are both promises that the code has moved past. Treat memory + design docs as load-bearing, audit them on the same cadence as code.
- **Test coverage is thin where blast radius is highest** (D5): 43 untested files, mostly notify/sinks + sessionWatcher emitters. Recent producer/decider/sink refactors leave the sinks under-tested.
- **Git hygiene strong on commits, weak on stashes/branches** (D6): zero hygiene violations in last 30 commits, but 32 stashes + 86 stale remote branches accumulated. Cleanup is bounded and one-time.
- **Dep majors clustered** (D7): vitest +2, typescript +1, @types/node +3, lucide +1. Stage as 4 independent PRs; vitest first (risk highest).
- **No HIGH architectural debt** (D4): SRP discipline holding, no file >500 LoC, all god-modules dissolved. Maintenance mode.
