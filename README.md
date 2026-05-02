# ccsm

**Run multiple Claude Code sessions side by side, with the density of a CLI and the comfort of a desktop app.**

ccsm is a native desktop client for [Claude Code](https://docs.anthropic.com/claude/docs/claude-code). Group sessions by task instead of by repo, drive several agents in parallel, and stay in flow without tab-juggling terminals.

![main window](docs/screenshots/v0.2-readme/01-main.png)

## Features

### Multi-session terminals
Every session is a real PTY in the main process via `node-pty` — the same Claude Code CLI you already use, just embedded. Switch between sessions instantly; output, scrollback, and ANSI color render exactly like your terminal.

### Groups, not folders
Organize sessions by task. Drag to reorder, archive when done, soft-delete with undo. Repo lives as metadata on each session — engineers think in tasks, ccsm follows.

### CLI-grade information density
Block rendering, monospace, collapsed tool calls, no fluff chrome. The right panel mirrors what you'd see in the terminal — no lossy summarization, no hidden state.

### Permission prompts as UI
When the agent asks to run a command or edit a file, you get a real prompt with **Allow**, **Allow always**, and **Deny** — no more squinting at terminal prompts mid-flow.

### Status bar that means something
Every session shows its working directory, model, permission mode (Plan / Default / Accept edits / Bypass / Auto), context meter, and a 6-tier effort chip. Click any of them to change it — no rerun, no restart.

### Two-state lifecycle
Sessions are either idle or waiting for you. A breathing amber dot tells you which sessions need attention; everything else fades into the background.

### Command palette
Hit `Ctrl+F` to jump anywhere — sessions, groups, settings, recent transcripts. Designed for keyboard-first operators.

### Import existing transcripts
Already have a history in `~/.claude/projects/`? ccsm reads it natively. No migration, no sync — your CLI sessions and ccsm sessions are the same sessions.

### Desktop notifications
Per-session muting, focus-aware suppression, and a single "agent is waiting" signal across all your active work. Set it once and stop polling.

### Auto-update
Ships via GitHub Releases with delta updates. New versions install in the background and prompt on next launch.

## Install

| Platform | Download |
|----------|----------|
| Windows | [ccsm-Setup-0.2.0.exe](https://github.com/Jiahui-Gu/ccsm/releases/download/v0.2.0/ccsm-Setup-0.2.0.exe) |
| Linux (deb) | [ccsm_0.2.0_amd64.deb](https://github.com/Jiahui-Gu/ccsm/releases/download/v0.2.0/ccsm_0.2.0_amd64.deb) |
| Linux (AppImage) | [ccsm-0.2.0.AppImage](https://github.com/Jiahui-Gu/ccsm/releases/download/v0.2.0/ccsm-0.2.0.AppImage) |
| Linux (rpm) | [ccsm-0.2.0.x86_64.rpm](https://github.com/Jiahui-Gu/ccsm/releases/download/v0.2.0/ccsm-0.2.0.x86_64.rpm) |

## Verify your download

Every installer ships with three sidecar files in the same release. We
recommend verifying at least the SHA before running unfamiliar installers,
and the SLSA provenance for stronger authenticity guarantees.

| Sidecar | What it proves | Verify with |
|---------|----------------|-------------|
| `<artifact>.sha256` | The file you downloaded matches the bytes we built | `sha256sum -c ccsm-Setup-0.3.0.exe.sha256` |
| `<artifact>.intoto.jsonl` | The file was built by [this exact `release.yml` workflow](.github/workflows/release.yml) on `Jiahui-Gu/ccsm`, signed by GitHub's OIDC root (SLSA L3) | [`slsa-verifier verify-artifact ccsm-Setup-0.3.0.exe --provenance-path ccsm-Setup-0.3.0.exe.intoto.jsonl --source-uri github.com/Jiahui-Gu/ccsm`](https://github.com/slsa-framework/slsa-verifier) |
| `<artifact>.minisig` | The file was signed by the ccsm release-signing key (offline-verifiable; used by the daemon-only updater) | `minisign -V -p release-keys/minisign.pub -m ccsm-Setup-0.3.0.exe` |

The minisign public key lives at [`release-keys/minisign.pub`](release-keys/minisign.pub) — copy it once, verify any release. See [`release-keys/README.md`](release-keys/README.md) for the rotation runbook and the meaning of each sidecar in detail.

## How it works

ccsm spawns the official `claude` binary as a PTY in Electron's main process and renders its output in a React surface. It reads `CLAUDE_CONFIG_DIR` so your existing CLI configuration — skills, agents, MCP servers, permissions — works untouched. ccsm doesn't parse or rewrite your config; it just gives the CLI a better window.

## Develop

One-shot bootstrap for a fresh checkout (Node 20.x, npm 10+):

```sh
git clone https://github.com/Jiahui-Gu/ccsm.git
cd ccsm
npm run setup
npm run dev
```

`npm run setup` (`scripts/setup.cjs`) is idempotent and does, in order:

1. `npm install` at the root (also installs the `daemon` workspace).
2. Builds the `ccsm_native` N-API addon for the daemon's Node ABI.
3. Runs `@electron/rebuild` for `better-sqlite3` + `node-pty` against Electron's ABI (a no-op when the `postinstall` hook already ran).
4. Creates the dev dataRoot. Defaults to `~/.ccsm-dev`; override with `CCSM_DATA_ROOT=/your/path npm run setup`.

Re-run `npm run setup` any time after `git pull` — none of the steps destroy work.

Toolchain: Windows needs Visual Studio Build Tools (C++ workload) + Python 3 on PATH; macOS needs Xcode CLT; Linux needs `build-essential` + `python3`.

## Roadmap

- **v0.3** — daemon split (sessions survive app restarts), in flight
- **v0.4** — web client and cross-device sync

## License

MIT &middot; [github.com/Jiahui-Gu/ccsm](https://github.com/Jiahui-Gu/ccsm)
