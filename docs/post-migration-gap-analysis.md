# Post-Migration Gap Analysis: CCSM vs Claude Desktop

**Date**: 2026-04-21

## Summary

**Total gaps**: 11 (1 regression, 10 missing)  
**P0 (MVP blocker)**: 3 items = 2–4h effort  
**P1 (v1 must-have)**: 5 items = 7–9h effort  
**P2 (v2+)**: 3 items = polish  

### Top 3 P0s:

1. **AskUserQuestion option picker (REGRESSION)** — Block is parsed but not rendered; user cannot select answers interactively
2. **Tool result error styling** — User cannot distinguish failures; missing red border + error icon
3. **Terminal pane with ANSI** — Real dogfood blocked; bash output unreadable (optional for v0.1)

---

## 1. Claude Desktop Capabilities (Reference)

### Block Types with Interactive Elements:
- question_widget: Radio/checkbox grid per question, multiselect toggle, Submit button
- permission_prompt: Allow/Deny buttons (focused on Deny)
- plan_block: Markdown plan, Reject/Approve buttons
- diff_viewer: Monaco side-by-side, hunk-level accept/reject, line comments
- todo_widget: Checkbox UI, progress counter, strikethrough
- terminal_pane: PTY + xterm ANSI, input box

### Tool-Specific Rendering:
- Edit: Monaco createDiffEditor + jsdiff hunks + hunk buttons
- Read/Glob: File tree with folder navigation
- Bash: ANSI colors + PTY rendering
- AskUserQuestion: Interactive option grid (currently missing in CCSM)

---

## 2. CCSM Current State

### Block Status:
- user, assistant, todo, waiting, status, error: ✅ Implemented
- tool: ⚠️ Partial (custom diff, no hunk buttons)
- question: ⚠️ **REGRESSION** (lifecycle.ts parses correctly but ChatStream.tsx:549–563 has broken render path)

### Gap Details:

#### P0.1: AskUserQuestion Option Picker
- Status: Parsed in lifecycle.ts:111–120 but render path missing
- Fix: Connect QuestionBlock component (already exists at ChatStream.tsx:405–520) to renderBlock switch
- Files: ChatStream.tsx (line 549–563 fallback)
- Effort: **S (≤1h)**

#### P0.2: Tool Result Error Styling
- Status: ToolBlock.isError flag exists but not styled
- Fix: Apply red border + error icon when isError=true
- Files: ChatStream.tsx:ToolBlock (lines 105–167)
- Effort: **S (≤1h)**

#### P0.3: Terminal Pane (optional for v0.1)
- Status: Not implemented
- Build: xterm.js + node-pty + IPC bridge
- Files: Terminal.tsx (new), ChatStream.tsx, main process handler
- Effort: **L (~4h)**

#### P1.1: Diff Hunk Accept/Reject
- Status: No hunk-level buttons
- Build: Parse hunks via jsdiff, "Accept" button per hunk, write only selected hunk to file
- Files: ChatStream.tsx:DiffView, utils/diff.ts, file write handler
- Effort: **M (~3h)**

#### P1.2: File Tree (Read/Glob Results)
- Status: Shows as JSON
- Build: Recursive React tree component with folder toggle
- Files: FileTree.tsx (new), ChatStream.tsx tool detection
- Effort: **M (~2–3h)**

#### P1.3: Syntax Highlighting (Diffs)
- Status: No Monaco; custom grid has no highlight
- Build: Language detection + Monaco (3.3MB) or CodeMirror 6 (~500KB)
- Files: utils/diff.ts, ChatStream.tsx, package.json
- Effort: **M (~2–3h)**

#### P1.4: Tool Input Pretty-Print
- Status: Generic JSON display
- Build: Pretty-print with indentation, collapse long values
- Files: ChatStream.tsx:ToolBlock (line 154–160)
- Effort: **S (~1h)**

#### P2.1–P2.3: Polish (line comments, auto-expand, toggle)
- Effort: **S–L (1–4h each)**

---

## 3. Parallelization (2-Person Team)

**Stream A** (Frontend): Question (1h) → Error (1h) → Diff (3h) + FileTree (2–3h)  
**Stream B** (Full-stack): Terminal (4h parallel) → Syntax (2–3h)  

**Total elapsed**: ~1 day for P0+P1 with 2 devs  

---

## 4. Effort Summary

| Priority | Items | Effort |
|---|---|---|
| P0 | 3 | 2–4h (Optional: +4h Terminal) |
| P1 | 5 | ~7–9h |
| P2 | 3 | ~5–10h |

**Total P0+P1**: ~12–13h = ~2 days with 2 devs, ~4 days with 1 dev

---

## References

Source files (read-only):
- Claude Desktop reverse-eng: S2, S4, S5
- CCSM: types.ts, stream-to-blocks.ts, ChatStream.tsx, lifecycle.ts
- Feature matrix: comparison/A-feature-matrix.md
