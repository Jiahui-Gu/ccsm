# Daily audit: doc-code consistency — 2026-05-01

**Pool:** `~/ccsm-worktrees/pool-2` @ detached `755fcae` (origin/working tip).
**Scope:** `docs/**/*.md` (40 files), `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `RELEASE_NOTES_v0.1.0.md`. No `CHANGELOG.md`.
**Comparison baseline:** `docs/audit-2026-04-30-docs.md` (pool-8 @ `46bcecc`). Most prior HIGHs are still unfixed; new HIGHs surface around STATUS.md and roadmap.md.

---

## HIGH

### H1. STATUS.md is 11 days + ~600 PRs stale and lies about the architecture
File: `docs/status/STATUS.md:3` — *"Last updated: 2026-04-20 (after PR #18)"*. Tip is PR #655 (2026-04-30).

Worse, it makes assertions that contradict reality:

- Line 26: *"Claude Agent SDK integration ✅ — Main process: `electron/agent/sessions.ts` (`SessionRunner`...) + `electron/agent/manager.ts`"*.
  Reality: `electron/agent/` contains only `read-default-model.ts`. No `sessions.ts`, no `manager.ts`, no `SessionRunner`. The agent runtime is **node-pty + xterm.js + the Claude CLI** (`electron/ptyHost/`, `electron/sessionWatcher/`, `electron/sessionTitles/`). README + RELEASE_NOTES already say "no SDK" — STATUS contradicts both.
- Lines 96, 111, 126: still describe vitest "37 tests" / playwright as "pending". E2E suite shipped weeks ago (`docs/reference/e2e-runner.md`).
- §10 "Onboarding first run 🟡 ... Import CTA waits on the import scanner" — `electron/import-scanner.ts` exists.
- "MVP gap table" P0/P1/P2 items (markdown rendering, tool result wiring, auto-scroll, Cmd+N) are all shipped.

The whole file is a counter-source-of-truth. **Action:** delete it OR rewrite as "v0.2 MVP shipped 2026-04-30, see roadmap.md" pointer. The PR roadmap section listing #10–#25 is pure historical noise.

### H2. roadmap.md points at a path that doesn't exist
File: `docs/roadmap.md:7`

> See `docs/superpowers/specs/mvp-design.md` for the original design.

Path does not exist. The actual file is `docs/mvp-design.md`. **Action:** fix the link target.

### H3. v0.3-fragments dir was supposed to be deleted, still in tree
File: `docs/superpowers/specs/v0.3-fragments/README.md:5-9`

> Lifecycle: each `frag-*.md` is written by a dedicated worker, then merged into `docs/superpowers/specs/2026-04-30-web-remote-design.md` by the manager in pool-2. **After merge, this entire directory is deleted in the merge commit.**

Both the merge target (`2026-04-30-web-remote-design.md`) AND the consolidated `v0.3-design.md` exist in the tree, yet 7 `frag-*.md` files (1700+ lines combined) still sit under `v0.3-fragments/`. They are a guaranteed source of future drift — every spec edit risks updating one but not the other. **Action:** delete the entire `docs/superpowers/specs/v0.3-fragments/` directory now that consolidation is done.

### H4. README "preload.ts" path still wrong (carry-over from 2026-04-30)
File: `README.md:83`

> ... exposed via `electron/preload.ts`.

Actual: `electron/preload/index.ts` + `electron/preload/bridges/{ccsmCore,ccsmNotify,ccsmPty,ccsmSession,ccsmSessionTitles}.ts`. Same drift was flagged 04-30 (H3), still not fixed. mvp-design.md:280 has the same wording (`preload.ts`'s equivalent). **Action:** update both files in lockstep.

### H5. README "Settings → Notifications" is the wrong tab for crash-report opt-out
File: `README.md:66`

> To disable after opting in: open Settings → Notifications and uncheck "Send crash reports to developer".

The toggle is real — `src/components/settings/UpdatesPane.tsx:122-183` (`crashReportingOptOut` key, label `crashReporting.label`) — but lives in the **Updates** tab, not Notifications. `NotificationsPane.tsx` has zero `crash`/`Sentry` references. (The 04-30 audit said the toggle didn't exist; it now does, just in a different tab.) **Action:** "Settings → Updates → Send crash reports to developer".

### H6. RELEASE_NOTES still uses the old "Agentory" name (carry-over from 2026-04-30)
File: `RELEASE_NOTES_v0.1.0.md:1, 6, 33, 41`

Four occurrences of "Agentory". Everywhere else (README.md, package.json `productName: "CCSM"`, `appId: "com.ccsm.app"`, all docs) the product is CCSM. **Action:** global rename to CCSM in this file.

---

## MED

### M1. mvp-design §2 still describes an architecture the codebase doesn't have (carry-over)
File: `docs/mvp-design.md:19, 23, 28`

- Line 19: *"Claude Agent SDK (main process) ... custom React renderer (no xterm)"* — backend is the CLI; renderer IS xterm.js (`@xterm/xterm` + 6 addons, `src/terminal/xtermSingleton.ts`).
- Line 23: *"clean iframe-based hosting of the Claude CLI via a bundled ttyd terminal sidecar"* — no ttyd anywhere; only stale screenshot dir `docs/screenshots/fix-ttyd-windows-spawn/`.
- Line 28 (§3 In scope): *"Claude Code (Agent SDK)"* — same SDK fiction.

Same drifts flagged 2026-04-30 H1+H2; document is "frozen" but is actively misleading. **Action:** unfreeze long enough to rewrite §2 + §3.1; the "design wins when it conflicts with implementation" rule in STATUS.md amplifies this since the false design is treated as authoritative.

### M2. Settings tabs still don't match mvp-design §8 (carry-over, partly different)
mvp-design §8 lists tabs: General / Account / Data / Shortcuts / Updates.
Actual (`src/components/SettingsDialog.tsx:13`): `'appearance' | 'notifications' | 'updates'` — three panes (`AppearancePane`, `NotificationsPane`, `UpdatesPane`). **Connection** tab from the prior audit was removed too. **Action:** rewrite §8 to match the 3-tab reality, drop Account/Data/Shortcuts (Shortcuts is now a separate `ShortcutOverlay`).

### M3. AskUserQuestion described as a feature, no implementation in `electron/` (carry-over)
README:108 + RELEASE_NOTES:13 promise `AskUserQuestion` handling. Grep across `electron/` returns **zero** matches. Across `src/` only one match: `src/components/ui/Dialog.tsx` (an aria comment). The "question" message kind is rendered in `chat/renderBlock.tsx`, but no IPC bridge / handler under that name. **Action:** either grep for whatever the actual feature is now and rename the docs, or remove the prose.

### M4. RELEASE_NOTES claims "message queue" + "slash command autocomplete" shipped (carry-over)
File: `RELEASE_NOTES_v0.1.0.md:13`

> CLI-style composer: ... message queue while the agent is busy ... slash commands loaded from disk

Reality:
- Message queue: zero matches under `src/` for `messageQueue|MessageQueue`.
- Slash commands: only the `/clear` `/compact` strings appear in `src/i18n/locales/{en,zh}.ts` — no `slashCommandLoader` / `loadSlashCommand` / `~/.claude/commands` reading code in `src/`.
- mvp-design §12 still lists both as **Out of MVP** — direct contradiction with RELEASE_NOTES.

**Action:** strike both bullets from RELEASE_NOTES, OR confirm they shipped under different names and adjust mvp-design.

### M5. docs/README.md points at non-existent dogfood files (carry-over)
File: `docs/README.md:18-19`

- `dogfood/r2/fp{8..13}-report.md` — only `fp11-report.md` exists at `docs/dogfood/r2/`. Reports `fp8/fp9/fp10/fp12/fp13` are under `docs/archive/r2-dogfood/`.
- `dogfood/r2/report-2026-04-21.md` — does not exist (the archive copy is at `docs/archive/r2-dogfood/report-2026-04-21.md`).

**Action:** move bullets to "Archived dogfood" or rewrite to point at `docs/archive/r2-dogfood/`.

### M6. mvp-design references docs/triage.md that doesn't exist (carry-over)
File: `docs/mvp-design.md:226` (line drifted from :233). **Action:** retire §13 or repoint at `docs/status/post-migration-gap-triage-2026-04-24.md`.

### M7. post-migration-gap-triage references its source doc, which is gone
File: `docs/status/post-migration-gap-triage-2026-04-24.md:3`

> Triage of `docs/post-migration-gap-analysis.md` (dated 2026-04-21)...

`docs/post-migration-gap-analysis.md` doesn't exist (this triage doc itself notes it should be deleted, but the source reference is now a dangling pointer too). **Action:** archive the triage doc to `docs/archive/` since the source it triages is gone.

### M8. Still no CHANGELOG; user-facing changes since v0.1.0 are invisible
Last 20 merged PRs (#636..#655) are all v0.3 daemon-split internal refactor — no user-visible change since RELEASE_NOTES, so this is lower urgency than the 04-30 framing, BUT the gap covers everything between v0.1.0 (~2026-04-22) and the 30 PRs flagged 04-30 (security tightening, Electron 33→41, `CLAUDE_CONFIG_DIR` override fix, boot-time icon flash). **Action:** start `CHANGELOG.md` (Keep-a-Changelog) covering #562–#637 user-facing changes; daemon-split (#638+) can wait until v0.3 ships.

### M9. README + mvp-design shortcut lists don't match the implementation
- README:45-48 lists 4 shortcuts: `Cmd/Ctrl+F`, `Cmd/Ctrl+,`, `Cmd/Ctrl+N`, `Cmd/Ctrl+Shift+N`.
- mvp-design.md:191-197 lists 7 (adds Enter / Shift+Enter / Esc).
- `src/components/ShortcutOverlay.tsx:22-53` (the user-visible source of truth) lists: Enter, Shift+Enter, **Esc (interrupt)**, **Esc (dismiss picker)**, Ctrl+Shift+N, Ctrl+F, Ctrl+,, **? / Ctrl+/ (overlay)**.
- `src/app-effects/useShortcutHandlers.ts` confirms Ctrl+/ + ? + Ctrl+F + Ctrl+,.
- Grep for `Cmd+N` / `key === 'n'` (excluding Shift+N) under `src/`: **zero matches** — Cmd+N (New Session) is documented twice, never bound.

**Action:** (a) bind Cmd+N or remove from both docs, (b) add Ctrl+/, ?, Esc to both docs.

---

## LOW

### L1. CONTRIBUTING.md still bare, but slightly different than 04-30
File now has 16 lines (Node 20, VS Build Tools, debug-inspect env var). Still no PR conventions, no test/lint expectations, no link to README's Development section, no `scripts/sync-pool.sh` mention. **Action:** flesh out or link to README §Development.

### L2. README L70 — `electron-builder install-app-deps` mentioned directly (carry-over)
Actual `package.json` `postinstall` runs `node scripts/postinstall.mjs`. Misleading. **Action:** "via `npm run postinstall` (wraps `electron-builder install-app-deps`)".

### L3. docs/README.md L22 — `feedback_screenshots_subdir_per_pr` ref still cryptic (carry-over)
Convention lives in MEMORY.md (user memory), not in any repo doc. **Action:** drop the suffix or inline the rule ("one subdir per PR").

### L4. README L5 — `<!-- TODO: screenshot here -->` placeholder
Single TODO marker in the publicly-visible README. **Action:** drop the placeholder or actually add a screenshot.

### L5. STATUS.md "P0/P1/P2 gap table" — every item is shipped or stale
Even if H1 is rejected, at minimum these checkbox lines should be struck: markdown rendering (P0), tool result wiring (P0), auto-scroll (P0), import scanner (P1), state-change toast (P1), Cmd+N (P1, but see M9 — actually never bound), waiting indicator (P2), electron-updater (P2), tests (P2).

### L6. design-system.md not audited deeply
File exists at `docs/design-system.md`; not opened beyond name check. Tailwind v4 token table likely needs spot-check vs `src/styles/global.css` if/when someone touches design tokens.

---

## TODO/FIXME/WIP/pending markers in markdown

Counts (excluding `audit-2026-04-30-*.md` to avoid recursion):

| Marker | Count | Files |
|---|---|---|
| TODO | 5 | `README.md` (1 user-facing screenshot placeholder), `docs/status/post-migration-gap-triage-2026-04-24.md` (1), `docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md` (1, "intentional"), `docs/superpowers/specs/v0.3-design.md` (1, "Documented as TODO not blocking"), `docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md` (1, dup of design.md) |
| FIXME / XXX / WIP | 0 | — |
| pending | 14 | `docs/reference/journey-streaming-expectations.md` (1), `docs/reference/ui-ux-pro-max-audit-2026-04-24-wave2.md` (1), `docs/status/STATUS.md` (2 — both stale per H1), `docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md` (1, scoped wording), `docs/superpowers/specs/v0.3-design.md` (7, mostly state-machine vocabulary), `docs/superpowers/specs/v0.3-fragments/{frag-12,frag-3.4.1,frag-3.5.1,frag-6-7}.md` (4 dup of design.md — see H3) |

Most v0.3 spec "pending"s are domain vocabulary (`migrationState: 'pending'`), not work markers. The two unique action-item markers are the `STATUS.md:96, 111` ones — both fall under H1.

---

## Suggested fix order (by ROI)

1. **H4 + H5 + H6** — three text edits in README + RELEASE_NOTES, all user-visible, ~5 min.
2. **H3** — `git rm -r docs/superpowers/specs/v0.3-fragments/` (single delete, prevents future drift).
3. **H2** — one-line link fix in roadmap.md.
4. **H1** — delete or repoint STATUS.md (10 min decision: retire or rewrite).
5. **M1 + M2 + M9** — single PR rewriting mvp-design §2/§3/§8/§11 to match reality.
6. **M5 + M6 + M7** — 5-min cleanup of dangling doc paths.
7. **M4** — decide message-queue / slash-loader RELEASE_NOTES fate (depends on whether they exist under different names).
8. **M8** — start CHANGELOG.md.

## Counts summary

- Total markdown files audited: 44 (40 in `docs/`, 4 at root)
- HIGH findings: 6 (4 carry-over from 2026-04-30, 2 new: H1 STATUS.md, H2 roadmap.md, H3 v0.3-fragments stale dir is also new)
- MED findings: 9 (6 carry-over, 3 new: M7, M8 reframe, M9)
- LOW findings: 6 (3 carry-over, 3 new: L4 TODO, L5 STATUS gap table, L6 design-system not audited)
- Carry-over rate from 04-30: 9/13 prior findings unfixed (69%)
- TODO markers in non-audit md: 5
- "pending" markers: 14 (mostly v0.3 spec vocabulary; 2 actionable, both under H1)
