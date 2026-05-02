# 02 — Process Topology

v0.3 has exactly two long-lived processes per user machine: `ccsm-daemon` (system service, backend-authoritative) and `ccsm-electron` (per-user desktop GUI, thin Connect client). The daemon is installed as a per-OS system-level service (Windows Service, launchd `LaunchDaemon`, systemd system unit), starts on boot, runs without an interactive login, and survives Electron exit. Electron is launched by the user from the Start menu / Dock / desktop launcher and connects to the daemon over Listener A. This chapter pins the per-OS service shape, startup ordering, install/uninstall responsibility, and the lifecycle contract Electron depends on.

### 1. Process inventory

| Process | Identity | Lifetime | Started by | Stopped by | Hosts |
| --- | --- | --- | --- | --- | --- |
| `ccsm-daemon` | per-OS service account (see §2) | boot → shutdown | OS service manager | OS service manager (or `shutdown` RPC on Supervisor UDS, admin only) | Listener A, Supervisor UDS, all session/PTY/SQLite state |
| `ccsm-electron` | logged-in user | user-launched → user-quit (or OS logout) | user (Start menu / Dock) | user (window close, tray quit, OS logout) | Connect client, UI, no business logic |
| `claude` CLI subprocess(es) | daemon's service account | per session lifetime | daemon (per session create) | daemon (on session destroy / PTY EOF / crash) | one per active Session |

There is **no** intermediate broker, no shared-memory layer, no file-watcher IPC. Every Electron → daemon call is a Connect RPC over Listener A. Every claude CLI process is a child of the daemon (NOT of Electron).

### 2. Per-OS service shape

#### 2.1 Windows (LocalService account)

- Service name: `ccsm-daemon`. Display name: `Claude Code Session Manager`.
- Account: `NT AUTHORITY\LocalService`. **Why not LOCAL_SYSTEM**: principle of least privilege; `LocalService` cannot read other users' profiles, which is correct because v0.3's only principal is the locally logged-in user issuing peer-cred-authenticated requests via Listener A. (LocalService can still bind a UDS / named pipe in `ProgramData` reachable by the user — see [03-listeners-and-transport](./03-listeners-and-transport.md) §4.)
- Registration tool: `node-windows` OR direct `sc.exe create` from the installer (brief §9). MUST-SPIKE: `node-windows` is unmaintained for Node 22 sea bundles; `sc.exe` from MSI custom action is the lower-risk fallback. See [14-risks-and-spikes](./14-risks-and-spikes.md).
- Start mode: `Automatic (Delayed Start)` to avoid contention with boot-critical services and to let networking init.
- Recovery: First failure → restart after 5s; second failure → restart after 30s; subsequent → run no command (let crash log capture, see [09-crash-collector](./09-crash-collector.md)).
- File locations (per [07-data-and-state](./07-data-and-state.md)): binary in `%ProgramFiles%\ccsm\ccsm-daemon.exe`; state in `%ProgramData%\ccsm\` (writable by LocalService).

> **MUST-SPIKE [win-localservice-uds]**: hypothesis: a UDS / named pipe created by LocalService in `%ProgramData%\ccsm\` with explicit DACL granting the interactive user `GENERIC_READ|GENERIC_WRITE` is reachable from a per-user Electron process. · validation: 25H2 VM, install service, run Electron from a non-admin user, attempt connect. · fallback: bind to `127.0.0.1:<ephemeral-port>` and write port to a user-readable file in `%LOCALAPPDATA%\ccsm\port`; combine with peer-cred via `GetExtendedTcpTable` + PID mapping.

#### 2.2 macOS (launchd LaunchDaemon)

- Plist: `/Library/LaunchDaemons/com.ccsm.daemon.plist`.
- **LaunchDaemon vs LaunchAgent**: choose **LaunchDaemon**. **Why**: brief §7 mandates "survives logout" because v0.4 web/iOS clients (additive) reach the daemon while no user is logged in. A LaunchAgent runs only inside an interactive user session and would force a disruptive change in v0.4. Picking LaunchDaemon now is the zero-rework choice.
- Account: dedicated `_ccsm` system user (created by installer pkg postinstall). **Why not root**: same least-privilege argument as Windows.
- Bootstrap: `RunAtLoad=true`, `KeepAlive={SuccessfulExit=false, Crashed=true}`.
- File locations: binary in `/Library/Application Support/ccsm/ccsm-daemon`; state in `/Library/Application Support/ccsm/state/` (chowned to `_ccsm`); UDS path `/var/run/ccsm/daemon.sock` (created by daemon at startup with mode `0660`, group `_ccsm`; per-user Electron joins group via installer step OR daemon writes a per-user proxy socket — MUST-SPIKE).

> **MUST-SPIKE [macos-uds-cross-user]**: hypothesis: `/var/run/ccsm/daemon.sock` with group ACL is reachable from per-user Electron without granting Full Disk Access. · validation: clean macOS 14+ install, run installer, log in as second user, launch Electron, attempt connect. · fallback: per-user UDS at `~/Library/Containers/com.ccsm.electron/Data/ccsm.sock` proxied by a launchd per-user agent (this would be a v0.3 addition; we want to avoid it).

#### 2.3 Linux (systemd system unit)

- Unit: `/etc/systemd/system/ccsm-daemon.service`.
- `User=ccsm` (created by .deb/.rpm postinst). **Why not user-level systemd unit**: brief §7 explicitly mandates "system-level (not `--user`)" for the same survives-logout reason as macOS.
- Directives: `Type=notify`, `Restart=on-failure`, `RestartSec=5s`, `WatchdogSec=30s` (daemon emits `READY=1` then `WATCHDOG=1` keepalives — see [09-crash-collector](./09-crash-collector.md) §6).
- File locations (XDG-respecting where possible for system-mode): binary `/usr/lib/ccsm/ccsm-daemon`; state `/var/lib/ccsm/`; UDS `/run/ccsm/daemon.sock` (group `ccsm`, mode `0660`).
- Per-user Electron: installer adds the installing user to group `ccsm` (postinst, requires logout/login). MUST-SPIKE: this is intrusive; alternative is a per-user proxy as above.

### 3. Startup order

1. **Boot**: OS service manager starts `ccsm-daemon`.
2. Daemon: open SQLite, run migrations, replay WAL → reconstruct in-memory session list.
3. Daemon: start Supervisor UDS (`/healthz` returns 503 until step 5).
4. Daemon: re-spawn `claude` CLI subprocesses for sessions marked `should-be-running` in SQLite (cwd, env restored; PTY host re-attaches; see [06-pty-snapshot-delta](./06-pty-snapshot-delta.md) §7).
5. Daemon: bind Listener A; instantiate Listener trait array (slot 0 = Listener A; slot 1 = `null` reserved for v0.4 Listener B); Supervisor `/healthz` returns 200.
6. **User login** (any time later): user launches Electron from Start menu / Dock.
7. Electron: read connection descriptor (UDS path or loopback port — see [03-listeners-and-transport](./03-listeners-and-transport.md) §3); connect; `Hello` RPC; subscribe to session-list stream.

The daemon MUST be in state (5) before accepting any Listener A connect. If a client connects mid-startup (Supervisor `/healthz` 503), the daemon refuses with `UNAVAILABLE` Connect error code; Electron retries with backoff.

### 4. Shutdown order

- **OS-initiated** (shutdown / reboot / `systemctl stop` / Services.msc Stop): service manager sends platform stop signal (Windows: `SERVICE_CONTROL_STOP`; mac/linux: `SIGTERM`). Daemon: stop accepting new Listener A connects; finish in-flight unary RPCs (≤5s budget); for streaming RPCs, send `aborted` and close; gracefully terminate `claude` CLI subprocesses (`SIGTERM` then `SIGKILL` after 3s); checkpoint SQLite WAL; flush crash log; exit 0.
- **Electron quit**: daemon notices via Listener A connection close; **does NOT** terminate sessions or PTYs (brief §11(b)). claude CLI subprocesses keep running; PTY host keeps recording deltas; on next Electron launch the snapshots replay (see [06-pty-snapshot-delta](./06-pty-snapshot-delta.md)).
- **`shutdown` RPC on Supervisor UDS**: only callable by an admin (peer-cred uid == root/SYSTEM/Administrators) — Electron is NOT admin. Used by installer uninstall, never by Electron UI. Triggers the OS-initiated path internally.

### 5. Install / uninstall responsibility

| Step | Responsibility | Notes |
| --- | --- | --- |
| Place binary | installer (MSI / pkg / deb / rpm) | See [10-build-package-installer](./10-build-package-installer.md) |
| Create service account | installer | `_ccsm` (mac), `ccsm` (linux); LocalService is built-in (win) |
| Register service | installer | `sc.exe create` / `launchctl bootstrap` / `systemctl enable` |
| Start service | installer (post-register) | Verifies Supervisor `/healthz` returns 200 within 10s before declaring success |
| Create state dir | daemon (first run) | Daemon owns schema; installer only creates parent dir if needed |
| Place Electron binary | installer | Per-user OR all-users — picked per OS, see [10](./10-build-package-installer.md) |
| Stop service | uninstaller | Wait for clean exit (≤10s) before file deletion |
| Unregister service | uninstaller | `sc.exe delete` / `launchctl bootout` / `systemctl disable` |
| Delete state | uninstaller (with user opt-in prompt) | Default: keep state on uninstall, delete only on explicit "remove user data" tick |
| Verify clean uninstall | ship-gate (d) test | See [12-testing-strategy](./12-testing-strategy.md) §6 |

### 6. Process boundary contract (Electron MUST assume)

- Daemon may restart at any time. Electron MUST tolerate Connect `UNAVAILABLE` with auto-reconnect + exponential backoff (cap 30s).
- Daemon may be older or newer than Electron after either side updates. Electron MUST send a client version in `Hello`; daemon rejects incompatible versions with `FAILED_PRECONDITION` and a structured detail listing min compatible client. (See [04-proto-and-rpc-surface](./04-proto-and-rpc-surface.md) §3.)
- Sessions are daemon-owned. Closing the Electron window does NOT close sessions. The user destroys sessions only via the explicit `DestroySession` RPC.

### 7. v0.4 delta

- **Add** to startup order step 5: instantiate Listener B in slot 1 of the listener array (existing trait, new factory call). Existing handler code unchanged.
- **Add** cloudflared subprocess to daemon supervision (similar to `claude` CLI: spawn, monitor, restart). New SQLite row in a new `tunnel_state` table (additive; no existing table modified).
- **Add** to install step list: optionally configure cloudflared (user-toggled, off by default). Existing service registration unchanged.
- Service account, file locations, startup ordering, shutdown contract, Supervisor UDS shape: **unchanged**.
