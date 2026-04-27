# CCSM (Claude Code Session Manager)

A desktop GUI for [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) — manage multiple parallel agent sessions across repos with the visual density of a CLI and the interaction model of a native app.

<!-- TODO: screenshot here -->

## What it is

Claude Code is a powerful CLI, but switching between 5+ active sessions in different repos becomes tab-juggling. CCSM groups your sessions by task (not by repo) and gives them a sidebar — you stay in flow across multiple parallel conversations.

- **Groups, not projects** — a group is your task; sessions inside it can live in different repos
- **Native interactions** — drag to reorder, right-click context menus, keyboard shortcuts, inline rename
- **CLI-grade information density** — block-based message rendering (`>` user, `●` assistant, `⏺` tool), collapsed tool calls, no chat-bubble fluff
- **Permission prompts as UI** — answer Allow / Deny inline, see the tool input as structured data
- **Two-state lifecycle** — `idle` / `waiting`; the sidebar breathes amber when an agent needs you, no manual status to maintain

## Requirements

- **Claude Code CLI** installed and authenticated. CCSM delegates 100% of agent execution to the CLI:
  - Install: `npm i -g @anthropic-ai/claude-code` (or your platform package manager)
  - First-time login: run `claude` once to complete OAuth (or set `ANTHROPIC_API_KEY` in your environment)
  - **If `claude` works in your terminal, CCSM will work. If it doesn't, CCSM won't either.**
  - Override the binary location with `CCSM_CLAUDE_BIN=/path/to/claude` if needed.
- **OS**: Windows 10+, macOS 11+ (Big Sur), or Linux (glibc 2.17+)
- **Disk**: ~200 MB

CCSM does **not** make any HTTP calls to Anthropic itself. All API traffic goes through your local `claude` binary, with your existing credentials.

## Install

1. Download the latest `.exe` (Windows) / `.dmg` (macOS) / `.AppImage` / `.deb` / `.rpm` (Linux) from [Releases](https://github.com/Jiahui-Gu/ccsm/releases).
2. Run the installer.
3. Launch CCSM. If the Claude CLI isn't found, you'll see an actionable error showing every path CCSM searched.

## Quickstart

1. Click **+ New Group** in the sidebar to create a task bucket (or skip — CCSM auto-creates a default group on the first session).
2. Click **+ New Session** inside a group. Pick a working directory (any repo). The session spawns `claude` in that cwd.
3. Type in the composer at the bottom. **Enter** to send, **Shift+Enter** for newline, **Esc** to cancel inline edits.
4. When the agent requests a tool, a permission block appears at the tail of the conversation — Allow / Deny.
5. Switch between sessions with the sidebar. Background sessions keep streaming and surface a breathing amber dot when they need you.

### Shortcuts

- `Cmd/Ctrl+F` — Search / Command Palette
- `Cmd/Ctrl+,` — Settings
- `Cmd/Ctrl+N` — New session
- `Cmd/Ctrl+Shift+N` — New group
- `Cmd/Ctrl+B` — Toggle sidebar

## Data location

Local SQLite database (groups, sessions, user-defined order, sidebar state, theme):

- **Windows**: `%APPDATA%\CCSM\`
- **macOS**: `~/Library/Application Support/CCSM/`
- **Linux**: `~/.config/CCSM/`

Conversation history is **not** duplicated — CCSM reads it directly from the Claude CLI's `~/.claude/projects/` jsonl files. Anthropic credentials are stored by the CLI itself; CCSM never touches them.

## Crash reports

CCSM can send crash reports and unhandled errors to Sentry to help fix bugs. Reports include error stack traces and the app version; they do NOT include the contents of your conversations, file paths inside your projects, or environment variables.

Crash reporting is **off by default** in the open-source build: there is no hardcoded DSN. To enable it (e.g. for your own fork), set `SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>` in the process environment before launching the app. If `SENTRY_DSN` is unset, `Sentry.init()` is skipped entirely and a single informational line is logged at startup.

To disable after opting in: open Settings → Notifications and uncheck "Send crash reports to developer".

## Development

Requires Node 20+ and `npm`. The native module `better-sqlite3` is rebuilt for Electron's ABI on `npm install` via `electron-builder install-app-deps`.

```bash
npm install
npm run dev          # webpack-dev-server + electron, concurrently
npm test             # vitest
npm run typecheck    # tsc --noEmit (renderer + electron)
npm run lint         # eslint
npm run make:win     # build Windows installer (NSIS)
npm run make:mac     # build macOS .dmg + .zip
npm run make:linux   # build AppImage / .deb / .rpm
```

The architecture has a hard rule: **frontend code under `src/` may not import from `electron`**. The only backend entry point is `window.ccsm` (declared in `src/global.d.ts`), exposed via `electron/preload.ts`. This keeps the door open for a future remote daemon. See `docs/mvp-design.md` §15.

### Windows: `gyp ERR! find Python` on `npm install`

`better-sqlite3`'s native rebuild uses `node-gyp`, which on Windows often
picks up the `WindowsApps\python.exe` Microsoft Store launcher stub instead
of a real interpreter and fails. If you see `gyp ERR! find Python`, point
node-gyp at a real Python 3.x in your **user-level** `~/.npmrc` (not the
repo's `.npmrc` — the path is machine-specific):

```ini
python=C:/Users/<you>/AppData/Local/Programs/Python/Python312/python.exe
```

Any installed Python 3.8+ works. Re-run `npm install` and the rebuild
will pick up the override automatically.

## Notifications

CCSM raises desktop notifications when a background session needs your
attention or a long-running turn finishes:

- `permission` — the agent is waiting on an Allow / Allow always / Reject
  decision (e.g. `Bash`, `Edit`, `Write`).
- `question` — the agent invoked `AskUserQuestion` and needs you to pick
  an option.
- `turn_done` — a turn finished, and either took longer than 15 seconds,
  errored, or completed in a session that wasn't focused.

CCSM uses Electron's built-in `Notification` API, which delivers OS-native
toasts on Windows (via `ToastNotificationManager` + the AUMID stamped on the
Start Menu shortcut), macOS, and Linux. Click a toast to bring CCSM forward
and focus the originating session — no inline action buttons; permission
approval flows through the in-app dialog where the command + cwd context is
visible.

**To disable**: open Settings → Notifications and toggle the master
**Enable notifications** switch (or any of the per-event sub-toggles for
`permission` / `question` / `turn done`). Per-session muting is also
available from the session's context menu.

**Focus suppression**: when CCSM has the OS focus, no toast fires — you'll
see the in-app prompt or sidebar pulse instead. This is enforced both in
the renderer (per-session focus check) and in the main process
(`BrowserWindow.isFocused()`), so devtools / debuggers / playwright
sessions can't bypass it.

### Dev mode notifications

Adaptive Toast notifications require a registered AppUserModelID (AUMID)
plus a Start Menu shortcut that points at the same AUMID. NSIS installs of
CCSM register both automatically. For `npm run dev` (no installer is run),
register them once per machine:

```powershell
pwsh scripts/setup-aumid.ps1
```

Without this, the Adaptive Toast pipeline silently no-ops in dev mode and
CCSM falls back to plain Electron notifications.

## Status

This is **MVP**. The author uses it daily as a personal driver. Public release pending.

## License

MIT — see [LICENSE](LICENSE).
