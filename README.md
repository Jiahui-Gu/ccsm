# ccsm

> Manage every Claude Code session from one window. Local-first, multi-project, PTY-native.

<!-- TODO: ./docs/screenshots/v0.3-readme/01-hero.png -->
![ccsm main window with multiple active sessions](./docs/screenshots/v0.3-readme/01-hero.png)

## What is ccsm

**ccsm** (Claude Code Session Manager) is a desktop app for people who run
[Claude Code](https://docs.anthropic.com/claude/docs/claude-code) all day
across multiple projects. Instead of juggling five terminal tabs, you get
one window with a sidebar of grouped sessions, each backed by a real
`claude` PTY. Every session keeps streaming in the background; the sidebar
breathes amber when an agent needs you.

ccsm does not reimplement the agent. It delegates 100% of agent execution
to your locally-installed `claude` binary, with your existing OAuth or
`ANTHROPIC_API_KEY`. ccsm itself makes zero HTTP calls to Anthropic. It is
a manager and a UI, not a client.

It is built for engineers who think in tasks, not in repos: groups are
your unit of organisation, sessions inside a group can live in different
working directories, and the same window stays useful whether you have
one session or twenty.

## Install

Download the latest installer from
[Releases](https://github.com/Jiahui-Gu/ccsm/releases):

| Platform | Artifact | Notes |
| --- | --- | --- |
| Windows 10 / 11 | `CCSM-Setup-<version>-x64.exe` | NSIS, per-machine, asks for elevation. |
| macOS 11+ (Intel + Apple Silicon) | `CCSM-<version>-<arch>.dmg` | Universal binary not yet shipped; pick `x64` or `arm64`. |
| Linux x64 | `.AppImage`, `.deb`, `.rpm` | glibc 2.17+. |

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

   <!-- TODO: ./docs/screenshots/v0.3-readme/02-quickstart-new-session.png -->
   ![New-session popover with recent directories](./docs/screenshots/v0.3-readme/02-quickstart-new-session.png)

3. **Type in the composer.** `Enter` sends, `Shift+Enter` newline, `Esc`
   cancels inline edits. The model picker, permission mode, effort tier
   and context % live in the status bar.
4. **Answer permission prompts inline.** When the agent calls `Bash`,
   `Edit`, `Write`, etc., a permission block appears at the tail of the
   conversation with `Allow` / `Allow always` / `Deny`.

   <!-- TODO: ./docs/screenshots/v0.3-readme/03-permission-prompt.png -->
   ![Inline permission prompt for a Bash tool call](./docs/screenshots/v0.3-readme/03-permission-prompt.png)

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

What v0.3 actually ships (verified against `src/i18n/locales/en.ts` and
the v0.3 design spec):

- **Multi-session terminal** — each session is a real `claude` PTY hosted
  by a standalone daemon; sessions survive Electron restart and
  auto-update.
- **Groups, not projects** — task-first organisation; sessions inside a
  group can live in different repos. Drag to reorder, archive, soft-delete
  with undo.
- **CLI-grade information density** — block-based message rendering
  (`>` user, `●` assistant, `⏺` tool), collapsed tool calls, no chat
  bubbles.
- **Permission prompts as UI** — inline Allow / Allow always / Deny with
  the tool input rendered as structured data, including the cwd context.
- **Two-state lifecycle** — `idle` / `waiting`; the sidebar pulses amber
  when an agent needs input. No manual statuses to maintain.
- **Status bar controls** — cwd picker (with recent-dirs fuzzy filter),
  model picker, permission mode (`Plan` / `Default` / `Accept edits` /
  `Bypass` / `Auto`), context-window meter, and 6-tier effort/thinking
  chip.
- **Command palette** — `Ctrl+F` searches sessions, groups, and built-in
  commands (new group, switch theme, open settings, import).
- **Import existing transcripts** — surface `~/.claude/projects/`
  conversations into ccsm; they resume on open.
- **Desktop notifications** — OS-native toasts for `permission`,
  `question` (`AskUserQuestion`), and `turn_done` events. Suppressed when
  the window is focused on that session. Per-session muting from the
  context menu.
- **Settings** — system / light / dark theme, font size (sm / md / lg),
  language (English / 中文), close-button behaviour (ask / minimize-to-tray
  / quit), opt-in crash reporting.
- **Auto-update** — checks GitHub Releases on launch and every 4 hours;
  in-place upgrade keeps the daemon (and your sessions) running across
  the restart.

## Screenshots

<!-- TODO: ./docs/screenshots/v0.3-readme/04-command-palette.png -->
![Command palette in light mode with mixed session, group and command results](./docs/screenshots/v0.3-readme/04-command-palette.png)

*Command palette — fuzzy search across sessions, groups, and built-in commands.*

<!-- TODO: ./docs/screenshots/v0.3-readme/05-status-bar.png -->
![Status bar detail showing cwd chip, model picker, permission-mode tooltip and context %](./docs/screenshots/v0.3-readme/05-status-bar.png)

*Status bar — cwd, model, permission mode (with tooltip), context window, effort tier.*

<!-- TODO: ./docs/screenshots/v0.3-readme/06-notifications.png -->
![Native OS toast firing for a backgrounded session that needs input](./docs/screenshots/v0.3-readme/06-notifications.png)

*Native OS toast — fires only when the window is unfocused.*

## How it works

ccsm v0.3 is a two-process app:

- **Renderer** — Electron + React + Tailwind. Owns the UI, OS integration
  (tray, dock, dialogs), and user input. Talks to the daemon over a local
  IPC channel: Windows named pipes / Unix domain sockets, length-prefixed
  JSON envelope, HMAC-SHA256 challenge-response handshake on connect.
- **Daemon** (`daemon/`) — standalone Node 22 ESM process. Owns PTY child
  processes (via `node-pty` plus an in-tree `ccsm_native.node` for
  Windows JobObject / POSIX `setpgid` + `PDEATHSIG`), the
  `@anthropic-ai/claude-agent-sdk` calls, SQLite persistence
  (`better-sqlite3`), structured `pino` logs, and notification fan-out.
  Survives Electron restart and auto-update.

A supervisor watches `/healthz` every 5 s with 3-miss restart and a
crash-loop modal at 5 respawns / 2 min. Conversation history is read
directly from the Claude CLI's `~/.claude/projects/` jsonl files — ccsm
does not duplicate it.

The terminal is xterm-headless on the daemon side as the authoritative
scrollback buffer; the renderer's xterm.js is just a view onto a serialized
snapshot, which is why sessions resume instantly after a window restart.

Frontend code under `src/` is forbidden from importing `electron` — the
only backend entry point is `window.ccsm`, exposed via
`electron/preload.ts`. This keeps the door open for the planned v0.5 web
client over Cloudflare Tunnel; see [`docs/roadmap.md`](./docs/roadmap.md)
and [`docs/superpowers/specs/v0.3-design.md`](./docs/superpowers/specs/v0.3-design.md)
for the full picture.

### Data location

Local SQLite database (groups, sessions, user-defined order, sidebar
width, theme), `pino` logs, and the daemon socket / lockfile:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\CCSM\` |
| macOS | `~/Library/Application Support/CCSM/` |
| Linux | `~/.config/CCSM/` |

Anthropic credentials are stored by the Claude CLI (under `~/.claude/`);
ccsm never touches them.

## FAQ

**Does ccsm send my code to Claude?**
Only as much as `claude` itself does — ccsm never makes its own HTTP
calls to Anthropic. All API traffic flows through your local `claude`
binary using your existing credentials. ccsm is a manager and a UI on top
of that binary.

**Where does my data live?**
Locally. SQLite + log files under the OS-specific data directory listed
above. Conversation history is read in place from
`~/.claude/projects/`. Nothing leaves your machine through ccsm.

**Does it work offline?**
The app launches and renders fine offline. Whether a given session
*responds* depends on the Claude CLI being able to reach Anthropic.

**Can I run multiple Claude Code versions?**
One global binary at a time, resolved via `PATH` or
`CCSM_CLAUDE_BIN=/path/to/claude`. ccsm does not bundle the CLI — it
points at whatever you have installed.

**Does ccsm send crash reports?**
Off by default. Crash reporting requires a build-time `SENTRY_DSN`
environment variable; the open-source build ships without one. To opt in,
build your own with `SENTRY_DSN=...` set, or toggle Settings →
Notifications → "Send crash reports to developer". Reports include stack
traces and the app version, never conversation contents or environment
variables.

**Why an Electron + daemon split?**
So PTY children and SDK socket connections survive Electron restart,
hot-reload, and auto-update. Killing the renderer never orphans an agent
loop. See [`docs/superpowers/specs/v0.3-daemon-split.md`](./docs/superpowers/specs/v0.3-daemon-split.md)
for the full rationale.

## Contributing

Issues and PRs welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for
the dev loop (Node 20+, `npm install`, `npm run dev` for the three-process
web/daemon/app concurrent setup) and contribution conventions.

Design docs live under [`docs/superpowers/specs/`](./docs/superpowers/specs/);
the implementation roadmap is at [`docs/roadmap.md`](./docs/roadmap.md).

## License

[MIT](./LICENSE).
