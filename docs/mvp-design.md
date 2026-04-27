# CCSM MVP Design

Frozen: 2026-04-18 (last realignment: 2026-04-20)
Status: MVP design locked — single source of truth before scaffolding.

## 1. Positioning & Principles

- **Core differentiator**: group-first / repo-agnostic. A group is a user-defined task/domain container; the repo is just metadata on a session.
- **Success metric**: author uses it daily for 30 consecutive days and prefers it to raw CLI. Friends are not in the KPI.
- **Hard deadline**: 8 weeks to daily-self-use.
- **Design principles**:
  - CLI visual + GUI interaction (see MEMORY).
  - Don't invent state users won't maintain.
  - Don't constrain the user. Reversible by default.
  - State is derived from system signals first.

## 2. Tech stack (locked)

Electron · React 18 · TypeScript · Tailwind v4 (CSS-based config, `@import "tailwindcss"` in `src/styles/global.css`) · hand-rolled Radix primitives (`src/components/ui/`) · framer-motion · Zustand · @dnd-kit · Claude Agent SDK (main process) · SQLite (better-sqlite3) · custom React renderer (no xterm) · Vitest · Playwright.

> Not using shadcn/ui: shell wrapper is ~30 lines, shadcn's high-value components (Dialog/Command/Form) don't cover this project's GUI-style rendering needs, and token mapping cost (`--sidebar-*` ↔ `bg-bg-sidebar`) is high. Build directly on Radix primitives instead.

> Tauri 2 → Electron: pure shell choice. Visual/interaction is decided by React+Tailwind, independent of the shell. Electron chosen for mature ecosystem, smaller surface area for problems, and in-process integration of the Node SDK.

## 3. MVP Scope

In:
1. Claude Code (Agent SDK)
2. Custom groups
3. Two-state lifecycle: idle / waiting (see §4)
4. Cross-repo sessions inside one group
5. CLI-visual-style structured rendering of the conversation stream
6. Import: scan `~/.claude/projects/` for historical sessions
7. Global search / Command Palette (Cmd/Ctrl+F)
8. Settings (API key, data dir, theme, font, shortcuts, auto-update)
9. Sidebar collapse
10. Session right-click menu (rename + move-to-group + delete) — operate inline in the sidebar; no standalone Session header
11. Toast notifications (state changes, errors)
12. Status bar (cwd + model + permission)
13. Auto-update check (inside Settings)
14. Onboarding first run: MVP simplifies to "when no session exists, the ChatStream area shows large Create / Import buttons" (see §5)

Out: Codex / Gemini adapters, IM bridge, server mode, MCP marketplace, mobile, team features, message queue, tabs/split-view, account area, slash command autocomplete, multi-agent.

## 4. State machine

Two states: `idle` · `waiting` (needs user input). Only waiting alerts on the UI (breathing glow); idle is the static default.

Legal transitions:
```
┌─────────┐  agent stops, awaits  ┌─────────┐
│  idle   │ ────────────────────▶ │ waiting │
│ (static)│                       │(breathe)│
│         │ ◀──────────────────── │         │
└─────────┘  user clicks session  └─────────┘
```

Design intent:
- **No explicit "park"**. Switching away from a session without replying is implicit park — no maintenance, no button.
- **No "running"**. Whether the SDK is currently executing is not a user decision axis; it's an internal SDK detail. The user only cares "does this session need me?"
- **Click = acknowledged**: clicking a waiting session immediately drops it back to idle and stops the breathing glow.

Edge cases:
- SDK crash / process exit → set to waiting, append `[session interrupted]` marker at the tail of the conversation stream.
- User sends input while in waiting state → SDK `query({ resume: sessionId })` to restore context.
- Delete session: single generic confirm dialog, regardless of state.

## 5. Sidebar layout

Two-column layout, expandable tree on the left. Visually minimal: no section borders, no section labels, regions separated naturally by whitespace + color hierarchy.

```
CCSM                    [«]
[🔍 Search…            ⌘F]
[+  New Session]

▾ Group A                  [+]
    session 1
  • session 2              ← waiting: status dot
▾ Group B                  [+]
    session 3
+ New group                        ← quiet row, end of nav

▸ Archived Groups                  ← bottom pinned collapsible block
[⚙ Settings]
```

**Locked decisions (do not relitigate)**

- **No section visuals**: no `border-t` / section header / background-color blocks. Hierarchy via weight + color + whitespace.
- **Archive as a bottom pinned collapsible block**: positioned at the end of the nav, above Settings, collapsed by default. MVP does NOT ship a Deleted view (delete is a hard delete; soft-delete + Deleted view is post-MVP).
- **High-frequency vs low-frequency action layering**:
  - Top: Search (⌘F), New Session — daily.
  - In nav: group list, New group (quiet row, weekly).
  - Bottom: Archived Groups block, Settings — monthly or rarer.
- **Group row**: chevron toggles collapse; `[+]` shows on hover at the right; collapsed group shows total session count.
- **Session row**: agent icon + name; active sessions get a 3px accent vertical bar on the left; waiting sessions get an oklch amber breathing halo on the AgentIcon (framer-motion, 1.6s loop). The group row shows a small amber dot when any child session is waiting.
- **Session ordering inside a group**: user-defined drag order (array order is the truth). Do NOT auto-sort by state.
- **Drag & drop**: `@dnd-kit`, full-row draggable, `activationConstraint: { distance: 6px }`. Supports reordering within a group + cross-group migration (changes both `groupId` and position). DragOverlay is a clone of the original row, no tilt; original opacity 0.4.
- **Right-click menus**:
  - Session: Rename / Move to group ▾ / Delete
  - Group: Rename / Delete
- **Rename**: inline edit; Enter commits / Esc cancels.
- **No unpark button**: there is no park state, so no unpark is needed. Switching back to the session IS coming back.
- **First launch**: only "Create your first session" / "Import session" entry points.
- **No group → create session**: auto-create a default group.

### 5.1 Sidebar collapse (implementation locked)

- Expanded width `256px` / collapsed width `48px`.
- Transition: `framer-motion` width animation, 220ms, `cubic-bezier(0.32, 0.72, 0, 1)`.
- Three equivalent collapse triggers:
  1. Top `[«]` / `[»]` IconButton
  2. `⌘B` / `Ctrl+B` global shortcut
  3. Right-edge 1.5px clickable rail (1px accent hairline shows on hover)
- **Do not migrate to shadcn Sidebar**: the wrapper is ~30 lines; shadcn's value (Dialog/Command/Form etc.) is low-ROI here and adds token-mapping cognitive load (`--sidebar-*` ↔ `bg-bg-sidebar`). Internal `GroupRow` / `SessionRow` are CCSM-specific UI (rollup, state glyphs, cwdTail) — no library helps; keep hand-rolled.
- Collapsed state persisted locally (SQLite).

### 5.2 Archive behavior

- Archive a group: every session inside is frozen, read-only, non-interactive.
- Archive area lives in the sidebar's bottom pinned collapsible block; expand it to see all archived groups.
- Unarchive via the archived group's right-click menu.
- MVP does NOT ship Deleted view: delete = hard delete (already gated by ConfirmDialog). Soft-delete + restore is post-MVP.

## 6. Global search / Command Palette

- Single entry: Cmd/Ctrl+F, or click the sidebar top search box.
- Single popover, mixed results:
  - Sessions (fuzzy match on name, group, cwd)
  - Groups
  - Commands (New session / New group / Toggle sidebar / Open settings / Switch theme)
- Enter to navigate / execute; Esc to close.
- No full-text search inside conversation content (out of MVP — jsonl volume unknown, avoid the perf rabbit hole).

## 7. Right-pane conversation stream

5 rendering rules (CLI visual style). No session header — pure conversation stream; bottom is fixed status bar + input area. The current session is indicated by sidebar highlight.

### Q1 Message block style
- Monospace font, no bubble, no background color, no rounded corners.
- Left-side identifier: `>` user · `●` assistant · `⏺` tool.
- Blocks are separated by a single empty line.

### Q2 Tool calls
- `⏺` collapsed by default to one line: `⏺ Read(file.ts)` / `⏺ Bash(npm test)`.
- Click to expand the parameters + result.

### Q3 Input area
- Bottom-fixed multi-line textarea.
- **Enter to send, Shift+Enter for newline** (matches the user's CLI habit).
- When the agent is running, the textarea is disabled and a Stop button shows.
- MVP does not implement a queue.

### Q4 Scrolling
- Auto-follow to bottom by default.
- After the user manually scrolls up, follow stops and a "↓ Jump to latest" button appears.
- Click the button or send a new message to resume follow.

### Q5 Waiting indicator
- A highlighted block is appended to the tail of the conversation stream, with action buttons:
  - permission → Allow / Deny
  - plan approval → Approve / Reject
  - generic question → focus the input box
- The corresponding session row in the sidebar shows the waiting indicator in sync.

### Status bar
- A single dim-text line directly above the input box: `cwd: <path>  ·  model: <claude-...>`.
- Derived from SDK / session metadata; not user-maintained.

## 8. Settings

Opened via the sidebar bottom ⚙ or Cmd/Ctrl+,. Modal popover, grouped:
- General: theme (system / light / dark), font family, font size.
- Account: Anthropic API key (local storage, plaintext acceptable for MVP single-user).
- Data: data dir path (display, not editable in MVP — avoid migration pain), `~/.claude/projects/` path (read-only display).
- Shortcuts: list of all shortcuts (read-only in MVP — remapping = maintenance burden).
- Updates: current version + "Check for updates" button (electron-updater, manual trigger, no silent background).

## 9. Toast notifications

bottom-right, auto-dismiss in 3s, max 3 stacked. Triggered by:
- Session state change (idle → waiting, especially background sessions entering waiting)
- SDK error / crash
- API key missing / invalid
- Do NOT toast on success (user-initiated actions already get visual feedback; avoid noise).

## 10. Data / persistence

- SQLite stores: group / session metadata / user-defined order / custom names / sidebar collapsed state / theme.
- Conversation history: relies on SDK's jsonl in `~/.claude/projects/` — not duplicated locally.
- On startup: reconcile `~/.claude/projects/` against SQLite; sessions present in jsonl but not attached to any group → land in a default "Imported" group.
- API key: OS keychain (Electron `safeStorage`); not stored in SQLite.

## 11. Shortcuts (MVP full set)

- Cmd/Ctrl+F: Search / Command Palette
- Cmd/Ctrl+,: Settings
- Cmd/Ctrl+N: New session (in current group, or auto-create default group)
- Cmd/Ctrl+Shift+N: New group
- Cmd/Ctrl+B: Toggle sidebar
- Enter: send
- Shift+Enter: newline
- Esc: close popover / cancel inline edit

Not doing: custom shortcuts, vim mode, multi-chord.

## 12. Out of MVP (written down explicitly to prevent drift)

- Multi-agent (Codex / Gemini)
- IM bridge / server mode / mobile
- MCP marketplace
- Message queue
- Ctrl+C as universal interrupt (use the Stop button)
- Slash command autocomplete
- Team / collaboration
- Tabs / split-view
- Account / user center
- Full-text search inside conversation
- Custom shortcuts
- Data dir migration
- Soft-delete + Deleted view
- Per-session model override (single global model setting in MVP)

## 12.1 SDK defaults (not exposed in UI, but locked)

- **Extended thinking**: hardcode on at the maximum budget supported by the model when calling `query()`.
  - Reason: the user doesn't care about this knob; if asked, they'd always pick max. Just give max — saves a decision.
  - No effort selector. Verify Opus 4 budget cap value when wiring the SDK to avoid drift from frozen docs.

## 13. Open items (non-blocking)

- Edge case checklist (from the earlier subagent competitor / audit pass): lives in `docs/triage.md`, post-MVP.

## 14. Full UI ASCII mockup

```
┌──────────────────────────────────┬────────────────────────────────────────────────────────┐
│ [«]  Search…              ⌘F     │                                                        │
│ [+ New Session]                  │  > make the webhook handler async                       │
│ ─────────────────────────────    │                                                        │
│ ▾ Backend Refactor        [+]    │  ● Let me look at the current handler first.            │
│   ● webhook-worker               │                                                        │
│   ⚡ webhook-async  ◀ active     │  ⏺ Read(src/webhook/handler.ts)                        │
│                                  │  ⏺ Grep("publish\\(", src/)                            │
│                                  │  ⏺ Bash(npm test -- webhook)                           │
│ ▾ Investigations          [+]    │                                                        │
│   ● oom-repro                    │  ● Plan: extract `WebhookJob`, use BullMQ.              │
│                                  │    Need a new redis dep. OK to proceed?                 │
│ ▸ Docs                    [+]    │                                                        │
│                                  │  ┌──────────────────────────────────────────────────┐  │
│ [+ New Group]                    │  │ ⚡ Permission requested                           │ │
│                                  │  │ Add dependency: bullmq@^5                         │ │
│ ▸ Archived Groups                │  │                          [ Deny ]  [ Allow ]      │ │
│                                  │  └──────────────────────────────────────────────────┘  │
│                                  │                                                        │
│                                  │                                       [↓ Jump to latest]│
│                                  │ ────────────────────────────────────────────────────── │
│                                  │  cwd: ~/projects/payments-api  ·  model: claude-opus-4 │
│                                  │ ┌────────────────────────────────────────────────────┐ │
│                                  │ │ Reply…  (Enter send · Shift+Enter newline)         │ │
│                                  │ │                                                    │ │
│                                  │ └────────────────────────────────────────────────────┘ │
│ [⚙ Settings]                     │                                                        │
└──────────────────────────────────┴────────────────────────────────────────────────────────┘

                                                  ┌──────────────────────────────────────┐
                                                  │ ⚡ webhook-async needs your input    │
                                                  └──────────────────────────────────────┘
                                                                              (toast, br)
```

## 15. Architecture constraint: reserve room for a remote frontend

MVP is desktop-only (frontend and backend both on the user's machine), but we want "future: frontend on a different device, daemon on this machine" to be a manageable cost. This is a project-level hard constraint, not per-PR.

### Future target scenario (NOT MVP)

A Mac at home runs the daemon (SDK + filesystem ops + long-running tasks). Phone / work laptop / iPad runs the frontend; the two pair via GitHub OAuth. The daemon never sleeps; the frontend can disconnect and switch devices freely.

### Rule to follow now

**Frontend code is NOT allowed to `import { ipcRenderer }` or `import` anything from `electron/*`.**

The only allowed backend entry point is `window.ccsm` (declared in `src/global.d.ts`). Any new backend capability extends this interface first, then adds an IPC implementation.

Reason: `window.ccsm` is a frontend/backend contract. Hiding the transport (Electron IPC) behind it means a future WebSocket implementation only swaps `preload.ts`'s equivalent — `src/` doesn't change a line.

### Questions to ask when designing a backend capability

1. **Can it cross a network?** A call that assumes zero-latency synchronous completion will stall in remote mode. Stream-first / async-first.
2. **Where is the source of truth?** Today the store is authoritative on the frontend. In the future the daemon is authoritative and the frontend is a view. New features should let the store accept state pushed from the daemon — don't put "frontend-only" state into the store.
3. **Are paths hardcoded to local?** cwd, `~/.claude/projects/`, etc. only make sense on the daemon side. The frontend should always treat them as "paths on that other machine".

### Not doing in MVP

- No WebSocket server / client.
- No OAuth pairing.
- No relay service.
- No extra abstraction layers "for the future remote case" — the interface is enough; YAGNI.

### Code review checklist

A PR that triggers any of the below must be rejected or rewritten:

- [ ] `from 'electron'` appears under `src/`
- [ ] `ipcRenderer` / `ipcMain` appears under `src/`
- [ ] Components directly read/write local paths like `~/.claude/projects/`
- [ ] A backend capability bypasses `window.ccsm` via a temporary preload-exposed global
