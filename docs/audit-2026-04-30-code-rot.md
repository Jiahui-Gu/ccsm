# Audit 2026-04-30 — Code Rot (D3)

**Pool:** `~/ccsm-worktrees/pool-3` @ HEAD `9b76966`

## Summary

Repo is in **excellent** code-rot health. Effectively zero stale TODOs, zero `any` density in production code, zero abandoned commented-out code blocks, and zero WIP/fixup commits in the last 30. The only meaningful rot is a small set of orphaned exports that survived feature gutting but kept their unit tests.

## HIGH

*None.* No urgent cleanup.

## MED

### M1. Orphaned production modules with surviving tests

| Symbol | Defining file | Last touched | Only referenced by |
|---|---|---|---|
| `intakeFiles`, `attachmentToDataUrl`, `buildUserContentBlocks` | `src/lib/attachments.ts` | 2026-04-22 (#83) | `tests/attachments.test.ts` |
| `detectAtTrigger`, `filterMentionFiles`, `commitMention` | `src/mentions/registry.ts` | 2026-04-30 (tsconfig sweep) | `tests/mentions-registry.test.ts` |
| `diffFromToolInput` | `src/utils/diff.ts` | 2026-04-21 (#51) | `tests/diff.test.ts` |

**Action:** confirm drag-drop attachment + `@mention` features are intentionally cut, then delete impls + tests in one PR.

### M2. Fully orphan mock fixture file
`src/mock/data.ts` (57 LOC) — no importer anywhere. All 5 exports dead. Last touched 2026-04-24 in a rename. **Action:** delete the file.

### M3. Duplicate `classifyPtyExit` re-export
`classifyPtyExit` exported from BOTH `src/lib/ptyExitClassifier.ts` (real definition, used) AND `src/components/TerminalPane.tsx:9` (dead re-export, only self-referenced). **Action:** drop re-export in TerminalPane.tsx.

## LOW

### L1. Stale TODO/FIXME — exactly one match (recent)
- `electron/main.ts:40` — `// ... TODO: forward to Sentry once main-process Sentry transport is wired`
- Blame: commit `8eced9e1`, **2026-04-30** (today). Not stale. Tracked as future work.

### L2. `any` / `@ts-ignore` density — essentially zero
| Count | File |
|---|---|
| 3 | `electron/sessionWatcher/__tests__/projectKey.test.ts` (test, legit) |
| 3 | `electron/ptyHost/__tests__/entryFactory.test.ts` (test, legit) |
| 2 | `electron/sessionWatcher/inference.ts` (production — worth a glance) |
| 1 | `src/terminal/xtermSingleton.ts` |
| 1 | `electron/agent/list-models-from-settings.ts` |

**Action:** optional 5-min review of the 2 `any`s in `sessionWatcher/inference.ts`.

### L3. ts-prune type-only / barrel re-exports
~24 type-only re-exports flagged (mostly intentional design-system surface). **Action:** annotate with `// ts-prune-ignore-next` on `src/components/ui/*` barrels to silence future audits.

### L4. Other ts-prune noise
- `xtermSingleton.ts:206` `__resetSingletonForTests` — kept as test seam, fine.
- `ClaudeMissingGuide.tsx:81` — default export unused (component now imported as named?).
- `FileTree.tsx:22` — `FileTree` named export only self-referenced. Possibly partially-removed component.
- `src/i18n/index.ts` — `resolveLanguage`, `initI18n`, `applyLanguage` flagged. Likely dynamic-import / side-effect entry; verify before removing.
- `src/lib/motion.ts` — `DurationToken`, `EasingToken`, `MotionPreset` types unused.
- `src/stores/drafts.ts` — `getDraft`, `setDraft`, `clearDraft` unused (drafts feature not wired into UI?).

### L5. Commented-out code blocks
~20 hits for runs of ≥5 consecutive `//` comments. Manual review of largest (App.tsx 232/204/191, CwdPopover.tsx 14, AgentIcon.tsx 39) confirmed all real JSDoc / explanatory prose. **No action.**

### L6. Recent commit hygiene
`git log HEAD~30..HEAD` for `wip|fixup|tmp|squash|temp`: **0 matches.** Excellent.

## Suggested cleanup PRs

1. **`chore: drop dead mock fixtures + orphan attachments/mentions code`**
   - Delete `src/mock/data.ts`
   - Delete `src/lib/attachments.ts` + `tests/attachments.test.ts` (confirm feature is gone)
   - Delete `src/mentions/registry.ts` + `tests/mentions-registry.test.ts` (confirm feature is gone)
   - Drop unused `diffFromToolInput` from `src/utils/diff.ts` and its test case
2. **`chore: remove duplicate classifyPtyExit re-export`** — one-line delete.
3. **`chore: silence design-system ts-prune noise`**
4. **(Optional) `refactor: replace 2 anys in sessionWatcher/inference.ts`**

Estimated total: **< 1 hour**, ~150–250 LOC removed.
