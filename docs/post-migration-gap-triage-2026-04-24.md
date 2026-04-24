# Post-Migration Gap Triage (2026-04-24)

Triage of `docs/post-migration-gap-analysis.md` (dated 2026-04-21) against
the current `working` branch and the manager's TaskList.

Source doc enumerates 11 gaps:
- 3 P0 (MVP blocker)
- 5 P1 (v1 must-have)
- 3 P2 (v2+ polish)

Three days and the #207–#293 PR wave later, most of the picture has changed.
This file captures the snapshot so the doc itself can be retired.

---

## Resolved

| Gap | Original priority | Closed by |
|---|---|---|
| **P0.1** AskUserQuestion option picker (regression) | P0 | `renderBlock.tsx` case `'question'` now renders `<QuestionBlock>`, wired during the `ChatStream` split (#207). Verified in `src/components/chat/renderBlock.tsx`. |
| **P0.2** Tool result error styling | P0 | `ToolBlock.tsx` now applies `state-error` border, `AlertCircle` icon, `role="alert"`, `text-state-error` name, `tool-failed` tag, and error-tinted result pre. See `src/components/chat/blocks/ToolBlock.tsx` lines 86–246. Type tokens shipped in #225 (`feat(type): 4-step semantic type tokens`); state-error tokens consolidated in #195. |
| **P0.3** Terminal pane with ANSI | P0 | Shell tools route to `<Terminal data=…>` in `ToolBlock` (line 239). `SHELL_OUTPUT_TOOLS` lives in `chat/constants.ts`. |
| **P1.2** File tree for Read/Glob results | P1 | `<FileTree source=…>` rendered for `FILE_TREE_TOOLS` in `ToolBlock` line 237. |
| **P1.3** Syntax highlighting in diffs | P1 | `DiffView` now uses `HighlightedLine` + `languageFromPath` from `components/CodeBlock` for both removed and added lines. No Monaco — lighter highlighter chosen. |
| **P1.4** Tool input pretty-print | P1 | `<PrettyInput input={input} />` rendered in `ToolBlock` line 233; component does indent + key/string colouring + click-to-expand for long strings (`PrettyInput.tsx`). |

The original "two devs, two days" estimate effectively shipped via the P0/P1 sweep.
The doc itself is now stale and should be deleted (or renamed `*-archive.md`)
once this triage merges — see Pending P-doc cleanup below.

---

## Pending

| ID | Original priority | Triaged size / priority | Existing TaskList? | Notes |
|---|---|---|---|---|
| **P1.1** Diff hunk accept/reject — partial-write IPC | P1 | M / P1 | **Yes — task #251 ("Add IPC for partial/per-hunk diff write")** | UI buttons + per-hunk decision state already shipped (`DiffView.tsx` lines 12–23), but the IPC that writes only the accepted hunks back to `diff.filePath` is the explicit `TODO(partial-write)` on line 21. Task #251 already tracks this — **no new task needed**. |
| **P2.1** Diff line comments | P2 | M / P2 | No | `DiffView` has no per-line comment affordance. Real value only after #251 lands; defer until then. **Suggested task title**: `chat(diff): per-line comment affordance after partial-write IPC` |
| **P2.2** Auto-expand failed/long tool blocks | P2 | S / P2 | No | `ToolBlock` always starts collapsed (no `defaultOpen` heuristic). Errors (`isError`) and stalled blocks should auto-expand for visibility. **Suggested task title**: `chat(tool-block): auto-expand on isError + stall escalation` |
| **P2.3** Manual collapse/expand toggle for diff view | P2 | S / P2 | No | `DiffView` has no master toggle to collapse the whole diff. Useful when a single tool call patches many files. **Suggested task title**: `chat(diff): per-file collapse toggle for DiffView` |
| **Doc hygiene** Retire `post-migration-gap-analysis.md` | — | XS / P2 | No | The source doc is now misleading (says P0.1 is broken, etc.). After this triage merges, delete the file or move under `docs/archive/`. **Suggested task title**: `docs: archive post-migration-gap-analysis.md (superseded by triage)` |

### Proposed TaskCreate calls (manager to file)

```
P2.1  chat(diff): per-line comment affordance after partial-write IPC
P2.2  chat(tool-block): auto-expand on isError + stall escalation
P2.3  chat(diff): per-file collapse toggle for DiffView
DOC   docs: archive post-migration-gap-analysis.md (superseded by triage)
```

All four are P2 polish — none block the v0.1 ship gate. P2.1 is blocked by #251.

---

## Out of scope / no longer relevant

| Gap | Reason |
|---|---|
| Source doc's "Stream A / Stream B parallelization" plan | Already executed — keeping the section live would just confuse a reader who joins the project today. |
| Source doc's "Total elapsed: ~1 day for P0+P1 with 2 devs" effort table | Historical; replaced by the actual merge wave (#207–#293). |
| Monaco editor consideration for diff highlighting | Explicitly rejected — `CodeBlock`'s lightweight `HighlightedLine` was adopted instead. No bundle-size regression task needed. |

---

## Cross-reference vs current TaskList

- **#251** "Add IPC for partial/per-hunk diff write" — already covers P1.1 follow-up.
- No existing tasks for P2.1 / P2.2 / P2.3 — file as new if and when the manager wants to tackle polish.
- No conflict with the post-#234 backlog (notify Wave 3 #252, CI lanes #245/#269, etc.) — all chat-rendering gaps live in a separate area.
