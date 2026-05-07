# frontend-tauri

Tauri shell that spawns the ccsm daemon as a Node child and renders the
frontend-web SPA inside a webview.

## Browser parallel access (interim)

Task #694 / wave-2.5.

For developer convenience, the Tauri shell pins the daemon to a fixed token
and a fixed port at spawn time:

- `CCSM_TOKEN=ccsm-dev-fixed-token`
- `PORT=9876`

This lets you keep `ccsm-tauri.exe` running and **also** open the same daemon
in a regular browser tab in parallel — both UIs talk to the same daemon
process and therefore share the same SQLite database, so a session you create
in the Tauri sidebar shows up in the browser tab and vice-versa.

### How to use

1. Launch `ccsm-tauri.exe` (or `pnpm --filter @ccsm/frontend-tauri tauri dev`).
   The Tauri devtools console will log the daemon handshake JSON, e.g.:

   ```
   {"ready":true,"port":9876,"token":"ccsm-dev-fixed-token"}
   ```

2. In a browser, open:

   ```
   http://127.0.0.1:9876/?token=ccsm-dev-fixed-token
   ```

   You should see the frontend-web SPA, with the same session list as the
   Tauri shell.

3. Sessions created in either surface appear in the other (they share the
   daemon's sqlite at `%LOCALAPPDATA%\<identifier>\ccsm.db` on Windows).

### Security caveat

A fixed token is acceptable **only as an interim developer aid**, because:

- The daemon HTTP server binds to `127.0.0.1` (loopback only), so remote
  hosts on the network cannot reach it.
- However, **any local process running as the same user can connect** with
  the fixed token. Do not run this on a shared machine or with untrusted
  local software.
- This is **not for production**. wave-3 will replace the fixed token with a
  per-run ephemeral token and add DNS-rebinding defenses.

If you need to run another ccsm daemon in parallel (e.g. an independent
`pnpm --filter @ccsm/daemon dev`), it will fail to bind port 9876 — stop the
Tauri shell first or change one of them.
