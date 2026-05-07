# frontend-tauri

Tauri shell that spawns the ccsm daemon as a Node child and renders the
frontend-web SPA inside a webview.

## Browser parallel access (interim)

Task #694 / wave-2.5 + Task #695 / S1.

The Tauri shell pins the daemon to a stable token + port at spawn time so a
browser tab can talk to the same daemon as the desktop window:

- `CCSM_TOKEN`: read from (or, on first launch, freshly generated into)
  `~/.ccsm/token` (Windows: `%USERPROFILE%\.ccsm\token`). The file holds a
  32-byte hex value (64 ASCII chars) and is created with user-only permissions
  (Unix `0600`; Windows inherits the user-profile ACL — see "Security caveat"
  below).
- `PORT=9876`

Both UIs talk to the same daemon process and therefore share the same SQLite
database, so a session you create in the Tauri sidebar shows up in the browser
tab and vice-versa.

### How to use

1. Launch `ccsm-tauri.exe` (or `pnpm --filter @ccsm/frontend-tauri tauri dev`).
   The Tauri devtools console will log the daemon handshake JSON, e.g.:

   ```
   {"ready":true,"port":9876,"token":"<your-token>"}
   ```

   On first launch, look for `[daemon-mgr] generated new token at <path>` in
   the Rust stderr — that's the same value now stored in `~/.ccsm/token`.

2. Read your token and open the browser:

   ```sh
   # Unix
   TOKEN=$(cat ~/.ccsm/token)
   open "http://127.0.0.1:9876/?token=$TOKEN"

   # Windows PowerShell
   $token = Get-Content "$env:USERPROFILE\.ccsm\token"
   start "http://127.0.0.1:9876/?token=$token"
   ```

   You should see the frontend-web SPA, with the same session list as the
   Tauri shell.

   > Task #696 will let the web SPA fetch the token from the daemon directly,
   > so this manual copy step goes away.

3. Sessions created in either surface appear in the other (they share the
   daemon's sqlite at `%LOCALAPPDATA%\<identifier>\ccsm.db` on Windows).

### Rotating / resetting the token

Delete `~/.ccsm/token` (or `%USERPROFILE%\.ccsm\token`) and restart the Tauri
shell — a new token is generated on next launch.

### Security caveat

A persistent on-disk token is acceptable **only as an interim developer aid**,
because:

- The daemon HTTP server binds to `127.0.0.1` (loopback only), so remote
  hosts on the network cannot reach it.
- The token file is created with user-only permissions (Unix `0600`), so other
  unprivileged local accounts cannot read it. On Windows we rely on the
  default `%USERPROFILE%` ACL, which already restricts the file to the owner
  + SYSTEM + Administrators; we don't strip SYSTEM/Administrators because
  doing so breaks legitimate admin tooling (backup, AV) without materially
  improving the threat model on a single-user dev box.
- However, **any local process running as the same user can still read the
  token file** and connect. Do not run this on a shared machine or with
  untrusted local software.
- This is **not for production**. Future waves will replace with per-run
  ephemeral tokens and DNS-rebinding defenses.

If you need to run another ccsm daemon in parallel (e.g. an independent
`pnpm --filter @ccsm/daemon dev`), it will fail to bind port 9876 — stop the
Tauri shell first or change one of them.
