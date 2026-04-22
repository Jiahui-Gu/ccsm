# Agentory v0.1.0 — Internal Release

First packaged build for internal beta. Thanks for trying it.

## What's in this release

The core MVP: parallel Claude Code sessions, organized by task, with native UI for permission prompts and multi-choice questions. Built directly on the Claude Code CLI (no SDK) — if `claude` works in your terminal, Agentory works.

### Key features
- **Repo-agnostic groups**: organize sessions by task/domain, not by git repo. Drag sessions between groups, reorder, rename inline, soft-delete with undo.
- **Parallel sessions**: spawn multiple `claude` processes side-by-side; sidebar pulses on the one waiting for your input so you know where to look.
- **Native permission + question UI**: tool-permission prompts and `AskUserQuestion` render as real dialogs/lists with keyboard nav, instead of being stuck inside the stream.
- **CLI-style composer**: Esc to interrupt, message queue while the agent is busy, Cmd/Ctrl+Enter to send, slash commands loaded from disk (`/clear`, `/compact`, plus your own from `~/.claude/commands`).
- **Session restore**: close the app, reopen, pick up where you left off — including streaming state and pending prompts.
- **i18n**: full zh/en coverage with reserved-noun preservation.

### Recent fixes (2026-04-22 polish batch)
- **Long tool output**: Read on a 50K-line file no longer truncates to 388 chars; you get first 50 + last 50 + click-to-expand with virtualized scrolling, plus Copy / Save as .log buttons (#141)
- **Esc to interrupt**: composer now auto-focuses after Esc so you can immediately type the follow-up (#142)
- **Restored sessions**: streaming caret no longer pulses forever after restart (#143)
- **Sidebar**: 6 UX fixes — auto-rename new groups, soft-delete with undo toast, same-group fallback on session delete, scroll-into-view on selection, reject drop on archived groups, right-click selects (#144)
- **Permission prompts**: 3 fixes — robust Reject focus on sequential prompts, denial trace preserved in chat, nested toolInput rendered (#145)
- **AskUserQuestion**: long URLs in option labels now wrap (#146)

## Known issues
- 8 vitest tests fail locally due to a `better-sqlite3` Node/Electron ABI mismatch in the test env. Not user-facing; tracked.
- App icon is the default Electron atom (placeholder).
- Code signing not set up — Windows SmartScreen will warn on first install. Click "More info" → "Run anyway".
- arm64 Windows build skipped this release — x64 only. Should work on most modern Windows machines.

## Requirements
- Claude Code CLI installed and authenticated. If `claude` works in your terminal, Agentory works.
- Windows 10+ x64, macOS 11+, or Linux (glibc 2.17+)

## How to install
Download the `.exe` from the Assets section below, run it, follow the installer.

## How to give feedback
- Crashes auto-report (you can opt out in Settings → Privacy)
- For everything else: ping the author directly with a screenshot
