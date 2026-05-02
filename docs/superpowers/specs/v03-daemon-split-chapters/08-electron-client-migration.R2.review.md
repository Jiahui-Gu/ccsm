# R2 (Security) review — 08-electron-client-migration

## P0

### P0-08-1 — Renderer-main "transport bridge" (loopback TCP) opens DNS-rebinding hole

§4 + ch 14 §1.6: "the bridge is the most-likely-needed adaptation; v0.3 SHOULD ship this bridge for predictability across all OSes." The bridge is "a plain `http2.Server` on `127.0.0.1:<ephemeral>`" — a bare loopback TCP socket. Per ch 03 P0-03-1, this is reachable from any browser tab via DNS rebinding, AND the bridge proxies to the daemon's UDS / named pipe, so the bridge is **a TCP-attack-surface around an otherwise UDS-protected daemon**. The renderer page is trusted Electron-loaded React, but a future loaded URL, an `<iframe>`, an Electron `BrowserView`, or simply a malicious advert in a future feature gives a remote attacker a reach into the daemon.

Spec MUST mandate (one or more of):
- `Host:` header allowlist on the bridge (`Host: 127.0.0.1:<our-port>` only).
- Random per-launch bearer token, stored in `additionalArguments` and required in every bridge request.
- Bridge bound to `127.0.0.1` AND a `Origin: chrome-extension://<our-id>` style enforcement (Electron renderer can be configured to send a known Origin via `webPreferences`).

§4 currently flags only the `lint:no-ipc` grep cleanliness; security of the bridge itself is unaddressed.

### P0-08-2 — Renderer reconstructs Connect transport from descriptor injected via `additionalArguments` — no descriptor authenticity check

§4: "preload reads `window.__CCSM_LISTENER__` (already injected by main via `webPreferences.additionalArguments`)". Main process reads `listener-a.json` from the daemon state dir and forwards to renderer. If the descriptor file is replaced (P0-07-1, P0-03-4), Electron sends every RPC — including `CreateSession.env` (P0-04-1) and `SendInput` keystrokes — to whatever the file points at. There is no signature check, no `boot_id` echo, no Supervisor `/healthz` round-trip before trusting the descriptor.

Spec must require:
- Electron main verifies `Supervisor /healthz` returns the same `boot_id` as the descriptor (added per ch 03 P0-03-4).
- Electron main reads the descriptor only at app start and pins it for the session; reconnect re-reads the descriptor AND re-verifies `boot_id`.

## P1

### P1-08-1 — `app:open-external` replacement uses `window.open(url, '_blank')` for `https?://`

§3: "renderer-only: standard browser `window.open(url, '_blank')` for `https?://`; reject other schemes; no Electron `shell`". In Electron's renderer, `window.open` opens a new BrowserWindow whose `webPreferences` defaults to the parent's; if `nodeIntegration` is on anywhere, an attacker-controlled URL gets Node access. Spec must:
- Pin `webPreferences.nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` for ALL Electron windows including child windows.
- Specify that `window.open` calls are intercepted by `setWindowOpenHandler` and routed to the OS shell (handled by the main process via a single safe IPC… but `lint:no-ipc` grep would flag that — needs a documented carve-out).

The current "no Electron `shell`" + "use browser-native `window.open`" combination is specified at the wrong layer; the renderer cannot safely open OS-level URLs without main-process help.

### P1-08-2 — `lint:no-ipc` grep allows `webContents.send` and other equivalent surfaces

§5h: `grep -r "contextBridge\|ipcMain\|ipcRenderer" packages/electron/src`. Equivalent IPC primitives the grep does NOT catch:
- `webContents.send(channel, ...)` (main → renderer push, useful for daemon-restart events when Connect stream isn't yet wired).
- `BrowserWindow.webContents.executeJavaScript(...)` (main → renderer code injection).
- `MessageChannelMain` / `MessagePortMain` (Electron's modern alternative to ipcMain).
- `process.parentPort` (utility process IPC).

A determined developer "fixes ship-gate (a)" by switching to one of these without using any flagged token. Spec must broaden the grep, add an ESLint rule banning all `electron`-package imports outside `main/index.ts` and the descriptor injector, and gate on both.

### P1-08-3 — Renderer error-handling treats `PERMISSION_DENIED` as "should be impossible"

§6: "PERMISSION_DENIED is treated as a programming error ... UX is 'should be impossible'." On the multi-user Linux `ccsm` group case (ch 02 §2.3), PERMISSION_DENIED is a real user-visible state when user A tries to read user B's session. Spec must define real UX, not "shouldn't happen" — even if v0.3 paper-design says one principal, the actual deployed system has multiple.

## P2

### P2-08-1 — `additionalArguments` strings are auditable in OS process listing

`ps -ef` / Task Manager shows `additionalArguments` content for the renderer process. The descriptor includes the listener address; not secret per se, but if a future field includes a bearer token (P0-08-1 mitigation candidate), it MUST NOT be passed via `additionalArguments` — it MUST be read by main and exposed via the preload context.

### P2-08-2 — No CSP specified for the Electron renderer

`Content-Security-Policy` header / meta tag should be specified at the spec level given the renderer constructs Connect calls and has Listener A reach. `default-src 'self'; connect-src 127.0.0.1:* http: https:` (or stricter) prevents an inadvertent third-party script from exfiltrating session data.

### P2-08-3 — Big-bang single PR makes security review intractable

§5 sequence is ~7 large mechanical steps in one PR. Security-significant changes (descriptor injection, transport selection, error handling for `Unauthenticated`) get lost in 1000s of mechanical 1:1 line edits. Recommend splitting the **security-shaped** parts (descriptor handling, auth-error UX, CSP, `setWindowOpenHandler`) into a separate small PR that lands first, then the mechanical IPC→Connect mapping PR follows.
