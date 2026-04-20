# Implementation Status

Last updated: 2026-04-20 (after PR #18)

This file is the reconciliation table for what's actually implemented in agentory-next. Every PR that lands MUST update this file so "done vs. not done" stays unambiguous.

`docs/mvp-design.md` is the single source of truth for the design. This file is the implementation status. When the two conflict, the design wins (unless the design is being explicitly updated).

## Legend

- ✅ Shipped, wired to real data / real behavior
- 🟡 UI is in place, but backed by mock data or `/* wire to store later */` stub
- ⬜ Not implemented
- 🚫 Explicitly out of scope (see `mvp-design.md` §12)

## 1. Architecture layer

| Item | Status | Notes |
|---|---|---|
| Electron shell (main + preload) | ✅ | `electron/main.ts` boots a single window. |
| React 18 + TS + Tailwind v4 | ✅ | webpack 5 dev server on port 4100; Tailwind v4 CSS-based config via `@import "tailwindcss"` (no `tailwind.config.js`). |
| Hand-rolled Radix-based ui/ primitives | ✅ | Dialog / DropdownMenu / ContextMenu / Tooltip / Toast / ConfirmDialog / Button / IconButton / InlineRename / StateGlyph. |
| framer-motion / lucide-react / @dnd-kit | ✅ | Installed and used in Sidebar. |
| Zustand store | ✅ | `src/stores/store.ts` holds sessions/groups/recentProjects/UI state + actions; consumed across the app. |
| better-sqlite3 persistence | 🟡 | `electron/db.ts` opens with WAL, single `app_state(key,value)` table; `db:load`/`db:save` IPC + preload bridge; renderer hydrates on boot, debounced 250ms write-back. Schema is a single JSON blob; structured schema is post-MVP. |
| Claude Agent SDK integration | ✅ | Main process: `electron/agent/sessions.ts` (`SessionRunner` with streaming-input AsyncIterable) + `electron/agent/manager.ts` (singleton registry); IPC: `agent:start/send/interrupt/setPermissionMode/setModel/close/resolvePermission` + push events `agent:event` / `agent:exit` / `agent:permissionRequest`; preload + global.d.ts extended; API key injected into the SDK env in main process (never crosses renderer); ChatStream + InputBar consume real events; canUseTool round-trips through WaitingBlock. |
| `~/.claude/projects/` import | ⬜ | |
| Global shortcut registration | ✅ | `App.tsx` registers Cmd+K / Cmd+, / Cmd+B / Cmd+N (new session) / Cmd+Shift+N (new group). |

## 2. Sidebar (`src/components/Sidebar.tsx`)

| Item | Status | Notes |
|---|---|---|
| Top New Session + Search buttons | ✅ | Real triggers — createSession / open palette. |
| Groups list rendering | ✅ | Data sourced from store. |
| Group collapse/expand + chevron rotation | ✅ | Collapsed flag persisted via store. |
| Drag-reorder sessions + cross-group migration | ✅ | @dnd-kit + `moveSession`. |
| Session active 3px accent vertical bar | ✅ | framer-motion enter animation. |
| Session waiting indicator | ✅ | Session row uses an oklch amber breathing halo on the AgentIcon (1.6s framer-motion loop) — matches `mvp-design.md` §5. Group row shows a small amber dot when any child session is waiting. |
| Session right-click Rename | ✅ | InlineRename commit → `renameSession`. |
| Session right-click Move to group | ✅ | Submenu lists normal groups → `moveSession`; "New group…" creates then moves. |
| Session right-click Delete | ✅ | ConfirmDialog → `deleteSession`. |
| Group right-click Rename | ✅ | InlineRename commit → `renameGroup`. |
| Group right-click Archive/Unarchive | ✅ | `archiveGroup` / `unarchiveGroup`. |
| Group right-click Delete | ✅ | ConfirmDialog → `deleteGroup` (cascades to its sessions). |
| "+ New Group" button | ✅ | onClick → `createGroup()`. |
| Archived Groups bottom collapsible block | ✅ | UI in place, real data. |
| Sidebar collapse (256↔48) | ✅ | Cmd/Ctrl+B toggles, framer-motion 220ms width animation; collapsed mode shows expand/new/search/settings IconButtons; persisted to SQLite. |

## 3. ChatStream (`src/components/ChatStream.tsx`)

| Item | Status | Notes |
|---|---|---|
| Block rendering scaffolding (user / assistant / tool / waiting / error) | 🟡 | All five block kinds render. Data flows from store `messagesBySession[activeId]`, written by `src/agent/lifecycle.ts` subscribing to `agent:event` / `agent:exit` and translated by `sdk-to-blocks.ts`. **Assistant text is currently raw `<span>` with no markdown — code blocks, lists, inline code all render as plain text.** |
| Tool call collapse/expand | 🟡 | Chevron + framer-motion expand animation work, but **the tool block always shows "(no captured output yet)"** because `sdk-to-blocks.ts` does not associate tool_use with its later tool_result. Result wiring is the P0 gap. |
| Waiting block Allow/Deny buttons | ✅ | PR #18: full canUseTool round-trip (main → IPC event → renderer waiting block → user click → store action → IPC back → resolves SDK Promise). Esc denies (top-of-stack only). |
| Auto-scroll to bottom + "↓ Jump to latest" | ⬜ | `mvp-design.md` §7 Q4. |

## 4. InputBar (`src/components/InputBar.tsx`)

| Item | Status | Notes |
|---|---|---|
| Multi-line textarea + Enter send / Shift+Enter newline | ✅ | Input capture + whitespace check + IME guard; first send lazy-calls `agent:start` (with current cwd/model/permission), subsequent sends go through `agent:send`. Local echo of the user block; SDK's user echo is skipped in the translator to avoid duplicates. |
| Running disabled + Stop button | ✅ | `runningSessions` lives in the store; during a turn the textarea is disabled and Send becomes Stop (calls `agent:interrupt`); SDK `result` message or `agent:exit` clears running. |

## 5. StatusBar (`src/components/StatusBar.tsx`)

| Item | Status | Notes |
|---|---|---|
| cwd / model / permission ChipMenu | ✅ | Three chips, all driven by store. |
| recentProjects + Browse folder | ✅ | PR #14: real `pickDirectory` IPC + recentProjects persisted to store. |
| Token progress footer | 🚫 | PR #15 dropped the fake "12k / 200k tokens · 6% used" string. Real token counting is post-MVP. |
| Live model / permission push | ✅ | PR #17: changing model or permission pushes to all started sessions via `agent:setModel` / `agent:setPermissionMode`. |

## 6. SettingsDialog (`src/components/SettingsDialog.tsx`)

| Item | Status | Notes |
|---|---|---|
| Modal scaffolding + grouped tabs | ✅ | Tabs switch correctly. |
| Theme toggle | ✅ | `theme: system|light|dark` persisted; App.tsx watches `prefers-color-scheme` and toggles `<html>.dark`. |
| Anthropic API key (safeStorage) | ✅ | `keychain:get/setApiKey` IPC + Electron `safeStorage`; encrypted file in userData; input disabled when encryption is unavailable. |
| Data dir display | ✅ | `app:getDataDir` IPC returns real `app.getPath('userData')`. |
| Shortcuts read-only list | ✅ | Static catalog; matches "MVP does not allow remap". |
| Updates "Check for updates" | 🟡 | Version pulled from real package.json via `app:getVersion`; button is disabled pending the electron-updater PR. |

## 7. CommandPalette (`src/components/CommandPalette.tsx`)

| Item | Status | Notes |
|---|---|---|
| Cmd+K to open | ✅ | App.tsx global keydown. |
| Sessions / Groups / Commands tri-search | ✅ | Data from store; commands fully wired: New session / New group / Toggle sidebar / Open settings / Switch theme (cycles system→dark→light). |

## 8. Toast (`src/components/ui/Toast.tsx`)

| Item | Status | Notes |
|---|---|---|
| ToastProvider mounted | ✅ | |
| Real triggers: state change / SDK error / API key missing | 🟡 | Persist write failure already wired to a toast (5s throttled). Background-session permission requests now toast (`<session> needs your input`) via the lifecycle → `setBackgroundWaitingHandler` bridge. SDK crash + API key missing still pending. |

## 9. Persistence (mvp-design.md §10)

| Item | Status |
|---|---|
| SQLite schema (groups / sessions / ui_state) | 🟡 single JSON blob; not normalized |
| Boot scan of `~/.claude/projects/` | ⬜ |
| API key keychain storage | ✅ |

## 10. Other

| Item | Status |
|---|---|
| Onboarding first run (Create / Import) | 🟡 PR #16 ships a "no sessions yet" empty state with a Create CTA; Import CTA waits on the import scanner. |
| Tests (vitest / playwright) | ⬜ |
| Auto-update (electron-updater) | ⬜ |

## MVP gap table (P0 / P1 / P2)

| Priority | Item | Why it blocks "daily-self-use beats raw CLI" |
|---|---|---|
| **P0** | Markdown rendering for assistant text | Today every reply is raw whitespace-pre-wrap; code blocks and lists are unreadable. Without this, the user's "no reply" complaint stays valid even though replies ARE arriving. |
| **P0** | Tool result wiring (`tool_use_id` → `tool_result` fold-in) | Tool block currently always says "(no captured output yet)". No way to see what `Read` / `Bash` / `Grep` actually returned. |
| **P0** | Auto-scroll + "↓ Jump to latest" | Long replies disappear off-screen mid-stream because nothing follows the tail. |
| P1 | `~/.claude/projects/` import scanner | User has 160+ historical sessions in the old setup. Without import, the new app starts empty. (Per user 2026-04-20: starting empty is acceptable for now — deferring.) |
| P1 | ~~Session state change → Toast~~ | ✅ Done in PR #22. Background sessions entering waiting now toast. |
| P1 | ~~Cmd+N / Cmd+Shift+N shortcuts~~ | ✅ Done in PR #22. |
| P2 | ~~Waiting indicator: oklch amber breathing glow~~ | ✅ Already shipped on session row (`AgentIcon` 1.6s halo). Group row dot was red, now amber too (PR #23). |
| P2 | electron-updater wiring | Required before public-ish builds; not for self-use. |
| P2 | Tests (vitest + playwright) | Should land before any external user. |

## PR roadmap

PRs land into `working`, then `working` → `main` via release-tag CI. See git log for the most recent landings.

Most recent landings (newest first):
- PR #22 — P1 state toast on background sessions + Cmd+N / Cmd+Shift+N shortcuts
- PR #21 — ChatStream P0: markdown + tool result wiring + auto-scroll
- PR #20 — docs: fix Tailwind version (v4, not v3)
- PR #19 — doc realignment (translate to English, fix drifts, update status)
- PR #18 — wire canUseTool through IPC to WaitingBlock
- PR #17 — push model / permission changes to all started sessions
- PR #16 — drop mock seed, render real first-run empty state
- PR #15 — drop fake token-counter footer
- PR #14 — StatusBar cwd chip: real folder picker + persisted recentProjects
- PR #13 — hotfix: ESM lazy-load + ChatStream infinite rerender
- PR #12 — InputBar wired to agent send / interrupt + running state
- PR #11 — ChatStream wired to live session message stream
- PR #10 — Claude Agent SDK integration (main process)
