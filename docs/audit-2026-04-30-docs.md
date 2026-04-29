# Daily audit D2: doc-code consistency — 2026-04-30

**Pool:** `~/ccsm-worktrees/pool-8` @ `46bcecc` (origin/working).

## HIGH

### H1. mvp-design.md §2 names tech the codebase does not use
File: `docs/mvp-design.md:19`

> Electron · React 18 · ... · **Claude Agent SDK (main process)** · ... · **custom React renderer (no xterm)** · ...

Reality:
- Backend uses the **CLI** (spawned via node-pty / `claudeResolver.ts`), not the Agent SDK. README, `RELEASE_NOTES_v0.1.0.md`, and `electron/ptyHost/claudeResolver.ts` confirm this. `@anthropic-ai/claude-agent-sdk` is in `package.json` but only `electron/sessionTitles/` references it (for jsonl post-processing).
- The terminal IS **xterm.js**: `@xterm/xterm`, `@xterm/headless`, six `@xterm/addon-*` packages; `src/terminal/xtermSingleton.ts`, `useXtermSingleton.ts`, `TerminalPane.tsx` all wire xterm to a node-pty PTY in main.

**Action:** rewrite §2 to "node-pty + xterm.js, hosting the Claude CLI directly. Agent SDK used only for jsonl session-title backfill." Drop the "no xterm" claim.

### H2. mvp-design.md §2 still references the abandoned ttyd architecture
File: `docs/mvp-design.md:23`

> ... clean iframe-based hosting of the Claude CLI via a bundled ttyd terminal sidecar.

There is no ttyd sidecar; only stale screenshot dirs (`docs/screenshots/fix-ttyd-windows-spawn/`) and `.gitignore` entries reference it. **Action:** replace or delete.

### H3. README points at a file that no longer exists
File: `README.md:84` and `docs/mvp-design.md:287`

> ... exposed via `electron/preload.ts`. ...

After PR #572 the file is `electron/preload/index.ts` plus `electron/preload/bridges/{ccsmCore,ccsmNotify,ccsmPty,ccsmSession,ccsmSessionTitles}.ts`. **Action:** change to `electron/preload/index.ts (+ bridges/)`.

### H4. README crash-report toggle path is wrong
File: `README.md:67,120-123`

> To disable after opting in: open **Settings → Notifications** and uncheck "Send crash reports to developer".

`src/components/settings/NotificationsPane.tsx` contains no `crash`/`Sentry`/`Send …` toggle. The opt-out described is not wired; the only Sentry gate is `SENTRY_DSN` env. **Action:** either implement the toggle or fix README to "disable by unsetting `SENTRY_DSN`".

### H5. Branding mismatch: "Agentory" vs "CCSM"
File: `RELEASE_NOTES_v0.1.0.md:1`

> # **Agentory** v0.1.0 — Internal Release ...

Everywhere else (README, package.json `productName: "CCSM"`, `appId: "com.ccsm.app"`, docs/) the product is "CCSM". The release-notes file is the only file using the old name. **Action:** global rename to CCSM.

## MED

### M1. mvp-design "Out of MVP" list contradicts shipped features (per RELEASE_NOTES)
`docs/mvp-design.md:212-223` lists "Message queue", "Slash command autocomplete", "Soft-delete + Deleted view" as out-of-MVP. `RELEASE_NOTES_v0.1.0.md:13,14,17` claims all three shipped.

Code reality:
- "soft-delete with undo": REAL (`src/stores/slices/sessionCrudSlice.ts`, `GroupRow.tsx`, `appLifecycle.ts`).
- "message queue": NOT IMPLEMENTED (no `messageQueue`/queue impl found). Stale claim in RELEASE_NOTES.
- "slash command loader": NOT IMPLEMENTED (no `slashCommand|loadSlashCommand` matches under `src/`). Stale claim.

**Action:** (a) Update mvp-design §12 to remove "Soft-delete + Deleted view". (b) Strike message-queue + slash-loader bullets from RELEASE_NOTES, OR implement them.

### M2. Settings tabs don't match mvp-design §8
mvp-design §8 lists tabs: General / Account / Data / Shortcuts / Updates.
Actual (`SettingsDialog.tsx:14`): **Appearance / Notifications / Connection / Updates**. **Action:** rewrite §8.

### M3. AskUserQuestion mentioned everywhere, no implementation
README:109 + RELEASE_NOTES:13 promise "the agent invoked `AskUserQuestion`" handling. Grep finds the literal only in docs and `src/components/ui/Dialog.tsx` (aria comment). No bridge / IPC / handler. **Action:** wire it up or remove the prose.

### M4. docs/README.md points at non-existent files
File: `docs/README.md:18-19`

- `dogfood/r2/fp{8..13}-report.md` — only `fp11-report.md` exists.
- `dogfood/r2/report-2026-04-21.md` — does not exist.

**Action:** rewrite to list only present files or move stale bullets to "Archived dogfood".

### M5. mvp-design references docs/triage.md that doesn't exist
File: `docs/mvp-design.md:233` — `docs/triage.md` does not exist. **Action:** remove §13 or point at `docs/status/post-migration-gap-triage-2026-04-24.md`.

### M6. Recent merged-PR drift vs RELEASE_NOTES (and absent CHANGELOG)
`RELEASE_NOTES_v0.1.0.md` last edited ~2026-04-22; PRs #562–#591 (30 most-recent merges) include user-facing changes not reflected anywhere user-visible:
- #582 Electron 33→41 + better-sqlite3
- #585 security tightening (isSafePath / sid / nav-allowlist)
- #588 fixed `CLAUDE_CONFIG_DIR` override bug (user-facing env var)
- #570 boot-time icon flash fix

No CHANGELOG.md exists. **Action:** start `CHANGELOG.md` (Keep-a-Changelog) or add "Since v0.1.0" section to RELEASE_NOTES.

## LOW

### L1. CONTRIBUTING.md is bare
Six lines (Node 20 + VS Build Tools note). No npm scripts, no PR conventions, no test/lint expectations. **Action:** link to README's Development section + scripts list, document `scripts/sync-pool.sh`.

### L2. README "Sentry init logs a single informational line" — verify against `electron/sentry/init.ts`.

### L3. README mentions `electron-builder install-app-deps` directly
README:71 — actual `package.json` `postinstall` runs `node scripts/postinstall.mjs`. Misleading. **Action:** "via `npm run postinstall` (wraps `electron-builder install-app-deps`)".

### L4. README "Architecture rule" cross-link to mvp-design.md §15 — also points at `preload.ts` (see H3). Fix in lockstep.

### L5. Orphaned policy ref: `docs/screenshots/{topic-or-pr}/ — per feedback_screenshots_subdir_per_pr` (`docs/README.md:22`)
Search for `feedback_screenshots_subdir_per_pr` returns no doc defining the convention. **Action:** drop the cryptic suffix or link to where the convention is set.

### L6. CTRL+/ shortcut, font-size segmentation, model picker — features in code, not in §11 shortcut list
`src/app-effects/useShortcutHandlers.ts`, `ShortcutOverlay.tsx`, `modelPickerSlice.ts` indicate features beyond the 8 documented. Worth a sweep.

---

## Suggested fix order (by ROI)

1. **H3 + H4 + H5** (5-min text edits in README + RELEASE_NOTES) — user-facing, shipping today.
2. **H1 + H2 + M2** (rewrite mvp-design §2 §8) — single source of truth lying about the stack.
3. **M1** (decide: implement queue/slash-loader, or stop advertising them).
4. **M4 + M5 + L5** (10-min cleanup of orphaned doc paths).
5. **M6** (start a real CHANGELOG.md).
6. **H4 properly** — implement Sentry opt-out toggle.
