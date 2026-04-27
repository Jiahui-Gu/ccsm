# ttyd-embed spike

Throwaway 1-day spike to evaluate embedding `ttyd` + the `claude` CLI inside an
Electron `<webview>` instead of building a custom xterm.js + node-pty terminal.

NOT for merging into ccsm. Branch: `spike/ttyd-embed`.

## What's here

- `bin/ttyd.exe` — `ttyd` 1.7.7 Windows binary from the upstream release
  (https://github.com/tsl0922/ttyd/releases/tag/1.7.7, asset `ttyd.win32.exe`).
- `main.js` — minimal Electron main process. Resolves `claude` via `where`,
  picks a free port, spawns `ttyd.exe -W -t fontSize=14 <claude>`, opens a
  `BrowserWindow` containing a left placeholder div + a right `<webview>`
  pointing at the local ttyd HTTP server. Reaps ttyd + the PTY/claude process
  tree on close via `taskkill /F /T`.
- `index.html` — the two-pane layout (left placeholder, right `<webview>`).

## Prereqs

- Windows 10/11.
- Node.js 18+ (for installing electron).
- `claude` CLI on PATH (the spike uses `where claude.cmd` to locate it).

## How to run

```cmd
cd spike\ttyd-embed
npm install
npm start
```

If you ever need to refresh the bundled ttyd binary, download
`ttyd.win32.exe` from the latest release at
https://github.com/tsl0922/ttyd/releases and save it as `bin/ttyd.exe`.

## Manual smoke test (Phase 1, regular browser)

```cmd
bin\ttyd.exe -p 7681 -W claude
```

Open http://localhost:7681 in any browser. You should see the claude CLI
prompt. Send a prompt, confirm a response renders.
