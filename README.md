# ccsm

> Manage every Claude Code session from one window. Local-first, multi-project, PTY-native.

<!-- TODO: ./docs/screenshots/v0.2-readme/01-hero.png -->
![ccsm main window with multiple active sessions](./docs/screenshots/v0.2-readme/01-hero.png)

## What is ccsm

**ccsm** (Claude Code Session Manager) is a desktop app for people who run
[Claude Code](https://docs.anthropic.com/claude/docs/claude-code) all day
across multiple projects. Instead of juggling five terminal tabs, you get
one window with a sidebar of grouped sessions, each backed by a real
`claude` PTY. Background sessions keep streaming while you focus on
another; the sidebar breathes amber when an agent needs your input.

ccsm does not reimplement the agent. It delegates 100% of agent execution
to your locally-installed `claude` binary, with your existing OAuth or
`ANTHROPIC_API_KEY`. ccsm itself makes zero HTTP calls to Anthropic. It
is a manager and a UI, not a client.

It is built for engineers who think in tasks, not in repos: groups are
your unit of organisation, sessions inside a group can live in different
working directories, and the same window stays useful whether you have
one session or twenty.

## Install

Download the latest installer from the
[v0.2.0 release page](https://github.com/Jiahui-Gu/ccsm/releases/tag/v0.2.0):

| Platform | Artifact | Notes |
| --- | --- | --- |
| Windows 10 / 11 (x64) | `CCSM-Setup-0.2.0-x64.exe` | NSIS, per-machine, asks for elevation. |
| Linux x64 | `CCSM-0.2.0-x86_64.AppImage` / `CCSM-0.2.0-amd64.deb` / `CCSM-0.2.0-x86_64.rpm` | glibc 2.17+. |

macOS builds are not shipped in v0.2.0. Run from source on macOS via
`npm run dev` if you need it before a packaged build lands.

After install, launch ccsm. If `claude` is not on `PATH`, ccsm shows a
full-screen "Claude CLI not found" page with the install command and a
re-check button — no terminal restart needed.

> **Prerequisite**: the Claude Code CLI must be installed and logged in.
> `npm i -g @anthropic-ai/claude-code`, then run `claude` once to complete
> OAuth (or set `ANTHROPIC_API_KEY`). Override the binary location with
> `CCSM_CLAUDE_BIN=/path/to/claude` if needed. **If `claude` works in your
> terminal, ccsm will work. If it does not, ccsm will not either.**

## Quickstart

1. **Create a group.** Click `+ New group` in the sidebar (or skip — the
   first session lands in a default `Sessions` group).
2. **Start a session.** Click `+ New session` in a group, pick a working
   directory. ccsm spawns `claude` in that cwd via a real PTY.

   <!-- TODO: ./docs/screenshots/v0.2-readme/02-quickstart-new-session.png -->
   ![New-session popover with recent directories](./docs/screenshots/v0.2-readme/02-quickstart-new-session.png)

3. **Type in the composer.** `Enter` sends, `Shift+Enter` newline, `Esc`
   cancels inline edits. The model picker, permission mode, effort tier
   and context % live in the status bar.
4. **Answer permission prompts inline.** When the agent calls `Bash`,
   `Edit`, `Write`, etc., a permission block appears at the tail of the
   conversation with `Allow` / `Allow always` / `Deny`.

   <!-- TODO: ./docs/screenshots/v0.2-readme/03-permission-prompt.png -->
   ![Inline permission prompt for a Bash tool call](./docs/screenshots/v0.2-readme/03-permission-prompt.png)

5. **Switch sessions freely.** Background sessions keep streaming. The
   sidebar dot breathes amber when a session is waiting for you, and a
   desktop toast fires if the window is unfocused.

### Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+F` | Search / command palette |
| `Ctrl/Cmd+,` | Open settings |
| `Ctrl/Cmd+N` | New session |
| `Ctrl/Cmd+Shift+N` | New group |
| `?` | Show all shortcuts |

## Features

What v0.2.0 actually ships (verified against `src/i18n/locales/en.ts`
and the v0.2 codebase):

- **Multi-session terminal** — each session is a real `claude` PTY hosted
  in the Electron main process via `node-pty`. Background sessions keep
  streaming while you focus on another.
- **Groups, not projects** — task-first organisation; sessions inside a
  group can live in different repos. Drag to reorder, archive,
  soft-delete with undo.
- **CLI-grade information density** — block-based message rendering
  (`>` user, `●` assistant, `⏺` tool), collapsed tool calls, no chat
  bubbles.
- **Permission prompts as UI** — inline `Allow` / `Allow always` / `Deny`
  with the tool input rendered as structured data, including the cwd
  context.
- **Two-state lifecycle** — `idle` / `waiting`; the sidebar pulses amber
  when an agent needs input. No manual statuses to maintain.
- **Status bar controls** — cwd picker (with recent-dirs fuzzy filter),
  model picker, permission mode (`Plan` / `Default` / `Accept edits` /
  `Bypass` / `Auto`), context-window meter, and 6-tier effort/thinking
  chip (`Off` / `Low` / `Medium` / `High` / `Extra high` / `Max`).
- **Command palette** — `Ctrl+F` searches sessions, groups, and built-in
  commands (new group, switch theme, open settings, import).
- **Import existing transcripts** — surface `~/.claude/projects/`
  conversations into ccsm; they resume on open.
- **Desktop notifications** — OS-native toasts for `permission`,
  `question` (`AskUserQuestion`), and `turn_done` events. Suppressed when
  the window is focused on that session. Per-session muting from the
  context menu.
- **Settings** — system / light / dark theme, font size (`sm` / `md` /
  `lg`), language (English / 中文), close-button behaviour
  (`Ask every time` / `Minimize to tray` / `Quit`), opt-in crash
  reporting.
- **Auto-update** — checks GitHub Releases on launch and every 4 hours;
  in-place upgrade restarts ccsm cleanly.

## Screenshots

<!-- TODO: ./docs/screenshots/v0.2-readme/04-command-palette.png -->
![Command palette in light mode with mixed session, group and command results](./docs/screenshots/v0.2-readme/04-command-palette.png)

*Command palette — fuzzy search across sessions, groups, and built-in commands.*

<!-- TODO: ./docs/screenshots/v0.2-readme/05-status-bar.png -->
![Status bar detail showing cwd chip, model picker, permission-mode tooltip and context %](./docs/screenshots/v0.2-readme/05-status-bar.png)

*Status bar — cwd, model, permission mode (with tooltip), context window, effort tier.*

<!-- TODO: ./docs/screenshots/v0.2-readme/06-notifications.png -->
![Native OS toast firing for a backgrounded session that needs input](./docs/screenshots/v0.2-readme/06-notifications.png)

*Native OS toast — fires only when the window is unfocused.*

## How it works

ccsm v0.2 is a single-process Electron app:

- **Renderer** — React + Tailwind. Owns the UI, OS integration (tray,
  dialogs), and user input. Talks to the main process via the
  `window.ccsm` IPC bridge declared in `electron/preload`.
- **Main process** — Electron main owns the PTY child processes (via
  `node-pty`), `@anthropic-ai/claude-agent-sdk` calls, SQLite
  persistence (`better-sqlite3`), session JSONL watching, and
  notification fan-out.

PTY children live for the lifetime of the Electron main process; closing
the window to the tray keeps sessions running, quitting ccsm tears them
down. Conversation history is read directly from the Claude CLI's
`~/.claude/projects/` jsonl files — ccsm does not duplicate it.

Frontend code under `src/` is forbidden from importing `electron` — the
only backend entry point is `window.ccsm`, exposed via
`electron/preload.ts`. This keeps the door open for the planned daemon
split (post-v0.2) where the PTY host moves out of process so sessions
survive Electron restart and auto-update.

### Data location

Local SQLite database (groups, sessions, user-defined order, sidebar
width, theme) lives under the OS-specific user data directory:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\CCSM\` |
| Linux | `~/.config/CCSM/` |

Anthropic credentials are stored by the Claude CLI (under `~/.claude/`);
ccsm never touches them.

## FAQ

**Does ccsm send my code to Claude?**
Only as much as `claude` itself does — ccsm never makes its own HTTP
calls to Anthropic. All API traffic flows through your local `claude`
binary using your existing credentials. ccsm is a manager and a UI on
top of that binary.

**Where does my data live?**
Locally. SQLite under the OS-specific data directory listed above.
Conversation history is read in place from `~/.claude/projects/`.
Nothing leaves your machine through ccsm.

**Does it work offline?**
The app launches and renders fine offline. Whether a given session
*responds* depends on the Claude CLI being able to reach Anthropic.

**Can I run multiple Claude Code versions?**
One global binary at a time, resolved via `PATH` or
`CCSM_CLAUDE_BIN=/path/to/claude`. ccsm does not bundle the CLI — it
points at whatever you have installed.

**Does ccsm send crash reports?**
Off by default. Crash reporting requires a `SENTRY_DSN` environment
variable at process start; the open-source build ships without one. To
opt in, set `SENTRY_DSN=...` before launching, or toggle Settings →
Notifications → "Send crash reports to developer". Reports include
stack traces and the app version, never conversation contents or
environment variables.

## Contributing

Issues and PRs welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for
the dev loop (Node 20+, `npm install`, `npm run dev` for the
webpack-dev-server + Electron concurrent setup) and contribution
conventions.

Design docs live under [`docs/`](./docs/); the MVP design is at
[`docs/mvp-design.md`](./docs/mvp-design.md).

## License

[MIT](./LICENSE).
