# Dogfood r2 fp10 — slash command / mention / skill+agent picker report

Date: 2026-04-27T05:46:52.198Z
Binary: installed CCSM.exe at C:/Users/jiahuigu/AppData/Local/Programs/CCSM/CCSM.exe
userData: C:/temp/ccsm-dogfood-r2-fp10
Screenshots: docs/screenshots/dogfood-r2/fp10-pickers/

## Architecture note (verified before probing)

- `/` opens **`<SlashCommandPicker>`** — the SINGLE entry point for built-in,
  user, project, plugin, **skill** and **agent** commands. Six sections,
  one picker. (`src/components/SlashCommandPicker.tsx`,
  `src/slash-commands/registry.ts`)
- `@` opens **`<MentionPicker>`** — file mentions only (inline `@path/to/file`).
  There is **no separate `@agent` picker**: agents are accessed via `/`.
  (`src/components/MentionPicker.tsx`)
- Skills/agents come from `~/.claude/skills/*.md` + `~/.claude/agents/*.md`
  (electron/commands-loader.ts §4-5). Plugin SKILLS are NOT walked.

## fp10: PASS

- **A** (slash picker opens; six sections render): **PASS** — builtin=true user=true skill=true agent=true plugin=true optionCount=26 headingsHas=true
- **B** (built-in /clear end-to-end (commit + close)): **PASS** — /cle + Enter → input='' pickerOpen=false
- **C** (agent reachable via slash picker (no @agent picker — `@` is file-mention by design)): **PASS** — agent in slash picker: true; "@" opens picker 'File mentions' (file-mention, NOT agent — by design). No dedicated @agent picker exists.
- **D** (skill reachable via slash picker (no separate skill picker — by design)): **PASS** — skill in picker=true; selected→input='' pickerOpen=false (no dedicated skill picker — uses slash picker, by design)
- **E** (empty / no-results state): **PASS** — visible=true options=0 hint='No matching commands — press Enter to send as a regular message.
↑↓ navigate
Ent'
- **F** (keyboard nav: ↓ ↑ Enter Esc): **PASS** — start='/clearStart a new conversation and clear context' down='/compactSummarize conversation to free context' down2='/configOpen the Settings dialog' up='/compactSummarize conversation to free context' afterEscVisible=false

