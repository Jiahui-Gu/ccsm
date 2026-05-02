# R5 review — 08-electron-client-migration.md

## P0

### P0-08-1. `lint:no-ipc` script lives in two places with different paths
- §5h: `npm run lint:no-ipc` script: `grep -r "contextBridge\|ipcMain\|ipcRenderer" packages/electron/src && exit 1 || exit 0`.
- Chapter 12 §4.1: `tools/lint-no-ipc.sh` (also referenced in chapter 11 §2 layout).
- Brief §11(a): `grep -r "contextBridge\|ipcMain\|ipcRenderer" packages/electron/src returns 0 hits`.

Three different shell semantics:
- §5h npm script: returns 1 if grep MATCHES (correct).
- §5h embedded shell `&& exit 1 || exit 0`: this **inverts** if grep returns non-zero (no matches) → triggers `||` branch → exit 0 (correct), but if grep matches and stdout has content → `&&` triggers → exit 1 (correct). OK actually fine.
- Chapter 12 §4.1: `grep -rEn ... || true` then `if [ -n "$hits" ]; then ... exit 1; fi`. OK.

But the **mapping**: brief grep is plain `grep`, §5h is plain `grep`, chapter 12 is `grep -rEn` (extended regex with line numbers). Outputs differ; pass/fail semantics same. The three definitions should converge to one canonical script (chapter 12 version) and other places should `exec` it. Otherwise downstream worker maintains 3 copies. Mark P0 because brief §11(a) is a ship-gate — divergence == undefined ship-gate.

### P0-08-2. Renderer transport over UDS / named pipe — Chromium fetch limitation
§4 spike [renderer-h2-uds] kill-criterion explicitly states "this is true today for stock fetch". The fallback is "tiny transport bridge in the main process". Chapter 15 §4 sub-decision item 9 "Electron renderer transport bridge in main process is recommended for predictability across all OSes" — but chapter 08 §4 only describes it as a fallback. **Pick now**: ship the bridge unconditionally OR ship per-OS transport selection. Currently ambiguous — phase 8 acceptance criteria can't be verified. P0 because it directly drives ship-gate (a) on each OS.

## P1

### P1-08-1. `app:open-external` replacement uses `window.open(url, '_blank')`
Chromium-in-Electron renderer's `window.open` opens within the Electron context (a new BrowserWindow) by default unless `webPreferences.nativeWindowOpen` is configured to delegate to OS browser. Without that config, `window.open` does NOT open the user's default browser. Pin: "Electron main configures `app.on('web-contents-created')` to intercept `setWindowOpenHandler` and delegate `https?:` URLs to `shell.openExternal`". But that re-introduces `shell` import in main — does that violate `lint:no-ipc`? `shell` is not on the lint pattern (only `contextBridge|ipcMain|ipcRenderer`) so technically OK. But §3 says "no Electron `shell`" explicitly. Resolve.

### P1-08-2. Big-bang single PR vs feature branch
Chapter 15 §4 item 4 raises the same question and asks reviewer to confirm. Author chose "single PR". Phase 8 (chapter 13) treats it as a single PR. OK as long as everyone agrees. Cross-link 08 §1 to 15 §4 item 4 explicitly.

### P1-08-3. `additionalArguments` injection of `__CCSM_LISTENER__`
§4 says "passing a static read-only object via `additionalArguments` keeps the grep gate clean". `additionalArguments` is a string array passed to renderer process; the string is parsed into `window.__CCSM_LISTENER__`. The serialized JSON of the descriptor file lives in process argv — visible via `ps`. For UDS path / port number this is benign on a single-user box. Document the threat model (low) explicitly to prevent a future security review re-litigating it.

### P1-08-4. §6 renderer error contract for `Attach` reattach
"Stream errors (Attach, WatchSessions, WatchCrashLog) trigger automatic reattach with exponential backoff capped at 30s. Reattach uses the recorded last-applied seq for Attach." Chapter 06 §5 says client maintains `lastAppliedSeq`; reattach passes `since_seq = lastAppliedSeq`. ✓ Consistent. Good.

### P1-08-5. §3 mapping table — `pty:attach + pty:data` → `PtyService.Attach`
Two existing IPC channels collapse into one server-stream RPC. ✓ Aligned with chapter 04 §4. Good.

### P1-08-6. Vague verbs
- §1 "mechanically reviewable" — fine.
- §4 "minimal" used 3 times for main / preload / renderer. "minimal" is vague; the chapter then enumerates what's NOT in main (no ipcMain.handle, no business logic, etc.). Rewording would improve scannability but content is pinned.
- §5 step 2.b "wrapping each in React Query hooks" — "each" RPC. Clear.

### P1-08-7. Electron tray menu "quit / open settings"
§4 says "tray menu (quit / open settings) — UI, no IPC". Tray menu IS Electron main-process API (`Tray`, `Menu`). Settings open requires sending a message from main to renderer (the renderer handles routing). That message channel is... ipcMain? If no ipcMain, how does main tell renderer to navigate to /settings? Pin: e.g., "main process opens BrowserWindow with `?route=settings` query param" or similar.

## Scalability hotspots

### S1-08-1. React Query default refetch behavior
React Query refetches on focus / reconnect by default. With a Connect transport over loopback, that's cheap. But `WatchSessions` is a server-stream — refetching it is wrong (it's never "stale"). Document the per-RPC stale/refetch policy or downstream implementer creates duplicate streams.

## Markdown hygiene
- §4 ASCII block uses no language tag.
- §5 sub-bullets a-i — good structure.
- §3 mapping table uses backticks consistently.
