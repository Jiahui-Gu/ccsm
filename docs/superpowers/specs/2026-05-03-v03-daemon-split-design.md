# v0.3 Daemon Split — Design Spec

Status: ready for implementation
Spec date: 2026-05-03
Base branch: working
Pipeline: spec-pipeline (8 stages)

> Input brief (locked decisions, not a chapter): see git history for `docs/superpowers/specs/v03-daemon-split-chapters/00-brief.md` (the chapter directory is removed in this commit; the brief lives in git history at the same path on prior commits in this branch).

## Table of Contents

- [Chapter 01 — Overview](#chapter-01--overview)
- [Chapter 02 — Process Topology](#chapter-02--process-topology)
- [Chapter 03 — Listeners and Transport](#chapter-03--listeners-and-transport)
- [Chapter 04 — Proto and RPC Surface](#chapter-04--proto-and-rpc-surface)
- [Chapter 05 — Session and Principal](#chapter-05--session-and-principal)
- [Chapter 06 — PTY: Snapshot + Delta](#chapter-06--pty-snapshot--delta)
- [Chapter 07 — Data and State](#chapter-07--data-and-state)
- [Chapter 08 — Electron Client Migration](#chapter-08--electron-client-migration)
- [Chapter 09 — Crash Collector](#chapter-09--crash-collector)
- [Chapter 10 — Build, Package, Installer](#chapter-10--build-package-installer)
- [Chapter 11 — Monorepo Layout](#chapter-11--monorepo-layout)
- [Chapter 12 — Testing Strategy](#chapter-12--testing-strategy)
- [Chapter 13 — Release Slicing](#chapter-13--release-slicing)
- [Chapter 14 — Risks and Spikes](#chapter-14--risks-and-spikes)
- [Chapter 15 — Zero-Rework Audit](#chapter-15--zero-rework-audit)
- [Changelog](#changelog)

---

## Chapter 01 — Overview

This chapter states the v0.3 mission in one place: split the existing single-process Electron app into two locally cohabiting binaries (`ccsm-daemon` + `ccsm-electron`) that communicate via Connect-RPC over a loopback transport, while structuring every artifact (proto, principal model, listener trait, installer, monorepo layout) so that v0.4 — which adds web client, iOS client, Cloudflare Tunnel, cloudflared sidecar, and CF Access JWT validation — is a **purely additive** change. v0.3 ships exactly the local-machine subset of the diagram in the input brief, minus cloudflared and minus runtime Listener B.

### 1.1 Goals (v0.3)

1. **Process split**: convert the existing Electron app into two binaries; daemon owns all state (sessions, PTY, SQLite, cwd, crash log); Electron is a thin Connect client.
2. **Single transport**: every Electron → daemon call uses Connect-RPC over Listener A; **zero** `ipcMain` / `contextBridge` / `ipcRenderer` survives in `packages/electron/src` (brief §11(a)).
3. **System service**: daemon installs as a per-OS system service (Win Service / launchd LaunchDaemon / systemd system unit), starts on boot, survives Electron exit (brief §7).
4. **Frozen wire schema**: every RPC and message v0.3 ships is forever-stable; v0.4 may only add (brief §6).
5. **PTY zero-loss reconnect**: 1-hour live `claude` workload survives Electron SIGKILL + relaunch with binary-identical terminal state (brief §11(c)).
6. **Clean installer round-trip**: fresh Win 11 25H2 VM install → register → run → uninstall → no residue (brief §11(d)).
7. **Crash collector local-only**: capture daemon faults to SQLite, expose via `GetCrashLog` RPC, render in Settings UI (brief §10).

### 1.2 Non-goals (v0.3, deferred to v0.4)

| Non-goal | Why deferred | Where it lands |
| --- | --- | --- |
| Web client | additive package + same proto | v0.4 `packages/web` |
| iOS client | additive package + same proto | v0.4 `packages/ios` |
| Cloudflare Tunnel + cloudflared sidecar lifecycle | requires Listener B JWT path; v0.3 ships Listener B as stub slot only | v0.4 daemon: instantiate Listener B from existing trait |
| CF Access JWT validation middleware | code path not loaded in v0.3 | v0.4: add `JwtValidator` middleware to Listener B factory |
| GitHub OAuth IdP integration | identity is federated through CF Access; nothing to do locally in v0.3 | v0.4: cloudflared-side config |
| Crash log network upload | local-only crash storage in v0.3 | v0.4: additive uploader reading existing SQLite log |
| Multi-principal sessions (anything other than `local-user`) | enforced via `owner_id` filter from day one; v0.3 only emits `local-user` | v0.4: emit `cf-access:<sub>` principals |

These are non-goals **inside v0.3 only** — they MUST be reachable from v0.3 by additive change alone (see [Chapter 15 — Zero-Rework Audit](#chapter-15--zero-rework-audit)).

### 1.3 Scope reduction from the diagram

The brief diagram contains the full v0.4+ topology. v0.3 ships exactly the boxes inside the `user's local machine` frame, with these subtractions:

- ❌ `cloudflared (sidecar)` box: not spawned, not packaged, not installed.
- ❌ `Listener B: 127.0.0.1:PORT_TUNNEL` runtime: socket not bound, JWT middleware not wired, config not exposed in UI.
- ❌ Web client / iOS client / GitHub OAuth IdP / Cloudflare Edge: all upstream of cloudflared, all out of scope.
- ✅ `Listener A: loopback / UDS (peer-cred, JWT bypass)`: shipped.
- ✅ `Supervisor UDS (control plane)`: shipped — `/healthz`, `hello`, `shutdown` RPCs.
- ✅ All daemon internals: Session manager, PTY host (`xterm-headless` snapshot+delta), `claude` CLI subprocess management, SQLite, cwd state, crash collector — shipped.
- ✅ Desktop client (Electron) hitting Listener A — shipped.
- ✅ **Listener trait/interface**: shipped. Listener B reserved as a stub slot in the listener array (no socket, no middleware, but the trait + the array shape exist) (brief §1).

### 1.4 Zero-rework rule (governance, not a feature)

v0.3 is the foundation v0.4 builds on. The rule, restated from the input brief §"ZERO-REWORK RULE":

> When v0.4 lands web client + iOS client + Cloudflare Tunnel + cloudflared sidecar + CF Access JWT validation on Listener B, what code/proto/schema/installer changes are required? **Acceptable answers: "none" / "purely additive". Unacceptable: "rename X" / "change message Y shape" / "move file Z" / "split function into two".**

Every chapter MUST close (or contribute to [Chapter 15 — Zero-Rework Audit](#chapter-15--zero-rework-audit)) by stating the v0.4 delta for each design decision in that chapter. Chapter 15 is the consolidated audit; reviewers MUST gate the entire spec on it.

### 1.5 Audience and reading order

This spec is written for: (a) reviewers who must catch zero-rework violations before any code is written; (b) implementers who will translate chapters into the parallel task DAG (stage 6); (c) future readers of the v0.4 spec who need to understand what is already locked.

Suggested order:
1. This chapter.
2. [Chapter 02 — Process Topology](#chapter-02--process-topology) — what runs where.
3. [Chapter 03 — Listeners and Transport](#chapter-03--listeners-and-transport) — how they talk.
4. [Chapter 04 — Proto and RPC Surface](#chapter-04--proto-and-rpc-surface) — what they say.
5. [Chapter 05 — Session and Principal](#chapter-05--session-and-principal) — who owns what.
6. [Chapter 06 — PTY: Snapshot + Delta](#chapter-06--pty-snapshot--delta) — the hard part.
7. [Chapter 07 — Data and State](#chapter-07--data-and-state) — where bytes live.
8. [Chapter 08 — Electron Client Migration](#chapter-08--electron-client-migration) — the cutover.
9. [Chapter 09 — Crash Collector](#chapter-09--crash-collector), [Chapter 10 — Build, Package, Installer](#chapter-10--build-package-installer), [Chapter 11 — Monorepo Layout](#chapter-11--monorepo-layout), [Chapter 12 — Testing Strategy](#chapter-12--testing-strategy), [Chapter 13 — Release Slicing](#chapter-13--release-slicing), [Chapter 14 — Risks and Spikes](#chapter-14--risks-and-spikes).
10. **[Chapter 15 — Zero-Rework Audit](#chapter-15--zero-rework-audit) — the gate.**

### 1.6 Glossary (used across chapters)

- **Daemon** = `ccsm-daemon`, the single-binary backend (Node 22 sea or pkg, native deps embedded).
- **Electron** = `ccsm-electron`, the thin desktop client (renderer + minimal main; no business logic).
- **Listener** = a daemon-side socket + transport + auth-middleware bundle; v0.3 instantiates Listener A only.
- **Listener A** = loopback/UDS socket, peer-cred authentication, JWT validation bypassed.
- **Listener B** = (reserved slot) 127.0.0.1:PORT_TUNNEL, CF Access JWT validation, cloudflared-only consumer; v0.3 stub, v0.4 instantiated.
- **Principal** = the entity an RPC call is attributed to. v0.3: always `local-user`. v0.4: `local-user` or `cf-access:<sub>`.
- **Session** = a long-lived terminal session bound to a principal (`owner_id`) and backed by a PTY + claude CLI subprocess.
- **Supervisor** = control-plane UDS exposing `/healthz`, `hello`, `shutdown`; separate from data-plane Listener A.
- **MUST-SPIKE** = a design decision that depends on platform/library behavior we have not yet validated; the spec lists hypothesis + validation + fallback for each.

### 1.7 v0.4 delta summary (preview of chapter 15)

Stated up front so reviewers can challenge the entire spec against this list:

- **Add** `packages/web` and `packages/ios` to the workspace; both consume the same generated proto client. **Daemon code: unchanged.**
- **Add** cloudflared sidecar lifecycle to daemon (spawn / supervise / config); Listener B socket bound; JWT middleware factory wired. **Listener trait + handler code: unchanged.**
- **Add** `cf-access:<sub>` principal derivation in the JWT middleware; principal flows through the same `ctx.principal` field every handler already reads. **Handler code: unchanged.**
- **Add** crash log uploader; reads existing SQLite table; new RPC for upload-status; capture path unchanged. **Crash schema: unchanged.**
- **Add** new RPCs in proto (e.g., `WebClientRegister`, `TunnelStatus`); existing RPCs and messages: forever-stable, no field renames, no semantic changes (brief §6).

If at any point during review a chapter's v0.4 delta requires changing one of the bullets above (rename, reshape, split), that chapter MUST be re-designed inside v0.3 before merge.

---

## Chapter 02 — Process Topology

v0.3 has exactly two long-lived processes per user machine: `ccsm-daemon` (system service, backend-authoritative) and `ccsm-electron` (per-user desktop GUI, thin Connect client). The daemon is installed as a per-OS system-level service (Windows Service, launchd `LaunchDaemon`, systemd system unit), starts on boot, runs without an interactive login, and survives Electron exit. Electron is launched by the user from the Start menu / Dock / desktop launcher and connects to the daemon over Listener A. This chapter pins the per-OS service shape, startup ordering, install/uninstall responsibility, and the lifecycle contract Electron depends on.

#### 1. Process inventory

| Process | Identity | Lifetime | Started by | Stopped by | Hosts |
| --- | --- | --- | --- | --- | --- |
| `ccsm-daemon` | per-OS service account (see §2) | boot → shutdown | OS service manager | OS service manager (or `shutdown` RPC on Supervisor UDS / named pipe, admin-only via peer-cred — see [Chapter 03](#chapter-03--listeners-and-transport) §7) | Listener A, Supervisor UDS (UDS-only on every OS, no loopback-TCP fallback ever), all session/PTY/SQLite state |
| `ccsm-electron` | logged-in user | user-launched → user-quit (or OS logout) | user (Start menu / Dock) | user (window close, tray quit, OS logout) | Connect client, UI, no business logic |
| `claude` CLI subprocess(es) | daemon's service account | per session lifetime | daemon (per session create) | daemon (on session destroy / PTY EOF / crash) | one per active Session |

There is **no** intermediate broker, no shared-memory layer, no file-watcher IPC. Every Electron → daemon call is a Connect RPC over Listener A. Every claude CLI process is a child of the daemon (NOT of Electron).

> **v0.3 single-Electron-user posture (closes R0 02-P0.1)**: v0.3 supports exactly one Electron user per host. The peer-cred uid checked on Listener A pins the daemon to a single principal at install time; concurrent connects from a second interactive user are rejected with `PERMISSION_DENIED`. Multi-user on one host requires v0.4 cf-access via Listener B (see [Chapter 15](#chapter-15--zero-rework-audit) §3 forbidden-pattern entry).

#### 2. Per-OS service shape

##### 2.1 Windows (LocalService account)

- Service name: `ccsm-daemon`. Display name: `Claude Code Session Manager`.
- Account: `NT AUTHORITY\LocalService`. **Why not LOCAL_SYSTEM**: principle of least privilege; `LocalService` cannot read other users' profiles, which is correct because v0.3's only principal is the locally logged-in user issuing peer-cred-authenticated requests via Listener A. (LocalService can still bind a UDS / named pipe in `ProgramData` reachable by the user — see [Chapter 03](#chapter-03--listeners-and-transport) §4.)
- Registration tool: `node-windows` OR direct `sc.exe create` from the installer (brief §9). MUST-SPIKE: `node-windows` is unmaintained for Node 22 sea bundles; `sc.exe` from MSI custom action is the lower-risk fallback. See [Chapter 14](#chapter-14--risks-and-spikes).
- Start mode: `Automatic (Delayed Start)` to avoid contention with boot-critical services and to let networking init.
- Recovery: First failure → restart after 5s; second failure → restart after 30s; subsequent → run no command (let crash log capture, see [Chapter 09](#chapter-09--crash-collector)). **Failure-counter reset (closes R0 02-P1.2)**: `failureResetPeriod = 86400s` (24h) — set via `sc.exe failure ccsm-daemon reset= 86400 actions= restart/5000/restart/30000//0`. Without this knob the SCM counter never resets and a daemon that crashes once a month accumulates "subsequent" verdicts indefinitely, silently losing recovery fidelity.
- File locations (per [Chapter 07](#chapter-07--data-and-state)): binary in `%ProgramFiles%\ccsm\ccsm-daemon.exe`; state in `%ProgramData%\ccsm\` (writable by LocalService).

> **MUST-SPIKE [win-localservice-uds]**: hypothesis: a UDS / named pipe created by LocalService in `%ProgramData%\ccsm\` with explicit DACL granting the interactive user `GENERIC_READ|GENERIC_WRITE` is reachable from a per-user Electron process. · validation: 25H2 VM, install service, run Electron from a non-admin user, attempt connect. · fallback: bind to `127.0.0.1:<ephemeral-port>` and write port to a user-readable file in `%LOCALAPPDATA%\ccsm\port`; combine with peer-cred via `GetExtendedTcpTable` + PID mapping.

##### 2.2 macOS (launchd LaunchDaemon)

- Plist: `/Library/LaunchDaemons/com.ccsm.daemon.plist`.
- **LaunchDaemon vs LaunchAgent**: choose **LaunchDaemon**. **Why**: brief §7 mandates "survives logout" because v0.4 web/iOS clients (additive) reach the daemon while no user is logged in. A LaunchAgent runs only inside an interactive user session and would force a disruptive change in v0.4. Picking LaunchDaemon now is the zero-rework choice.
- Account: dedicated `_ccsm` system user (created by installer pkg postinstall). **Why not root**: same least-privilege argument as Windows.
- Bootstrap: `RunAtLoad=true`, `KeepAlive={SuccessfulExit=false, Crashed=true}`.
- File locations: binary in `/Library/Application Support/ccsm/ccsm-daemon`; state in `/Library/Application Support/ccsm/state/` (chowned to `_ccsm`); UDS path `/var/run/com.ccsm.daemon/daemon.sock` (reverse-DNS subdir per Apple SIP-safe convention; created by daemon at startup with mode `0660`, group `_ccsm`; per-user Electron joins group via installer step OR daemon writes a per-user proxy socket — MUST-SPIKE). Supervisor UDS is at `/var/run/com.ccsm.daemon/supervisor.sock` (UDS-only on every OS — see [Chapter 03](#chapter-03--listeners-and-transport) §7).

> **MUST-SPIKE [macos-uds-cross-user]**: hypothesis: `/var/run/ccsm/daemon.sock` with group ACL is reachable from per-user Electron without granting Full Disk Access. · validation: clean macOS 14+ install, run installer, log in as second user, launch Electron, attempt connect. · fallback: per-user UDS at `~/Library/Containers/com.ccsm.electron/Data/ccsm.sock` proxied by a launchd per-user agent (this would be a v0.3 addition; we want to avoid it).

##### 2.3 Linux (systemd system unit)

- Unit: `/etc/systemd/system/ccsm-daemon.service`.
- `User=ccsm` (created by .deb/.rpm postinst). **Why not user-level systemd unit**: brief §7 explicitly mandates "system-level (not `--user`)" for the same survives-logout reason as macOS.
- Directives: `Type=notify`, `Restart=on-failure`, `RestartSec=5s`, `WatchdogSec=30s` (daemon emits `READY=1` then `WATCHDOG=1` keepalives — see [Chapter 09](#chapter-09--crash-collector) §6).
- File locations (XDG-respecting where possible for system-mode): binary `/usr/lib/ccsm/ccsm-daemon`; state `/var/lib/ccsm/`; UDS `/run/ccsm/daemon.sock` (group `ccsm`, mode `0660`); Supervisor UDS `/run/ccsm/supervisor.sock` (UDS-only on every OS — see [Chapter 03](#chapter-03--listeners-and-transport) §7).
- Per-user Electron: installer adds the installing user to group `ccsm` (postinst, requires logout/login). MUST-SPIKE: this is intrusive; alternative is a per-user proxy as above.

#### 3. Startup order

1. **Boot**: OS service manager starts `ccsm-daemon`.
2. Daemon: open SQLite, run migrations, replay WAL → reconstruct in-memory session list.
3. Daemon: start Supervisor UDS / named pipe (UDS-only on every OS — see [Chapter 03](#chapter-03--listeners-and-transport) §7; `/healthz` returns 503 until step 5).
4. Daemon: re-spawn `claude` CLI subprocesses for sessions marked `should-be-running` in SQLite (cwd, env restored; PTY host re-attaches; see [Chapter 06](#chapter-06--pty-snapshot--delta) §7). **Orphan-uid validation (closes R0 02-P1.3)**: before re-spawn, daemon resolves each session's `owner_uid` against the current host (Win: `LookupAccountSid`; mac/linux: `getpwuid`). Sessions whose `owner_uid` no longer maps to a live account are NOT re-spawned; they are marked `state=ORPHANED` and a `crash_log` entry with `source = "session_restore"` is written. This prevents a deleted-and-recreated user (same name, different SID/uid) from inheriting the previous user's claude CLI processes.
<!-- F2: closes R0 03-P0.1 / R2 P0-02-3 / R2 P0-03-4 — startup writes the typed sentinel into slot 1 and writes the descriptor atomically before /healthz returns 200. -->
5. Daemon: generate a fresh `boot_id` (UUIDv4) and pin it in memory; bind Listener A; instantiate the Listener trait array (slot 0 = `makeListenerA(env)`; slot 1 = typed sentinel `RESERVED_FOR_LISTENER_B` from [Chapter 03](#chapter-03--listeners-and-transport) §1); assert `listeners[1] === RESERVED_FOR_LISTENER_B` and abort startup if not (the assert + ESLint rule together close R0 03-P0.1 — see [Chapter 03](#chapter-03--listeners-and-transport) §1); atomically write `listener-a.json` (temp + fsync + rename, per [Chapter 03](#chapter-03--listeners-and-transport) §3.1) carrying `boot_id` / `daemon_pid` / `listener_addr` / `protocol_version`; THEN flip Supervisor `/healthz` to return 200. Order matters — Electron's startup handshake ([Chapter 03](#chapter-03--listeners-and-transport) §3.3) reads `boot_id` from the descriptor file (it is NOT echoed in `HelloResponse` — proto fields are pinned to `meta` / `daemon_version` / `proto_version` / `principal` / `listener_id`; see [Chapter 04](#chapter-04--proto-and-rpc-surface) §3), so the descriptor MUST be on disk before `/healthz` 200 or the renderer's first connect attempt sees a stale or missing file.
6. **User login** (any time later): user launches Electron from Start menu / Dock.
7. Electron: read connection descriptor (UDS path or loopback port — see [Chapter 03](#chapter-03--listeners-and-transport) §3); connect; `Hello` RPC; subscribe to session-list stream.

The daemon MUST be in state (5) before accepting any Listener A connect. If a client connects mid-startup (Supervisor `/healthz` 503), the daemon refuses with `UNAVAILABLE` Connect error code; Electron retries with backoff. **Structured error (closes R0 02-P0.2)**: the `UNAVAILABLE` response carries an `ErrorDetail` with `code = "daemon.starting"` (defined in [Chapter 04](#chapter-04--proto-and-rpc-surface) §2 — F3 added it there) so Electron can distinguish "daemon is booting, retry soon" from "daemon crashed, escalate to user".

> **Test ref (closes R4 P1 startup-ordering invariant)**: `packages/daemon/test/integration/daemon-startup-ordering.spec.ts` asserts (a) Listener A bind happens only after step 5, (b) Supervisor `/healthz` returns 503 during steps 1–4 and 200 only after step 5 completes, (c) the descriptor file is readable on disk before `/healthz` flips to 200, (d) connect attempts during steps 1–4 are refused with `UNAVAILABLE` + `ErrorDetail.code = "daemon.starting"`, (e) orphan-uid sessions in step 4 are marked `ORPHANED` and not re-spawned.

#### 4. Shutdown order

- **OS-initiated** (shutdown / reboot / `systemctl stop` / Services.msc Stop): service manager sends platform stop signal (Windows: `SERVICE_CONTROL_STOP`; mac/linux: `SIGTERM`). Daemon: stop accepting new Listener A connects; finish in-flight unary RPCs (≤5s budget); for streaming RPCs, send `aborted` and close; gracefully terminate `claude` CLI subprocesses (`SIGTERM` then `SIGKILL` after 3s); checkpoint SQLite WAL; flush crash log; exit 0.
- **Electron quit**: daemon notices via Listener A connection close; **does NOT** terminate sessions or PTYs (brief §11(b)). claude CLI subprocesses keep running; PTY host keeps recording deltas; on next Electron launch the snapshots replay (see [Chapter 06](#chapter-06--pty-snapshot--delta)).
- **`shutdown` RPC on Supervisor UDS / named pipe**: only callable by an admin (peer-cred uid/SID check per [Chapter 03](#chapter-03--listeners-and-transport) §7.1) — Electron is NOT admin. Used by installer uninstall, never by Electron UI. Triggers the OS-initiated path internally. <!-- F2: closes R2 P0-02-2 / R2 P0-03-3 — Supervisor is UDS-only on every OS; no loopback-TCP fallback exists, ever. -->

> **Supervisor local-only forever (closes R0 02-P0.3)**: Supervisor UDS / named pipe is local-only on every OS for v0.3 AND every future version. v0.4 MUST NOT expose Supervisor endpoints (`/healthz`, `/shutdown`, any future Supervisor RPC) via Listener B or any remote-reachable surface. The corresponding chapter 15 §3 forbidden-pattern entry is the mechanical enforcement (audit-chapter row + reviewer checklist). Rationale: Supervisor admin-gate relies on per-OS peer-cred (`SO_PEERCRED` / named pipe DACL); these primitives have no remote analogue, so re-exposing Supervisor would silently downgrade the admin gate to whatever Listener B authentication negotiates.

> **Test refs**:
> - **R4 P1 shutdown ≤5s budget / ≤3s SIGKILL** — `packages/daemon/test/integration/daemon-shutdown.spec.ts` asserts (a) on `SIGTERM`, daemon stops accepting new Listener A connects within 100ms, (b) in-flight unary RPCs complete OR are aborted within 5s, (c) streaming RPCs receive `aborted` and close within 5s, (d) `claude` CLI subprocesses receive `SIGTERM`, then `SIGKILL` exactly 3s later if still alive, (e) SQLite WAL is checkpointed before exit, (f) total shutdown wall-clock ≤ 8s (5s RPC budget + 3s SIGKILL window).
> - **R4 P1 shutdown admin-only** — `packages/daemon/test/integration/supervisor/admin-only.spec.ts` asserts (a) `shutdown` RPC from a non-admin peer-cred uid is rejected with `PERMISSION_DENIED`, (b) `shutdown` RPC from admin uid (per [Chapter 03](#chapter-03--listeners-and-transport) §7.1 uid-allowlist) succeeds and triggers the OS-initiated shutdown path, (c) on Windows the named-pipe DACL denies the connect outright when the caller is not in the local Administrators group.

#### 5. Install / uninstall responsibility

| Step | Responsibility | Notes |
| --- | --- | --- |
| Place binary | installer (MSI / pkg / deb / rpm) | See [Chapter 10](#chapter-10--build-package-installer) |
| Create service account | installer | `_ccsm` (mac), `ccsm` (linux); LocalService is built-in (win) |
| Register service | installer | `sc.exe create` / `launchctl bootstrap` / `systemctl enable` |
| Start service | installer (post-register) | Verifies Supervisor `/healthz` returns 200 within 10s before declaring success |
| Create state dir | daemon (first run) | Daemon owns schema; installer only creates parent dir if needed |
| Place Electron binary | installer | Per-user OR all-users — picked per OS, see [Chapter 10](#chapter-10--build-package-installer) |
| Stop service | uninstaller | Wait for clean exit (≤10s) before file deletion |
| Unregister service | uninstaller | `sc.exe delete` / `launchctl bootout` / `systemctl disable` |
| Delete state | uninstaller (with user opt-in prompt) | Default: keep state on uninstall, delete only on explicit "remove user data" tick |
| Verify clean uninstall | ship-gate (d) test | See [Chapter 12](#chapter-12--testing-strategy) §6 |

#### 6. Process boundary contract (Electron MUST assume)

- Daemon may restart at any time. Electron MUST tolerate Connect `UNAVAILABLE` with auto-reconnect + exponential backoff (cap 30s).
- Daemon may be older or newer than Electron after either side updates. Electron MUST send its `proto_min_version` in `Hello`; daemon rejects incompatible versions with `FAILED_PRECONDITION` and a structured `ErrorDetail` whose `code = "version.client_too_old"` and `extra["daemon_proto_version"] = <int>`. Version negotiation is **one-directional**: daemon does NOT push a `min_compatible_client` back to Electron — the Electron build embeds its own `proto_min_version` baseline at compile time and decides whether to upgrade based on the daemon's reported `proto_version`. (See [Chapter 04](#chapter-04--proto-and-rpc-surface) §3 for the proto field set and the negotiation contract; the `HelloResponse` carries `daemon_version`, `proto_version`, `principal`, and `listener_id` — no `min_compatible_client`.)
- Sessions are daemon-owned. Closing the Electron window does NOT close sessions. The user destroys sessions only via the explicit `DestroySession` RPC.

#### 7. v0.4 delta

- **Add** to startup order step 5: instantiate Listener B in slot 1 (replace the `RESERVED_FOR_LISTENER_B` sentinel write with `makeListenerB(env)` — one-line edit at the startup site, plus the new `listener-b.ts` file per [Chapter 03](#chapter-03--listeners-and-transport) §8). Existing handler code unchanged.
- **Add** cloudflared subprocess to daemon supervision (similar to `claude` CLI: spawn, monitor, restart). New SQLite row in a new `tunnel_state` table (additive; no existing table modified).
- **Add** to install step list: optionally configure cloudflared (user-toggled, off by default). Existing service registration unchanged.
- Service account, file locations, startup ordering, shutdown contract, Supervisor UDS shape: **unchanged**.


---

## Chapter 03 — Listeners and Transport

v0.3 ships exactly one runtime listener (Listener A) plus a Supervisor UDS, but the daemon's listener subsystem is structured as a `Listener` trait + an array of slots, with slot 1 reserved for v0.4's Listener B. This chapter pins the trait shape, the v0.3 instantiation, the auth middleware composition, and the loopback HTTP/2 transport pick — including the explicit MUST-SPIKE alternatives the brief demands rather than a TBD.

#### 1. Listener trait

A `Listener` is a (socket address, transport, auth middleware chain, RPC mux) bundle owned by the daemon. The trait is a TypeScript interface:

```ts
// packages/daemon/src/listeners/listener.ts
import type { ConnectRouter } from "@connectrpc/connect";

export interface Listener {
  readonly id: "A" | "B";              // slot id; v0.3 only "A" used
  readonly bind: BindDescriptor;        // see §1a for the closed-set vocabulary
  readonly authChain: AuthMiddleware[]; // composed in order; produces ctx.principal
  start(router: ConnectRouter): Promise<void>;
  stop(graceMs: number): Promise<void>;
}

export interface AuthMiddleware {
  readonly name: string;
  // returns updated principal or throws ConnectError(code=Unauthenticated|PermissionDenied)
  before(ctx: HandlerCtx, headers: Headers, peer: PeerInfo): Promise<HandlerCtx>;
}

export interface PeerInfo {
  uds?: { uid: number; gid: number; pid: number };
  loopback?: { remoteAddr: string; remotePort: number; localPid?: number };
}

<!-- F2: closes R0 03-P0.1 / R0 03-P1.1 — slot 1 is a typed sentinel, not a `null` comment, with a startup assert + ESLint enforcement. -->
// Reserved-slot sentinel: typed brand symbol exported once from listener.ts.
// v0.3 startup writes RESERVED_FOR_LISTENER_B into slot 1; v0.4's listener-b.ts
// is the ONLY module allowed to overwrite slot 1 (enforced by ESLint rule
// `ccsm/no-listener-slot-mutation`, defined in [Chapter 11](#chapter-11--monorepo-layout) §5).
export const RESERVED_FOR_LISTENER_B: unique symbol = Symbol.for(
  "ccsm.listener.reserved-for-listener-b",
);
export type ReservedSlot = typeof RESERVED_FOR_LISTENER_B;

export type ListenerSlot = Listener | ReservedSlot;
```

The daemon owns a fixed-length array `listeners: [ListenerSlot, ListenerSlot]`. At startup, slot 0 is filled with `makeListenerA(env)` and slot 1 is filled with the typed `RESERVED_FOR_LISTENER_B` sentinel. A startup assertion (`assert(listeners[1] === RESERVED_FOR_LISTENER_B, ...)`) throws and aborts daemon boot if any v0.3.x patch overwrites slot 1 with anything other than the sentinel. v0.4 swaps the sentinel for `makeListenerB(env)` — **no array reshape, no factory rename, no trait change**.

> **Why a typed sentinel (not `null`)**: `null` plus a code comment is enforceable only by reviewer attention. The brand symbol makes the slot's identity machine-checkable: TypeScript's type narrowing forces every site that handles `ListenerSlot` to discriminate sentinel vs. `Listener`, the runtime assert catches accidental overwrites, and the ESLint rule ([Chapter 11](#chapter-11--monorepo-layout) §5: `ccsm/no-listener-slot-mutation`) forbids any source file other than `listeners/listener-b.ts` from writing to `listeners[1]`. Together these close R0 03-P0.1: a v0.3.x telemetry sidecar / debug listener / hotfix that tries to jam something into slot 1 fails at lint, fails at type-check, AND fails at boot.

> **Why fixed array (not Map)**: a Map keyed by string would let v0.4 add arbitrary listener ids and tempt reshape. A 2-slot array makes the topology a static fact reviewers can audit; v0.5+ "Listener C" requires an explicit spec amendment.

#### 1a. BindDescriptor vocabulary (closed set, unified with descriptor `transport`)

<!-- F2: closes R5 P0-03-2 — BindDescriptor.kind and listener-a.json.transport now share one enum vocabulary. -->

`BindDescriptor.kind` is a closed enum stringified identically in `listener-a.json.transport`. The 4-value set is forever-stable for v0.3 (additions in v0.4 ship under a new descriptor file, never as a new enum value):

| `BindDescriptor.kind` | `listener-a.json.transport` | Socket shape | Used by |
| --- | --- | --- | --- |
| `KIND_UDS` | `"KIND_UDS"` | `{ path: string }` (e.g., `/run/ccsm/daemon.sock`) | Listener A on linux/mac when the UDS spike passes |
| `KIND_NAMED_PIPE` | `"KIND_NAMED_PIPE"` | `{ pipeName: string }` (e.g., `\\.\pipe\ccsm-<sid>`) | Listener A on Windows when the named-pipe spike passes |
| `KIND_TCP_LOOPBACK_H2C` | `"KIND_TCP_LOOPBACK_H2C"` | `{ host: "127.0.0.1", port: number }` | Listener A loopback fallback (h2c) |
| `KIND_TCP_LOOPBACK_H2_TLS` | `"KIND_TCP_LOOPBACK_H2_TLS"` | `{ host: "127.0.0.1", port: number, certFingerprintSha256: string }` | Listener A loopback TLS+ALPN fallback |

```ts
export type BindDescriptor =
  | { kind: "KIND_UDS"; path: string }
  | { kind: "KIND_NAMED_PIPE"; pipeName: string }
  | { kind: "KIND_TCP_LOOPBACK_H2C"; host: "127.0.0.1"; port: number }
  | { kind: "KIND_TCP_LOOPBACK_H2_TLS"; host: "127.0.0.1"; port: number; certFingerprintSha256: string };
```

The daemon's `makeListenerA` factory MUST produce a `BindDescriptor` whose `kind` is one of these four; the descriptor writer (§3) MUST stringify the same value into the JSON `transport` field. Electron's transport factory keys on the `transport` string and constructs the matching Connect transport. Any new transport variant in v0.4+ MUST ship as a NEW descriptor file (e.g., `listener-b.json` with its own enum domain), not a new value in this enum ([Chapter 15](#chapter-15--zero-rework-audit) §3 forbidden-pattern 8).

#### 2. Listener A — instantiation

```ts
// packages/daemon/src/listeners/listener-a.ts
export function makeListenerA(env: DaemonEnv): Listener {
  return {
    id: "A",
    bind: env.platform === "win32"
      ? { kind: "KIND_NAMED_PIPE", pipeName: `\\\\.\\pipe\\ccsm-${env.userSid}` }
      : { kind: "KIND_UDS", path: env.platform === "darwin"
          ? "/var/run/com.ccsm.daemon/daemon.sock"
          : "/run/ccsm/daemon.sock" },
    authChain: [
      peerCredMiddleware(),       // produces principal { kind: "local-user", uid }
      // v0.4 inserts the JWT validator here on Listener B; on Listener A the chain stays single-link.
    ],
    start, stop,
  };
}
```

<!-- F2: closes R0 03-P1.3 — jwtBypassMarker dead code removed; chain symmetry documented as a comment on Listener A's authChain literal. -->

Auth chain order matters: peer-cred MUST run first to set `ctx.principal`. v0.3 ships only the peer-cred link; the v0.4 JWT validator on Listener B occupies the next composition slot in `makeListenerB`'s own chain literal ([Chapter 15](#chapter-15--zero-rework-audit) §3 forbidden-pattern 6 freezes the trait shape so this is purely additive).

#### 3. Connection descriptor handed to Electron

<!-- F2: closes R0 03-P0.3 / R2 P0-02-3 / R2 P0-03-4 / R2 P0-08-2 — Windows descriptor path locked unconditionally; atomic write; per-boot nonce; descriptor-based boot_id verification (file is the witness; HelloResponse does NOT carry boot_id — see ch04 §3 / proto session.proto). -->

Daemon writes a JSON file at a known per-OS path on every successful Listener A bind. Paths are locked unconditionally (no per-install MUST-SPIKE outcome); the spike validates only that an interactive Electron can read this path:

| OS | Descriptor path | Mode / ACL |
| --- | --- | --- |
| Windows | `%PROGRAMDATA%\ccsm\listener-a.json` (NEVER `%LOCALAPPDATA%`, NEVER `%APPDATA%`) | DACL: `BUILTIN\Users:Read`; `BUILTIN\Administrators:FullControl`; daemon's service account (`NT AUTHORITY\LocalService`) `Modify` |
| macOS | `/Library/Application Support/ccsm/listener-a.json` (system-wide; NEVER `~/Library/...`) | mode `0644`; owner `_ccsm:_ccsm` (group readable so per-user Electron can read) |
| Linux | `/var/lib/ccsm/listener-a.json` | mode `0644`; owner `ccsm:ccsm` (group readable for FHS compatibility) |

Linux NOTE: `/var/lib/ccsm/` is the durable state root ([Chapter 07](#chapter-07--data-and-state) §2). The descriptor lives in the durable state dir (NOT `/run/ccsm/`) so Electron can read a stable path that doesn't depend on tmpfs init order; the `boot_id` field below is the per-boot freshness marker, not the path mtime.

##### 3.1 Atomic write discipline

The daemon MUST write the descriptor atomically and exactly once per daemon boot:

1. Write JSON to `listener-a.json.tmp` in the same directory as the final path.
2. `fsync(2)` the temp file.
3. `rename(2)` (or `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on Windows) `listener-a.json.tmp` → `listener-a.json`. Rename is atomic on every supported FS so Electron never observes a torn file.
4. Daemon does NOT re-write the descriptor within a single boot (no churn from Listener A reconnects). The file's contents identify *this* daemon process; if Listener A restarts within the same daemon process, the address pin and `boot_id` are unchanged.
5. On daemon clean shutdown the file is **left in place**. Orphan descriptor files between boots are normal; Electron's `boot_id` mismatch check (§3.3) handles them. The OS does NOT have to garbage-collect them.

##### 3.2 Descriptor schema (v1, forever-stable)

```json
{
  "version": 1,
  "transport": "KIND_UDS" | "KIND_NAMED_PIPE" | "KIND_TCP_LOOPBACK_H2C" | "KIND_TCP_LOOPBACK_H2_TLS",
  "address": "/run/ccsm/daemon.sock" | "127.0.0.1:54871" | "\\\\.\\pipe\\ccsm-S-1-5-21-...",
  "tlsCertFingerprintSha256": "..." | null,
  "supervisorAddress": "/run/ccsm/supervisor.sock" | "\\\\.\\pipe\\ccsm-supervisor",
  "boot_id": "550e8400-e29b-41d4-a716-446655440000",
  "daemon_pid": 1234,
  "listener_addr": "/run/ccsm/daemon.sock",
  "protocol_version": 1,
  "bind_unix_ms": 1714600000000
}
```

Field semantics (every field is forever-stable; v0.4+ additions go in NEW top-level fields, never as enum widenings):

- `transport` — closed enum from §1a; the daemon and Electron MUST use the same vocabulary.
- `address` — the bind address; format depends on `transport`.
- `tlsCertFingerprintSha256` — SHA-256 fingerprint of the listener's self-signed cert when `transport == "KIND_TCP_LOOPBACK_H2_TLS"`; `null` for all other transports. Electron pins this fingerprint instead of trusting the OS root store ([Chapter 14](#chapter-14--risks-and-spikes) §1.3).
- `supervisorAddress` — Supervisor UDS path (mac/linux) or named-pipe path (Windows). Always UDS-shaped; loopback-TCP supervisor is forbidden (§7).
- `boot_id` — random UUIDv4 generated once per daemon boot, held in the daemon's memory for the daemon's lifetime. The freshness witness for Electron's staleness check.
- `daemon_pid` — daemon process pid at the moment of write; observability only (Electron does NOT use this for auth — pids recycle).
- `listener_addr` — duplicate of `address` for grep-friendliness in operator logs; daemon writes the same value.
- `protocol_version` — currently `1`; increments only on a wire-incompatible Connect surface change (forever-stable for v0.3).
- `bind_unix_ms` — daemon process start time in unix milliseconds; observability only.

##### 3.3 Electron startup handshake (mandatory)

Electron MUST follow this exact sequence on every connect (cold start AND every reconnect):

1. Read `listener-a.json` from the locked per-OS path (§3 table). If the file is missing or unparseable, surface "Daemon not running" and retry with backoff.
2. Construct a Connect transport keyed on `transport`, address `address`, plus `tlsCertFingerprintSha256` pin if applicable.
3. Open a connection and **immediately** call `Hello` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §3) before any other RPC. `HelloResponse` carries `meta` / `daemon_version` / `proto_version` / `principal` / `listener_id` (forever-stable; see proto `session.proto`). It does NOT echo `boot_id` — the descriptor file is the boot_id witness, not the RPC response. Electron uses `Hello` to confirm the listener is reachable and protocol-compatible; the `boot_id` check is descriptor-driven (step 4).
4. Compare the descriptor's `boot_id` (read in step 1) against the `boot_id` Electron has cached from the prior successful connect (if any). On the very first connect of the renderer's lifetime, Electron pins this `boot_id`. On every subsequent reconnect, Electron MUST re-read `listener-a.json` from disk (NOT reuse the in-memory copy from the prior connect) and verify the freshly-read `descriptor.boot_id` equals the cached value. Mismatch means the daemon restarted (new boot, new UUIDv4); Electron MUST close the connection, discard cached state, treat the freshly-read `boot_id` as the new pin, and continue. Two scenarios this catches:
   - Stale orphan file from a previous daemon boot the OS didn't clean (the new daemon hasn't yet rewritten the file at the moment Electron read it). Re-reading after backoff catches the new file.
   - Foreign process bound to the recorded address (e.g., a non-CCSM process recycled the same loopback port between daemon crash and Electron read). The `Hello` reaches the foreign process; its response either fails to parse OR returns an incompatible `proto_version` / unexpected `listener_id` — Electron rejects it and never sends `CreateSession.env` / `SendInput` / etc.
5. Once `Hello` succeeds and the descriptor `boot_id` matches the cached pin (or no prior pin exists), Electron pins the descriptor for this connection's lifetime. If the connection drops (UNAVAILABLE), Electron returns to step 1 (re-reading the file rather than reusing the in-memory copy) so a daemon restart with a new `boot_id` is detected on the very first reconnect attempt by the descriptor compare.

The daemon side: on every boot, regenerate `boot_id` (never re-use a prior boot's value), rewrite the descriptor before Supervisor `/healthz` returns 200, hold `boot_id` in memory for observability (`/healthz` body, logs). The daemon NEVER trusts the file as input; it is write-once-per-boot from the daemon's POV. Note: a future proto v2 minor MAY add `HelloResponse.boot_id` as field 6 (additive, [Chapter 15](#chapter-15--zero-rework-audit) §3) for in-band verification, at which point Electron may cross-check Hello-echoed `boot_id` against the descriptor; v0.3 does NOT ship that field — descriptor is the sole witness.

##### 3.4 Why this closes the rendezvous race

- **Atomic write** — Electron cannot observe a torn file (rename is atomic).
- **`boot_id` per boot** — Electron cannot send RPCs to a stale descriptor's address; the descriptor file IS the witness (re-read on every reconnect attempt; cached value compared to freshly-read value).
- **Descriptor written before `/healthz` 200** — [Chapter 02](#chapter-02--process-topology) §3 step 5 ordering means `Hello` will succeed iff the descriptor Electron just read describes the daemon currently listening.
- **No re-write within a boot** — eliminates the "Electron read mid-write" hazard entirely; the only inter-boot transition is daemon-restart, and that's exactly what `boot_id` mismatch detects.
- **Orphan files between boots are NORMAL** — no installer / shutdown-hook cleanup is required; the `boot_id` mismatch (new daemon's descriptor vs cached value) handles them on the next Electron connect attempt.

#### 4. Transport — loopback HTTP/2 pick (MUST-SPIKE)

The brief locks "HTTP/2 (same stack as B will be)" and demands concrete alternatives. The pick is per-OS, decided by spike outcome before code lands; the spec lists all four and the cut-over rule:

| Option | Pros | Cons | Decision |
| --- | --- | --- | --- |
| **A1: h2c over UDS** (mac, linux) | no TLS overhead; UDS gives free peer-cred via `getsockopt(SO_PEERCRED)` / `LOCAL_PEERCRED`; widely supported by Node `http2.createServer` | Node `http2.connect` does not natively accept a UDS path — needs custom `createConnection` | **Default for mac/linux** if spike passes |
| **A2: h2c over loopback TCP** (win, fallback elsewhere) | Node `http2` first-class; well-tested | no native peer-cred — synthesize via `GetExtendedTcpTable` (win) / `/proc/net/tcp` (linux) PID lookup; race window between accept and PID resolution | **Default for win** if named-pipe path fails the spike |
| **A3: h2 over loopback TCP + ALPN + self-signed local cert** | TLS path identical to v0.4 Listener B; flushes any TLS-only middleware bugs | cert provisioning + rotation in installer; user OS trust store may complain | **Fallback** if h2c is unsupported by a future Connect server pin |
| **A4: h2 over named pipe** (win) | LocalService → per-user named pipe with DACL is the most idiomatic Windows path | Node `http2` over a named pipe duplex stream is non-trivial; needs custom `createConnection` | **Preferred for win** if MUST-SPIKE [win-h2-named-pipe] passes |

> **MUST-SPIKE [loopback-h2c-on-25h2]**: hypothesis: `http2.createServer({ allowHTTP1: false })` listening on `127.0.0.1` works under Win 11 25H2 with the default Defender Firewall profile (loopback should be exempt). · validation: 25H2 VM, daemon running as LocalService, Electron as logged-in user, run a 1-min smoke (Hello + 100 unary RPCs + a server-stream of 10k events). · fallback: A4 (named pipe + h2). If A4 also fails: A3 (TLS + ALPN) with a per-install self-signed cert in `%PROGRAMDATA%\ccsm\listener-a.crt`, trusted by Electron explicitly (NOT installed in OS root store).

> **MUST-SPIKE [uds-h2c-on-darwin-and-linux]**: hypothesis: Node 22's `http2.connect` can be coerced into using a UDS via `createConnection: () => net.createConnection(udsPath)` and end-to-end Connect-RPC traffic works (unary, server-stream, bidi). · validation: 1-hour soak running the same workload as ship-gate (c) over UDS. · fallback: A2 (h2c over loopback TCP) on the OS where it fails.

> **MUST-SPIKE [win-h2-named-pipe]**: hypothesis: Node 22 `http2.createServer` on a `net.Server` bound to a Windows named pipe works for Connect-RPC. · validation: as above on a 25H2 VM. · fallback: A2 with PID-based peer-cred synthesis.

The transport choice does NOT leak into proto, RPC handlers, or Electron business logic — it lives only in: (a) the daemon's `makeListenerA` factory, (b) Electron's transport factory keyed by the descriptor `transport` field. Switching between A1/A2/A3/A4 is a 2-file diff (zero-rework safe).

#### 5. Peer-cred authentication

Peer-cred middleware derives `ctx.principal = { kind: "local-user", uid }` (single `uid` field — Windows SID is encoded as a string in `uid`, matching the `LocalUser.uid` proto field per [Chapter 04](#chapter-04--proto-and-rpc-surface) §2; no separate `sid` field exists on the principal):

| Transport | Mechanism |
| --- | --- |
| UDS (mac) | `getsockopt(LOCAL_PEERCRED)` → `xucred` → uid; daemon's bound user determines what counts as "the local user" — see [Chapter 05](#chapter-05--session-and-principal) §3 |
| UDS (linux) | `getsockopt(SO_PEERCRED)` → `ucred` → pid/uid/gid |
| Named pipe (win) | `ImpersonateNamedPipeClient` + `OpenThreadToken` + `GetTokenInformation(TokenUser)` → SID |
| Loopback TCP | parse `/proc/net/tcp{,6}` (linux) or `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_ALL)` (win) or `lsof -i` equivalent (mac) to map remote port → owning PID → owning uid/SID. Rejection if mapping fails. |

If peer-cred resolution fails (e.g., process exited between accept and lookup on loopback TCP), the middleware throws `Unauthenticated`. Electron handles by reconnecting.

#### 6. Listener B — slot reservation (v0.3 has no `listener-b.ts`)

<!-- F2: closes R0 03-P1.1 — listener-b.ts ships only in v0.4 (additive new file); v0.3 has no makeListenerB symbol to import or refactor. -->

v0.3 deliberately ships **no** `packages/daemon/src/listeners/listener-b.ts` file. The daemon startup writes the typed sentinel `RESERVED_FOR_LISTENER_B` (see §1) into slot 1; no factory is called, no symbol is imported, no `throw` lives in v0.3 code. v0.4 lands a brand-new `listener-b.ts` file (purely additive — [Chapter 11](#chapter-11--monorepo-layout) `packages/daemon/src/listeners/` gains one file) plus a one-line edit at the startup site that swaps the sentinel for `makeListenerB(env)`. The ESLint rule `ccsm/no-listener-slot-mutation` ([Chapter 11](#chapter-11--monorepo-layout) §5) explicitly whitelists `listeners/listener-b.ts` as the only file allowed to write `listeners[1]` in v0.4+.

> **Why ship no stub in v0.3**: a stub that throws (the prior shape) made `makeListenerB`'s effective return type `never` in v0.3 and `Listener` in v0.4 — a soft signature shift that R0 03-P1.1 flagged. A stub that returns the sentinel still ships an exported symbol whose body v0.4 must rewrite. Shipping the file *only* in v0.4 means v0.3 has zero `listener-b.ts` lines to "modify" — the v0.4 add is a new file plus one startup-site edit, the cleanest possible additive delta.

#### 7. Supervisor UDS (UDS-only on every OS, no loopback-TCP fallback ever)

<!-- F2: closes R2 P0-02-2 / R2 P0-03-3 — Supervisor is UDS-only on every OS; loopback-TCP supervisor is forbidden; peer-cred is the sole authn for /shutdown. -->

Separate from data-plane Listener A. The Supervisor channel is **UDS-only on every OS**; loopback-TCP supervisor is forbidden, period. Per-OS bind:

| OS | Supervisor address | Mode / DACL |
| --- | --- | --- |
| Windows | `\\.\pipe\ccsm-supervisor` (named pipe) | DACL: `O:SY G:SY D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GR;;;BU)` — full control to SYSTEM + Administrators; `BUILTIN\Users:Read` (so the installer / postmortem `curl` can read `/healthz`); only Administrators may invoke `/shutdown` (enforced by peer-cred SID check) |
| macOS | `/var/run/com.ccsm.daemon/supervisor.sock` (LaunchDaemon-managed; reverse-DNS subdir per Apple convention) | mode `0660`; owner `_ccsm:wheel` |
| Linux | `/run/ccsm/supervisor.sock` | mode `0660`; owner `ccsm:ccsm` |

v0.3 endpoints (plain HTTP — Connect framing is overkill for three single-purpose endpoints; HTTP is callable by `curl` from the installer / a postmortem shell):

- `GET /healthz` → 200 with body `{"ready": true, "version": "0.3.x", "uptimeS": N, "boot_id": "<uuid>"}` once startup step 5 (per [Chapter 02](#chapter-02--process-topology) §3) completes; 503 before. The `boot_id` field is the same value written into `listener-a.json` (§3.2); operators can correlate.
- `POST /hello` → records caller PID + version; admin-only via peer-cred uid/SID check; used by installer post-register verification.
- `POST /shutdown` → admin-only via peer-cred uid/SID check; triggers graceful shutdown path; used by uninstaller.

##### 7.1 Peer-cred authentication for Supervisor (the ONLY authn — supervisor RPC bypasses JWT forever)

Supervisor RPC bypasses JWT (no JWT validator runs on the Supervisor channel — ever, including v0.4+) and authenticates SOLELY via OS peer-cred:

| OS | Mechanism | Admin allowlist |
| --- | --- | --- |
| Windows | named-pipe peer SID via `ImpersonateNamedPipeClient` + `OpenThreadToken` + `GetTokenInformation(TokenUser)` | SID is in `BUILTIN\Administrators` group; the daemon's own service-account SID (`NT AUTHORITY\LocalService`) is also allowed (so the daemon can call its own Supervisor for self-test / shutdown coordination) |
| macOS | `getsockopt(LOCAL_PEERCRED)` → `xucred` → uid | uid `0` (root) OR `_ccsm` (the daemon's service account) |
| Linux | `getsockopt(SO_PEERCRED)` → `ucred` → uid/gid | uid `0` (root) OR uid of the `ccsm` system account |

`/healthz` requires no admin check (any peer that can reach the socket may probe readiness). `/hello` and `/shutdown` MUST reject non-allowlisted peers with HTTP 403; the daemon logs the rejected peer-cred (uid/SID + pid) to `crash_log` ([Chapter 09](#chapter-09--crash-collector)).

##### 7.2 Security rationale (locked)

Supervisor is the only daemon RPC surface that bypasses JWT (because v0.4 cf-access principals MUST NOT be allowed to shut down the daemon — the brief §7 admin/data plane separation). Peer-cred uid match is the sole gate. To make this safe forever:

- **No loopback TCP**: a TCP socket is reachable from any browser tab via DNS rebinding ([Chapter 03](#chapter-03--listeners-and-transport) §4 R2 finding); the Supervisor's `/shutdown` cannot afford that exposure. Shipping UDS-only closes the rebinding hole structurally — there's no TCP socket to rebind to.
- **No JWT path**: a future contributor MUST NOT add JWT middleware to the Supervisor "for symmetry with Listener B"; admin actions belong to local admins, not to remote authenticated users. [Chapter 15](#chapter-15--zero-rework-audit) §3 forbidden-pattern locks this: Supervisor endpoints (`/healthz`, `/hello`, `/shutdown`) MUST NOT be exposed via Listener B or any future remote listener; equivalent functionality for remote callers MUST be exposed as new Connect RPCs on the data-plane listener with explicit principal authorization.
- **Service-account self-call allowed**: the daemon's own service-account SID/uid is in the allowlist so the daemon can invoke its own Supervisor (e.g., the integration test harness uses this; [Chapter 12](#chapter-12--testing-strategy) §3 covers it).

Bind path mirrors Listener A's UDS conventions but `daemon.sock` → `supervisor.sock` (linux) / `\\.\pipe\ccsm-daemon` → `\\.\pipe\ccsm-supervisor` (Windows).

#### 8. v0.4 delta

- **Add** `packages/daemon/src/listeners/listener-b.ts` (NEW file): exports `makeListenerB(env: DaemonEnv): Listener` with `bind = { kind: "KIND_TCP_LOOPBACK_H2C", host: "127.0.0.1", port: PORT_TUNNEL }`, authChain `[jwtValidatorMiddleware()]`. The ESLint rule `ccsm/no-listener-slot-mutation` whitelists this file as the only writer of `listeners[1]`.
- **Edit** the daemon startup site (one line): replace `listeners[1] = RESERVED_FOR_LISTENER_B` with `listeners[1] = makeListenerB(env)`. Listener trait: unchanged. Listener array shape: unchanged (slot 1 filled).
- **Add** new auth middleware module `jwt-validator.ts` (NEW file).
- **Add** new descriptor file `listener-b.json` (NEW file) — Listener A's descriptor and the §1a `transport` enum are unchanged. v0.4 transport variants live under their own descriptor + their own enum domain, never as new values in the v0.3 enum.
- **Unchanged**: trait, peer-cred middleware, Supervisor UDS shape (still UDS-only), RPC handler code, Electron transport factory, descriptor schema (additions only in NEW top-level fields).


---

## Chapter 04 — Proto and RPC Surface

This chapter freezes the v0.3 wire schema. Every RPC the v0.3 Electron client uses is enumerated; every message shape is locked; every field is labeled forever-stable or v0.3-internal. The additivity contract from brief §6 is restated as a mechanical rule reviewers can grep for. v0.4 may add new RPCs and new optional fields; v0.4 MUST NOT remove a field, change a field's type, change a field's meaning, or rename anything in this chapter.

#### 1. File and package layout

```
packages/proto/
  ccsm/v1/                     # v1 = forever-stable surface; never renamed
    common.proto               # shared scalar/enum/principal types
    session.proto              # SessionService
    pty.proto                  # PtyService (snapshot + delta stream)
    crash.proto                # CrashService
    settings.proto             # SettingsService
    notify.proto               # NotifyService (F6: notify decider events + setters)
    draft.proto                # DraftService (F6: per-session composer drafts)
    supervisor.proto           # NOT shipped to clients; daemon-internal mirror of HTTP supervisor
  buf.yaml
  buf.gen.yaml                 # codegen: connect-es (TS) + connect-go (future) + connect-swift (future)
```

Package: `ccsm.v1`. **There is no `ccsm.v0`**; v0.3 is the first locked surface and is named v1 because the proto package name is forever-stable, not the product version. Future product versions add `ccsm.v2.*` packages alongside (additive); v1 is never removed (brief §6).

#### 2. Common types (`common.proto`)

```proto
syntax = "proto3";
package ccsm.v1;

// Forever-stable. New principal kinds added as new oneof variants in v0.4.
message Principal {
  // F3: closes R0 03-P0.2 / R0 04-P0.1 — slot 2 reserved via the protobuf
  // `reserved` keyword (NOT a `// comment`) so any v0.3.x patch that tries
  // to bind a different message to field number 2 is rejected by `protoc`
  // before `buf breaking` even runs. v0.4 lifts the reservation by deleting
  // the `reserved 2;` line and adding `CfAccess cf_access = 2;` in the same
  // patch — the deletion-plus-add is a single atomic schema move and is
  // additive at the wire level (no v0.3 producer ever emitted field 2).
  oneof kind {
    LocalUser local_user = 1;
    reserved 2;                  // v0.4: CfAccess cf_access = 2;
  }
}

message LocalUser {
  string uid = 1;          // numeric uid (unix) or SID (windows), as string
  string display_name = 2; // OS-reported display name; advisory only
}

// Forever-stable. Surfaced to UI; ordering MUST match enum int values forever.
enum SessionState {
  SESSION_STATE_UNSPECIFIED = 0;
  SESSION_STATE_STARTING = 1;
  SESSION_STATE_RUNNING = 2;
  SESSION_STATE_EXITED = 3;
  SESSION_STATE_CRASHED = 4;
}

// Forever-stable. Used by every RPC for traceability.
//
// F7: closes R4 P1 — daemon MUST validate `request_id` is non-empty on every
// RPC. Empty `request_id` → ConnectError `INVALID_ARGUMENT` with
// `ErrorDetail.code = "request.missing_id"`. Daemon MUST NOT silently
// synthesize a substitute (would break client-side correlation logs and
// hide a misbehaving client). Test: `proto/request-meta-validation.spec.ts`
// covers the rejection path for every Connect RPC.
message RequestMeta {
  string request_id = 1;       // client-generated UUIDv4; daemon rejects empty with INVALID_ARGUMENT
  string client_version = 2;   // semver of caller (electron / web / ios)
  int64 client_send_unix_ms = 3;
}

// Forever-stable error detail attached to ConnectError.details.
message ErrorDetail {
  string code = 1;             // stable string, e.g. "session.not_found"
  string message = 2;          // human-readable; UI may show
  map<string, string> extra = 3;
}
```

Reservation slot for `cf_access` uses the protobuf `reserved` keyword (not a comment) precisely **because** the keyword causes `protoc` to reject any attempt to reuse field number 2 with a different message — exactly the protection v0.3 wants. The earlier "comment is better because reserved blocks reuse" framing was inverted: the v0.4 add is `reserved 2;` deletion plus `CfAccess cf_access = 2;` insertion in the same patch (mechanically additive at the wire level — v0.3 producers never emit field 2 — and `buf breaking` accepts the move because no v0.3 message had `cf_access`). Every comment-only "v0.4 reserved" slot in this chapter MUST use `reserved <number>;` instead; reviewers grep for `// .*v0\.4.*reserved` and reject any hits in `.proto` files.

#### 3. Session service (`session.proto`)

```proto
syntax = "proto3";
package ccsm.v1;
import "ccsm/v1/common.proto";

service SessionService {
  // Forever-stable.
  rpc Hello(HelloRequest) returns (HelloResponse);
  rpc ListSessions(ListSessionsRequest) returns (ListSessionsResponse);
  rpc GetSession(GetSessionRequest) returns (GetSessionResponse);
  rpc CreateSession(CreateSessionRequest) returns (CreateSessionResponse);
  rpc DestroySession(DestroySessionRequest) returns (DestroySessionResponse);
  // F7: closes R5 P1-04-5 — `WatchSessions` is double-scoped: (1) the
  // implicit principal scope from peer-cred middleware (the in-memory
  // event bus filter `principalKey(ctx.principal)` per chapter
  // [Chapter 05](#chapter-05--session-and-principal) §5; daemon MUST NEVER emit
  // events for sessions whose owner != caller's principalKey when scope
  // resolves to OWN), and (2) the explicit `WatchSessionsRequest.scope`
  // enum (F1, see below) that flips OWN→ALL for v0.4 admin principals.
  // The two layers compose: principal filter is unconditional; `scope`
  // is an enum widening for ALL. v0.3 daemon honors only OWN; ALL is
  // rejected with PermissionDenied. A handler implementor MUST apply
  // the principal filter even for OWN — it is a security boundary, not
  // a performance hint.
  rpc WatchSessions(WatchSessionsRequest) returns (stream SessionEvent);
  // F6: closes R1 P0.1 (chapter 08) — v0.2 SessionTitles + import-scanner
  // surfaces preserved as forever-stable Connect RPCs so the Electron
  // renderer's Sidebar rename / SDK-title display / "Import existing
  // claude session" UIs survive the IPC removal cutover. Daemon owns
  // the claude SDK (`@anthropic-ai/claude-agent-sdk`) integration so
  // clients never touch `~/.claude/projects/*` directly. v0.4 web/iOS
  // call the same RPCs unchanged.
  rpc RenameSession(RenameSessionRequest) returns (Session);
  rpc GetSessionTitle(GetSessionTitleRequest) returns (GetSessionTitleResponse);
  rpc ListProjectSessions(ListProjectSessionsRequest) returns (ListProjectSessionsResponse);
  rpc ListImportableSessions(ListImportableSessionsRequest) returns (ListImportableSessionsResponse);
  rpc ImportSession(ImportSessionRequest) returns (Session);
}

message HelloRequest {
  RequestMeta meta = 1;
  // F7: closes R0 04-P1.2 — `client_kind` is observability-only.
  // Daemon MUST NOT branch on this value for behavior selection (auth,
  // routing, feature gating, schema choice). The matching forbidden
  // pattern lives in [Chapter 15](#chapter-15--zero-rework-audit) §3. The
  // field is open-string-set (same rule as `CrashEntry.source`); v0.3
  // publishes `{electron, web, ios}` but daemon MUST tolerate any UTF-8
  // string. Switching on `client_kind` would (a) force a proto bump
  // every time a new client kind ships and (b) re-introduce per-client
  // semantic shifts the open-set rule was designed to prevent.
  string client_kind = 2;       // "electron" | "web" | "ios" — v0.3 only "electron"; open string set (see §3 below)
  // F3: closes R0 04-P1.1 — `client_version` is carried in `RequestMeta` only.
  // Field number 3 reserved so v0.4 cannot accidentally re-bind it.
  reserved 3;                    // historically `client_version`; now in RequestMeta.client_version
  int32 proto_min_version = 4;  // client's minimum acceptable v1 minor
}

message HelloResponse {
  RequestMeta meta = 1;
  string daemon_version = 2;
  int32 proto_version = 3;      // current v1 minor; client compares against its min
  Principal principal = 4;      // who the daemon thinks you are
  // F3: closes R0 04-P1.3 — listener id surfaces which listener answered the
  // handshake. v0.3 daemon ALWAYS populates "A" (the only listener instantiated);
  // v0.4 Listener B populates "B". Open string set so v0.5+ may add "C" etc.
  string listener_id = 5;       // "A" in v0.3; "B" on Listener B in v0.4
}

message ListSessionsRequest { RequestMeta meta = 1; }
message ListSessionsResponse {
  RequestMeta meta = 1;
  repeated Session sessions = 2;
}

message GetSessionRequest {
  RequestMeta meta = 1;
  string session_id = 2;
}
message GetSessionResponse {
  RequestMeta meta = 1;
  Session session = 2;
}

message CreateSessionRequest {
  RequestMeta meta = 1;
  string cwd = 2;                       // absolute path; daemon validates exists + readable
  map<string, string> env = 3;          // additive env on top of daemon's service env
  repeated string claude_args = 4;      // argv for `claude` CLI; daemon prepends binary path
  PtyGeometry initial_geometry = 5;     // see pty.proto
}
message CreateSessionResponse {
  RequestMeta meta = 1;
  Session session = 2;
}

message DestroySessionRequest {
  RequestMeta meta = 1;
  string session_id = 2;
}
message DestroySessionResponse { RequestMeta meta = 1; }

<!-- F1: closes R0 04-P0.3 / R0 05-P0.2 — WatchSessions scope made explicit so v0.4 cross-principal admin filter is a value-add, not a semantic shift. -->
// Forever-stable. v0.3 daemon honors only WATCH_SCOPE_OWN; WATCH_SCOPE_ALL
// is reserved here so v0.4 (multi-principal + admin) flips behavior by enum
// value, not by reshaping the request. v0.3 daemon MUST reject ALL with
// PermissionDenied so v0.4 enforcement is purely an additive enum-branch.
enum WatchScope {
  WATCH_SCOPE_UNSPECIFIED = 0;     // treated as WATCH_SCOPE_OWN
  WATCH_SCOPE_OWN = 1;             // events for sessions owned by ctx.principal
  WATCH_SCOPE_ALL = 2;             // v0.4: admin principals only
}

message WatchSessionsRequest {
  RequestMeta meta = 1;
  WatchScope scope = 2;            // default UNSPECIFIED == OWN
}
message SessionEvent {
  oneof kind {
    Session created = 1;
    Session updated = 2;     // state, exit_code, geometry change, etc.
    string destroyed = 3;    // session_id
  }
}

// Forever-stable.
message Session {
  string id = 1;
  Principal owner = 2;
  SessionState state = 3;
  string cwd = 4;
  int64 created_unix_ms = 5;
  int64 last_active_unix_ms = 6;
  // F7: closes R5 P1-04-2 — `optional` keyword (proto3 field presence) so
  // an exited-with-code-0 session is wire-distinguishable from a still-
  // running session whose `exit_code` was never set. Without `optional`
  // both serialize to the absence-of-field-7 (proto3 default zero) and
  // consumers must gate on `state` alone — a foot-gun for any future
  // cross-language client. Field number 7 is preserved (no renumber).
  optional int32 exit_code = 7;       // valid only when state == EXITED; presence-bit distinguishes "exited 0" from "still running"
  PtyGeometry geometry = 8;
  // F6: closes R4 P0 ch 08 verification harness step 6 — daemon publishes the
  // OS pid of the `claude` CLI subprocess for each RUNNING session so the
  // ship-gate (b) E2E test can assert subprocess survival via
  // `Get-Process -Id <pid>` (Windows) / `kill -0 <pid>` (POSIX) without
  // requiring a debug RPC. Optional + presence-bit: 0 (with bit unset)
  // means "not currently spawned" (STARTING / EXITED / CRASHED states);
  // any non-zero value is a live OS pid attributable to this session.
  // Open string set rule does NOT apply (this is a numeric); v0.4 iOS /
  // sandboxed environments where pid is not exposed leave the bit unset.
  optional int32 runtime_pid = 9;
}

// F6: closes R1 P0.1 (chapter 08). Forever-stable. Per-session friendly
// title (claude SDK summary OR user-applied rename) — drives the Sidebar
// title display and toast labels so notifications carry meaningful text
// instead of session UUIDs.
message RenameSessionRequest {
  RequestMeta meta = 1;
  string session_id = 2;
  string new_title = 3;        // UTF-8; daemon trims to 512 bytes; empty clears back to claude SDK summary
}

message GetSessionTitleRequest {
  RequestMeta meta = 1;
  string session_id = 2;
}
message GetSessionTitleResponse {
  RequestMeta meta = 1;
  string title = 2;            // resolved title (rename if set, else SDK summary, else empty)
  string sdk_summary = 3;      // raw claude SDK summary (for UI fallback / display); empty if not yet derived
  bool pending_rename = 4;     // true if a queued rename has not yet been flushed to the SDK
}

// Project-scoped session listing — surfaces sessions whose `cwd` resolves
// under a given project directory. Used by the Sidebar's per-project
// grouping and by the rename-queue flush logic.
message ListProjectSessionsRequest {
  RequestMeta meta = 1;
  string project_dir = 2;      // absolute path; daemon canonicalizes (resolves symlinks)
}
message ListProjectSessionsResponse {
  RequestMeta meta = 1;
  repeated Session sessions = 2;
}

// Importable-session scan — daemon reads `~/.claude/projects/*` (or the
// per-OS equivalent) and returns historical claude CLI sessions the user
// can attach to ccsm tracking. v0.4 web/iOS call the same RPC; the
// daemon's filesystem view is the single source of truth.
message ListImportableSessionsRequest {
  RequestMeta meta = 1;
  string project_dir_filter = 2;  // optional; empty = all projects
}
message ListImportableSessionsResponse {
  RequestMeta meta = 1;
  repeated ImportableSession importable = 2;
}
message ImportableSession {
  string claude_session_id = 1;   // claude SDK's id
  string project_dir = 2;
  string title = 3;               // SDK-derived title if any
  int64 first_seen_unix_ms = 4;
  int64 last_active_unix_ms = 5;
  int32 message_count = 6;
}

message ImportSessionRequest {
  RequestMeta meta = 1;
  string claude_session_id = 2;   // an entry from ListImportableSessions
  string cwd = 3;                 // honored as the new ccsm session's cwd; empty = use the importable's project_dir
}
```

`Hello` does **not** authenticate — peer-cred middleware on Listener A already did that; `Hello` exists to negotiate protocol minor and surface the daemon-derived principal back to the client. The `client_kind` field is forever-stable and string-typed (not enum) so v0.5+ can add new client kinds without a proto bump. **`client_kind` is an open string set** — same wording as `CrashEntry.source` (§5) and `CrashEntry.source` open-set rule: string values are open; daemon and client both tolerate unknown values. v0.3 daemon does NOT branch on `client_kind` for behavior selection (forbidden by [Chapter 15](#chapter-15--zero-rework-audit) §3); the field is observability-only in v0.3. v0.3 publishes a known set `{"electron", "web", "ios"}` enumerated in this comment block; clients SHOULD pick a value from this set, but daemon MUST accept any UTF-8 string.

**Version negotiation is one-directional**: the client sends `proto_min_version` in `HelloRequest`; the daemon either accepts (returns its `proto_version` in `HelloResponse`) or rejects with `FAILED_PRECONDITION` and an `ErrorDetail` whose `code = "version.client_too_old"` and `extra["daemon_proto_version"] = <int>`. The daemon does NOT push a `min_compatible_client` value back; the client decides whether to upgrade based on its own embedded `proto_min_version` baseline. (This contract is mirrored in [Chapter 02](#chapter-02--process-topology) §6 wording.)

#### 4. PTY service (`pty.proto`)

```proto
syntax = "proto3";
package ccsm.v1;
import "ccsm/v1/common.proto";

service PtyService {
  // Forever-stable. See chapter 06 for snapshot/delta wire format.
  rpc Attach(AttachRequest) returns (stream PtyFrame);   // server-stream
  rpc SendInput(SendInputRequest) returns (SendInputResponse);  // client → daemon keystrokes
  rpc Resize(ResizeRequest) returns (ResizeResponse);
  // F3: closes R0 06-P0.3 — per-frame ack ships in v0.3 so v0.4 web/iOS get
  // exactly-once delta application semantics WITHOUT a request-shape change.
  // v0.3 Electron MAY no-op (HTTP/2 flow control + the `since_seq` resume
  // tree (chapter 06 §5) already give the dogfood-needed reliability over
  // loopback); v0.4 web/iOS over CF Tunnel MUST set `requires_ack = true`
  // on `AttachRequest` and MUST call `AckPty(session_id, applied_seq)` after
  // each persisted frame so daemon can advance its per-subscriber seq watermark
  // and prune deltas safely.
  rpc AckPty(AckPtyRequest) returns (AckPtyResponse);
  // F6: closes R1 P0.3 (chapter 08) — surfaces whether the daemon's
  // configured `claude` CLI binary is on PATH (or at the configured
  // `claude_binary_path`) and resolves the absolute path. Drives the
  // renderer's "claude not installed" empty-state and disables the
  // CreateSession affordance accordingly. Daemon owns the lookup
  // because the daemon, not the renderer, spawns the binary; the
  // renderer's view of PATH is irrelevant.
  rpc CheckClaudeAvailable(CheckClaudeAvailableRequest) returns (CheckClaudeAvailableResponse);
}

message PtyGeometry {
  int32 cols = 1;
  int32 rows = 2;
}

message AttachRequest {
  RequestMeta meta = 1;
  string session_id = 2;
  // Last delta seq the client has; daemon resumes from here.
  // 0 means "send fresh snapshot then deltas from snapshot's seq".
  uint64 since_seq = 3;
  // F3: closes R0 06-P0.3 — opt-in per-frame ack channel.
  // v0.3 Electron leaves this `false` (default proto3 zero) — the server
  // streams freely; loopback HTTP/2 flow control suffices and the `since_seq`
  // resume tree handles disconnect cases. v0.4 web/iOS clients running over
  // CF Tunnel set this `true` and MUST call `AckPty` after each persisted
  // frame; daemon then bounds per-subscriber unacked-frame backlog (kicks
  // the subscriber with `RESOURCE_EXHAUSTED` if backlog exceeds N=4096).
  bool requires_ack = 4;
}

message AckPtyRequest {
  RequestMeta meta = 1;
  string session_id = 2;
  uint64 applied_seq = 3;        // highest contiguous seq the client has persisted
}
message AckPtyResponse {
  RequestMeta meta = 1;
  uint64 daemon_max_seq = 2;     // highest seq daemon currently has buffered for this session
}

message PtyFrame {
  oneof kind {
    PtySnapshot snapshot = 1;   // sent at most once per Attach (first frame if since_seq=0
                                // OR if since_seq is older than retained delta window)
    PtyDelta delta = 2;         // may be sent many times
    PtyHeartbeat heartbeat = 3; // every 10s when no other frame; lets client detect stall
  }
}

// Forever-stable. Schema details in chapter 06.
message PtySnapshot {
  uint64 base_seq = 1;
  PtyGeometry geometry = 2;
  bytes screen_state = 3;       // serialized xterm-headless state; opaque to clients
  uint32 schema_version = 4;    // bump to add fields; never repurpose
}

message PtyDelta {
  uint64 seq = 1;               // strictly monotonic per session
  bytes payload = 2;            // chunk of raw VT bytes; see chapter 06 §3
  int64 ts_unix_ms = 3;
}

message PtyHeartbeat {
  uint64 last_seq = 1;
  int64 ts_unix_ms = 2;
}

message SendInputRequest {
  RequestMeta meta = 1;
  string session_id = 2;
  bytes data = 3;               // raw bytes; daemon writes to PTY master
}
message SendInputResponse { RequestMeta meta = 1; }

message ResizeRequest {
  RequestMeta meta = 1;
  string session_id = 2;
  PtyGeometry geometry = 3;
}
message ResizeResponse { RequestMeta meta = 1; }

// F6: closes R1 P0.3 (chapter 08). Forever-stable. Daemon resolves the
// `claude` binary via (a) `Settings`-derived `claude_binary_path` config
// ([Chapter 10](#chapter-10--build-package-installer) §5; not RPC-settable —
// security-sensitive), or (b) PATH lookup if the config is unset.
message CheckClaudeAvailableRequest { RequestMeta meta = 1; }
message CheckClaudeAvailableResponse {
  RequestMeta meta = 1;
  bool available = 2;            // true iff daemon successfully resolved an executable
  string resolved_path = 3;      // absolute path; empty if !available
  string version = 4;            // best-effort `claude --version` parse; empty on failure
  string error_code = 5;         // "ENOENT" / "EACCES" / "" — surfaces the lookup failure mode for UI messaging
}
```

`SendInput` is unary, not bidi-stream, deliberately. **Why**: keystroke RTT over loopback is sub-millisecond; bidi-stream complicates the proto and Connect-web's bidi support is limited. v0.4 web client gets the same surface; if profiling shows unary overhead is unacceptable, v0.5 may ADD `SendInputStream` — existing `SendInput` stays.

#### 5. Crash service (`crash.proto`)

```proto
syntax = "proto3";
package ccsm.v1;
import "ccsm/v1/common.proto";

service CrashService {
  rpc GetCrashLog(GetCrashLogRequest) returns (GetCrashLogResponse);
  rpc WatchCrashLog(WatchCrashLogRequest) returns (stream CrashEntry);
  // F6: closes R0 08-P0.1 / R0 09-P0.2 / R5 P1-09-4 — replaces the
  // broken "Open raw log file" affordance ([Chapter 08](#chapter-08--electron-client-migration)
  // §3 rejects `file://` URLs in `app:open-external`; v0.4 web/iOS
  // cannot open a daemon-side filesystem path at all). Daemon streams
  // the contents of `state/crash-raw.ndjson` ([Chapter 09](#chapter-09--crash-collector)
  // §2) as length-bounded chunks; client renders as "Download raw log"
  // and persists via the renderer's File System Access API (Electron) /
  // browser save dialog (v0.4 web) / iOS share sheet (v0.4 iOS).
  // owner-scoped filtering does NOT apply — the raw log is daemon-self
  // by definition (see [Chapter 09](#chapter-09--crash-collector) §2);
  // peer-cred middleware still scopes admin-only for v0.4.
  rpc GetRawCrashLog(GetRawCrashLogRequest) returns (stream RawCrashChunk);
}

<!-- F1: closes R0 04-P0.3 / R0 09-P0.1 / R0 05-P0.1 / R2 P0-05-2 — owner_filter pinned at v0.3 freeze so v0.4 multi-principal scoping is enum-additive, not a semantic flip. -->
// Forever-stable. v0.3 has a single principal kind so the filter is moot
// at runtime; v0.4 multi-principal makes UNSPECIFIED == OWN binding and
// adds OWNER_FILTER_ALL for admin principals. Defaults are forever-stable.
enum OwnerFilter {
  OWNER_FILTER_UNSPECIFIED = 0;    // treated as OWN
  OWNER_FILTER_OWN = 1;            // entries with owner_id == principalKey(ctx.principal) OR owner_id == "daemon-self"
  OWNER_FILTER_ALL = 2;            // v0.3: only the local-user principal MAY use this; v0.4: admin principals only
}

message GetCrashLogRequest {
  RequestMeta meta = 1;
  int32 limit = 2;            // max entries; daemon caps at 1000
  int64 since_unix_ms = 3;    // 0 = no lower bound
  OwnerFilter owner_filter = 4; // default UNSPECIFIED == OWN
}
message GetCrashLogResponse {
  RequestMeta meta = 1;
  repeated CrashEntry entries = 2;
}

message WatchCrashLogRequest {
  RequestMeta meta = 1;
  OwnerFilter owner_filter = 2; // same semantics as GetCrashLogRequest.owner_filter
}

// Forever-stable.
message CrashEntry {
  string id = 1;             // ULID
  int64 ts_unix_ms = 2;
  string source = 3;         // open string set; see chapter 09 §1 for v0.3 sources
  string summary = 4;        // single-line summary
  string detail = 5;         // multiline; stack trace if any
  map<string, string> labels = 6;  // session_id, pid, etc.
  string owner_id = 7;       // principalKey of attributable principal, or "daemon-self" for daemon-side crashes (chapter 09 §1)
}

// F6: closes R0 08-P0.1 / R0 09-P0.2. Forever-stable. Streams the bytes
// of `state/crash-raw.ndjson` ([Chapter 09](#chapter-09--crash-collector) §2)
// as 64 KiB chunks. Client concatenates and saves to a user-chosen path.
// Daemon reads the file at request time (NOT a snapshot — caller sees the
// file as of read); EOF is signaled by the stream completing normally.
// If the file does not exist (no fatal-via-NDJSON crashes have occurred),
// daemon completes the stream after sending zero chunks. Errors map to
// `INTERNAL` with `ErrorDetail.code = "crash.raw_log_read_failed"`.
message GetRawCrashLogRequest { RequestMeta meta = 1; }
message RawCrashChunk {
  bytes data = 1;       // chunk bytes; daemon emits 64 KiB max per chunk
  bool eof = 2;         // true on the last chunk (may also be true on a zero-byte chunk if file is empty)
}
```

`source` is a string (not enum) on purpose: new sources surface from the wild and must be addable without a proto bump. Daemon code SHOULD use a typed const set internally; the wire layer accepts any string from any version. The set is **open**; [Chapter 09](#chapter-09--crash-collector) §1 enumerates the v0.3 named sources but explicitly disclaims exhaustiveness — v0.4 may add sources additively (e.g., `claude_spawn`, `session_restore`) and v0.3 clients tolerate any value.

`owner_id` is a string with a single sentinel value `"daemon-self"` for crashes that are not attributable to a session principal (e.g., `sqlite_open`, `listener_bind`, `migration`, `watchdog_miss`). Session-attributable crashes (e.g., `claude_exit`, `pty_eof`, `worker_exit`) carry the owning session's `principalKey` as `owner_id`. v0.3 daemon rejects `OWNER_FILTER_ALL` with `PermissionDenied` (v0.4 admin principals will accept it additively, no wire shape change); v0.3 local-user clients use `OWNER_FILTER_OWN` which yields the same effective view (no proto reshape, no column add — the column ships from day one — see [Chapter 07](#chapter-07--data-and-state) §3 and [Chapter 09](#chapter-09--crash-collector) §1).

#### 6. Settings service (`settings.proto`)

```proto
syntax = "proto3";
package ccsm.v1;
import "ccsm/v1/common.proto";

<!-- F1: closes R0 04-P0.2 / R0 07-P0.2 / R2 P0-04-3 — scope enum pinned at v0.3 freeze; security-sensitive keys removed from RPC entirely so v0.4 admin gating is config-file-only and additive. -->

service SettingsService {
  rpc GetSettings(GetSettingsRequest) returns (GetSettingsResponse);
  // F7: closes R5 P1-04-1 — `UpdateSettings` semantics are PARTIAL UPDATE
  // by field presence: daemon REPLACES only fields whose proto3 presence
  // bit is set on the incoming `Settings` message; fields with no
  // presence-bit set are LEFT AT THEIR CURRENT VALUE (NOT cleared, NOT
  // defaulted). `Settings` fields use the `optional` keyword (proto3
  // field presence) so a client clearing `crash_retention.max_entries`
  // back to 0 is wire-distinguishable from "not touching the field".
  // Daemon MUST round-trip the post-merge `Settings` in the response so
  // the client sees the authoritative resolved view.
  rpc UpdateSettings(UpdateSettingsRequest) returns (UpdateSettingsResponse);
}

// Forever-stable. v0.3 daemon honors only SETTINGS_SCOPE_GLOBAL; v0.4 adds
// SETTINGS_SCOPE_PRINCIPAL additively. The enum value lives at v0.3 freeze
// so v0.4 introduces no new oneof / no new request shape.
enum SettingsScope {
  SETTINGS_SCOPE_UNSPECIFIED = 0;  // treated as GLOBAL
  SETTINGS_SCOPE_GLOBAL = 1;       // single-row-per-key for the daemon install
  SETTINGS_SCOPE_PRINCIPAL = 2;    // v0.4: per-principal overrides; rejected with InvalidArgument in v0.3
}

message GetSettingsRequest {
  RequestMeta meta = 1;
  SettingsScope scope = 2;         // default UNSPECIFIED == GLOBAL
}
message GetSettingsResponse {
  RequestMeta meta = 1;
  Settings settings = 2;
  SettingsScope effective_scope = 3; // echo of the scope the daemon resolved
}

message UpdateSettingsRequest {
  RequestMeta meta = 1;
  Settings settings = 2;
  SettingsScope scope = 3;         // default UNSPECIFIED == GLOBAL
}
message UpdateSettingsResponse {
  RequestMeta meta = 1;
  Settings settings = 2;
  SettingsScope effective_scope = 3;
}

// Forever-stable wrapper. Field additions are additive (proto3 default to zero).
//
// SECURITY-SENSITIVE KEYS EXCLUDED FROM RPC.
// `claude_binary_path` and any other key that controls which executable the
// daemon spawns or which library it loads is a code-execution primitive and
// MUST NOT be settable via UpdateSettings. v0.3 reads these keys ONLY from
// the daemon config file written at install time (per-OS path in chapter
// [Chapter 10](#chapter-10--build-package-installer) §5). The RPC surface deliberately
// omits a `claude_binary_path` field so the boundary is mechanical: there
// is no proto field to set. v0.4 keeps the same exclusion; if a per-user
// override is ever needed it ships as a separate AdminSettingsService gated
// on a peer-cred admin allowlist (additive new RPC, not a new field on the
// existing message). See [Chapter 05](#chapter-05--session-and-principal) §5
// "Per-RPC enforcement matrix" for the principal-side rule.
message Settings {
  // field 1 reserved historically for claude_binary_path; intentionally
  // omitted in v0.3 so the wire schema cannot carry it. Do NOT reuse field
  // number 1 for anything else (see [Chapter 15](#chapter-15--zero-rework-audit) §3).
  reserved 1;
  reserved "claude_binary_path";
  //
  // F7: closes R5 P1-04-1 — every field below uses the `optional` keyword
  // (proto3 field presence) so `UpdateSettings` PARTIAL semantics are
  // mechanically encoded on the wire. A scalar at zero with the presence
  // bit set means "the client wants this set to zero"; absence-of-bit
  // means "leave it alone". Adding new fields in v0.4+ MUST keep the
  // `optional` keyword for the same reason.
  optional PtyGeometry default_geometry = 2;
  optional CrashRetention crash_retention = 3;
  // F6: closes R1 P0.4 / P0.5 (chapter 08) — v0.2 per-renderer prefs
  // (theme, font, drafts list, closeAction, notifyEnabled, sidebar
  // width, language, etc.) live in this map so the daemon DB is the
  // single source of truth across Electron / v0.4 web / v0.4 iOS.
  // Keys are dotted paths (e.g., `appearance.theme`, `composer.fontSizePx`,
  // `notify.enabled`); values are JSON-encoded strings (parsed per
  // documented key). The map is open: new keys land additively without
  // a proto bump. Daemon does NOT validate the value shape — clients
  // own the schema for their own keys.
  map<string, string> ui_prefs = 4;
  // F6: closes R1 P0.1 / P0.4 (chapter 08) — `Settings.detected_claude_default_model`
  // surfaces the user's `~/.claude/settings.json` `model` field as the
  // default for new sessions; daemon reads at boot and on each
  // GetSettings call (cheap; the file is small). Empty string ==
  // "no default model detected; use claude CLI's own default".
  string detected_claude_default_model = 5;
  // F6: closes R1 P0.4 / P0.5 (chapter 08) — `Settings.user_home_path`
  // surfaces `os.homedir()` from the daemon's resolved process owner
  // (NOT the calling client's home — daemon and client may be different
  // OS users in v0.4) so the renderer's "Browse..." default and the
  // import-scanner know which directory to root at. v0.4 web/iOS get
  // the daemon-host home (informational; clients display as "/home/user
  // on the host").
  string user_home_path = 6;
  // F6: closes R1 P0.4 (chapter 08) — `Settings.locale` is the OS-derived
  // (or user-overridden via UpdateSettings) IETF BCP 47 language tag
  // (e.g., "en-US", "zh-CN"). Drives renderer i18n init AND the daemon's
  // OS notification language so toasts match the UI. Empty = use the
  // renderer's own detection.
  string locale = 7;
  // F6: closes R1 P1.1 (chapter 09) — preserved Sentry opt-out toggle
  // (today's `crashReporting` pref). Default true (matches v0.2). When
  // false, the Electron-side Sentry init ([Chapter 09](#chapter-09--crash-collector)
  // §5) skips initialization. The daemon's local SQLite crash log is
  // independent of this toggle and is always-on.
  bool sentry_enabled = 8;
}

message CrashRetention {
  int32 max_entries = 1;       // daemon caps at 10000
  int32 max_age_days = 2;      // daemon caps at 90
}
```

The on-disk shape mirrors the wire enum: the SQLite `settings` table is keyed `(scope, key, value)` from day one with `scope = 'global'` for every v0.3 row (see [Chapter 07](#chapter-07--data-and-state) §3). v0.4 inserts rows with `scope = 'principal:<principalKey>'` additively; v0.3 rows remain valid as global defaults.

#### 6.1 Notify service (`notify.proto`)

<!-- F6: closes R1 P0.2 / P0.4 (chapter 08) — daemon owns the 7-rule notify decider so toast / badge / flash / OSC-title triggers reach Electron renderer / v0.4 web / v0.4 iOS through one stream. The decider's inputs (PTY data, claude SDK JSONL tail, session state changes) all live in the daemon; the only client-supplied inputs are `focused`, `active_sid`, and `user_input` markers. -->

```proto
syntax = "proto3";
package ccsm.v1;
import "ccsm/v1/common.proto";

service NotifyService {
  // Server-streams decider-emitted events. Client subscribes once on
  // boot. Stream lifecycle mirrors WatchSessions (UNAVAILABLE on
  // daemon restart → client reconnects with backoff; daemon emits a
  // catch-up burst of any unread events on resume — bounded at 100
  // entries per session to avoid overwhelm after a long offline).
  rpc WatchNotifyEvents(WatchNotifyEventsRequest) returns (stream NotifyEvent);

  // Client → daemon setters. Drive decider Rules 1-3 (focus mute,
  // active-sid mute, post-input mute). All unary; daemon updates
  // in-memory decider state; no DB write.
  rpc MarkUserInput(MarkUserInputRequest) returns (MarkUserInputResponse);
  rpc SetActiveSid(SetActiveSidRequest) returns (SetActiveSidResponse);
  rpc SetFocused(SetFocusedRequest) returns (SetFocusedResponse);
}

message WatchNotifyEventsRequest {
  RequestMeta meta = 1;
  // Per-principal filter is implicit (peer-cred middleware scopes to
  // ctx.principal's sessions). No `scope` widening in v0.3; v0.4 admin
  // principals get a separate `WatchAllNotifyEvents` admin RPC if
  // needed (additive new RPC, not a new field on this request).
}

// One event per decider firing. Forever-stable.
message NotifyEvent {
  string id = 1;            // ULID; client uses for dedupe across reconnects
  int64 ts_unix_ms = 2;
  string session_id = 3;
  NotifyKind kind = 4;
  // Optional payload by kind:
  string toast_title = 5;          // for TOAST kind
  string toast_body = 6;           // for TOAST kind
  int32 badge_unread_count = 7;    // for BADGE kind; absolute count, not delta
  // Open string set for v0.4 additions; v0.3 emits "" or one of the known set.
  string flash_pattern = 8;        // for FLASH kind: "halo-pulse" (v0.3 only); v0.4 may add others
}

// Forever-stable. Append-only.
enum NotifyKind {
  NOTIFY_KIND_UNSPECIFIED = 0;
  NOTIFY_KIND_TOAST = 1;     // OS native notification
  NOTIFY_KIND_BADGE = 2;     // dock/taskbar unread count update
  NOTIFY_KIND_FLASH = 3;     // in-renderer AgentIcon halo pulse
  NOTIFY_KIND_TITLE = 4;     // OSC-title-derived title push (Sidebar refresh)
}

message MarkUserInputRequest {
  RequestMeta meta = 1;
  string session_id = 2;
  int64 ts_unix_ms = 3;       // client-supplied; daemon uses for the Rule-1 60s post-input mute window
}
message MarkUserInputResponse { RequestMeta meta = 1; }

message SetActiveSidRequest {
  RequestMeta meta = 1;
  string session_id = 2;      // empty = no session is active (renderer in non-terminal view)
}
message SetActiveSidResponse { RequestMeta meta = 1; }

message SetFocusedRequest {
  RequestMeta meta = 1;
  bool focused = 2;           // OS-window focused state; drives Rule-2 active-window mute
}
message SetFocusedResponse { RequestMeta meta = 1; }
```

Daemon-side decider state (in-memory only; lost on daemon restart by design — toast suppression windows reset is acceptable UX): `{focused: bool, activeSid: string, lastUserInputMsBySid: map<string, int64>, unreadBySid: map<string, int32>}`. The 7 rules from `electron/notify/notifyDecider.ts` move verbatim; their inputs are all daemon-resident post-split.

#### 6.2 Draft service (`draft.proto`)

<!-- F6: closes R1 P1.4 (chapter 08) — drafts (per-session composer text) survive Electron restart AND v0.4 web/iOS pick up where the user left off. Daemon stores drafts in the `app_state`-style settings table under key `draft:<session_id>` for v0.3 simplicity; a dedicated table can be added additively in v0.4 if perf demands. -->

```proto
syntax = "proto3";
package ccsm.v1;
import "ccsm/v1/common.proto";

service DraftService {
  // Forever-stable. Drafts are per-session, owned by the session's
  // principal (peer-cred middleware enforces; daemon NEVER returns
  // a draft whose session.owner != ctx.principal).
  rpc GetDraft(GetDraftRequest) returns (GetDraftResponse);
  rpc UpdateDraft(UpdateDraftRequest) returns (UpdateDraftResponse);
}

message GetDraftRequest {
  RequestMeta meta = 1;
  string session_id = 2;
}
message GetDraftResponse {
  RequestMeta meta = 1;
  string text = 2;             // empty if no draft exists
  int64 updated_unix_ms = 3;   // 0 if no draft exists
}

message UpdateDraftRequest {
  RequestMeta meta = 1;
  string session_id = 2;
  string text = 3;             // empty string DELETES the draft (matches v0.2 behavior — clearing the composer wipes the draft)
}
message UpdateDraftResponse {
  RequestMeta meta = 1;
  int64 updated_unix_ms = 2;
}
```

Client write cadence is debounced at the renderer (typical 500ms); daemon does NOT throttle. Storage cost is bounded by the session count (drafts are deleted on `DestroySession`).

#### 7. Forever-stable vs v0.3-internal labels

| Message / RPC | Status | Notes |
| --- | --- | --- |
| `Principal`, `LocalUser` | **forever-stable** | new principal kinds added as new oneof variants only |
| `SessionState` enum | **forever-stable** | new states append; existing values never repurposed |
| `RequestMeta`, `ErrorDetail` | **forever-stable** | every RPC carries these |
| `Session`, `PtyGeometry` | **forever-stable** | additions only via new optional fields with new field numbers |
| `SessionService.*`, `PtyService.*`, `CrashService.*`, `SettingsService.*`, `NotifyService.*`, `DraftService.*` | **forever-stable** RPC names + signatures | new RPCs added as new methods only |
| `PtySnapshot.screen_state` byte payload | **v0.3-internal** | the *bytes field itself* is forever-stable; the encoding inside is gated by `schema_version`; see [Chapter 06](#chapter-06--pty-snapshot--delta) for the v0.3 schema |
| `CrashEntry.source` string values | **v0.3-internal** (open set) | new values added freely; daemon and client both tolerate unknown |
| `HelloRequest.client_kind` string values | **v0.3-internal** (open set) | same rule as `CrashEntry.source`; v0.3 known set `{electron, web, ios}`; daemon MUST tolerate any UTF-8 string and MUST NOT branch behavior on the value ([Chapter 15](#chapter-15--zero-rework-audit) §3) |
| `HelloResponse.listener_id` string values | **v0.3-internal** (open set) | v0.3 always `"A"`; v0.4 adds `"B"`; clients tolerate unknown |
| Supervisor HTTP endpoints | **forever-stable** by URL + JSON shape | not Connect, not in proto |

The CI lint job runs `buf breaking` on every PR **from phase 1 onward** — pre-tag the comparison target is the PR's merge-base SHA on the working branch (so any in-flight PR that shifts a v0.3 message MUST be intentional and reviewed); post-tag the comparison target is the v0.3 release tag. This closes the "buf-breaking is disabled until v0.3 ships" gap that previously let a v0.3.x patch silently mutate the wire schema. In addition, every `.proto` file's SHA256 is recorded in `packages/proto/lock.json` (committed) and CI rejects any PR that touches a `.proto` file without bumping the matching SHA in `lock.json` (the bump is mechanical: `pnpm --filter @ccsm/proto run lock` regenerates and the PR author commits the result). See [Chapter 11](#chapter-11--monorepo-layout) §6 for the CI wiring and [Chapter 13](#chapter-13--release-slicing) §2 phase 1 for the "active from day one" milestone.

##### 7.1 Proto contract tests (F7)

The forever-stability promise is enforced mechanically by `buf breaking` (above) plus a small set of contract tests under `packages/proto/test/`. Every test below MUST exist by phase 1 and run on every PR:

- `proto/open-string-tolerance.spec.ts` — closes R4 P1. Asserts both directions for the open-string-set fields (`CrashEntry.source` and `HelloRequest.client_kind`):
  - Daemon receives `client_kind = "rust-cli"` (a value not in v0.3's published `{electron, web, ios}` set) and processes Hello normally (no rejection, no branching, no throw).
  - Client receives `CrashEntry.source = "future_kind_v04"` and renders gracefully (UI shows the raw string; no crash; no schema-validation rejection).
- `proto/proto-min-version-truth-table.spec.ts` — closes R4 P1 and the [Chapter 02](#chapter-02--process-topology) §6 wording. Asserts the full negotiation truth-table:
  - `client.proto_min_version < daemon.proto_version` → daemon accepts; response carries `daemon.proto_version`.
  - `client.proto_min_version == daemon.proto_version` → daemon accepts.
  - `client.proto_min_version > daemon.proto_version` → daemon rejects with `FAILED_PRECONDITION` + `ErrorDetail.code = "version.client_too_old"` + `extra["daemon_proto_version"] = <int>`.
  - Daemon NEVER pushes a `min_compatible_client` value back (one-directional negotiation, per §3 above).
- `proto/request-meta-validation.spec.ts` — closes R4 P1. Asserts every Connect RPC rejects empty `RequestMeta.request_id` with `INVALID_ARGUMENT` + `ErrorDetail.code = "request.missing_id"`; daemon does not silently synthesize.
- `proto/error-detail-roundtrip.spec.ts` — closes R4 P1. Asserts an `ErrorDetail` attached to a `ConnectError` survives the wire and parses back into the same `code` / `message` / `extra` map on the Connect-es client. Covers a representative sample of error codes (`session.not_found`, `session.not_owned`, `version.client_too_old`, `request.missing_id`).

Additional cross-chapter tests that touch chapter 04 surface but live in their owning chapter's test directory:
- `proto/lock.spec.ts` ([Chapter 12](#chapter-12--testing-strategy) §2) — SHA-checks every `.proto` against `packages/proto/lock.json`.
- `version-mismatch.spec.ts` ([Chapter 12](#chapter-12--testing-strategy) §3) — integration variant of the truth-table test above.

#### 8. The additivity contract (mechanical)

For v0.4+ proto edits to be compliant, ALL of the following MUST hold:

1. No removal of any field, message, enum value, RPC, or service.
2. No type change of any existing field.
3. No semantic change of any existing field (documented by the `.proto` comment block above).
4. No reuse of any field number, even for previously-unused ones.
5. Any new field is added with a new field number and is `optional` in semantic terms (proto3 already makes scalars implicitly default-zero — that counts).
6. New oneof variants are appended; existing variants are never repurposed.
7. `buf breaking` against the v0.3 tagged commit (post-tag) or merge-base SHA (pre-tag) MUST pass; the gate is active from phase 1 onward, not deferred until ship.
8. Every `.proto` file mutation MUST be accompanied by a `packages/proto/lock.json` SHA bump for that file in the same PR; CI rejects mismatched PRs.

Reviewers MAY block any v0.4 PR that violates any of these mechanically.

#### 9. v0.4 delta

- **Add** new RPCs (e.g., `TunnelService.GetStatus`, `TunnelService.SetEnabled`, `IdentityService.ListPrincipals`, `WebClientService.Register`) in new `.proto` files OR appended to existing services.
- **Add** new oneof variant `Principal.cf_access` with sibling `CfAccess` message — the `reserved 2;` line in `Principal.kind` is deleted in the same patch (additive at wire level — no v0.3 producer ever emitted field 2 — and `buf breaking` accepts the move).
- **Add** new optional fields to existing messages where needed (each with a new field number).
- **Unchanged**: every byte of the proto in this chapter; every existing field number; every existing RPC signature. (SnapshotV1 ships zstd-compressed in v0.3; no `schema_version = 2` is needed for compression — see [Chapter 06](#chapter-06--pty-snapshot--delta) §2.)


---

## Chapter 05 — Session and Principal

Every Session in v0.3 is bound at create-time to a `Principal` recorded as `owner_id`. v0.3 has exactly one principal kind (`local-user`) derived from the peer-cred of the Listener A connection. Every session-touching RPC handler enforces `owner_id == ctx.principal.uid` at the RPC layer (not just SQL filter). This chapter pins the principal data model, the derivation rules, the enforcement points, and the additive path for v0.4 `cf-access:<sub>` principals — daemon code unchanged.

#### 1. Principal model

In-process (TypeScript discriminated union, mirrors the proto oneof in [Chapter 04](#chapter-04--proto-and-rpc-surface) §2):

```ts
// packages/daemon/src/principal.ts
export type Principal =
  | { kind: "local-user"; uid: string; displayName: string }
  // | { kind: "cf-access"; sub: string; aud: string; email?: string }   // v0.4
  ;

export function principalKey(p: Principal): string {
  switch (p.kind) {
    case "local-user": return `local-user:${p.uid}`;
    // case "cf-access":  return `cf-access:${p.sub}`;
  }
}
```

`principalKey` produces the canonical string used as the `owner_id` column value in SQLite. **The format is forever-stable** — `kind:identifier`. v0.4 adds new kinds; existing rows for `local-user:1000` (linux uid) or `local-user:S-1-5-21-...` (win SID) remain valid forever.

#### 2. v0.3 single-principal invariant

In v0.3:
- The peer-cred middleware on Listener A is the only producer of principals.
- It always produces `kind: "local-user"`.
- The `uid` field is the OS-native identifier rendered as string: numeric uid on linux/mac, full SID string on Windows.
- The `displayName` is the OS-reported display name (best-effort; advisory; never used for authorization).

**The daemon does NOT have a "no principal" code path.** Every RPC handler reads `ctx.principal` and assumes it is set. If middleware did not set it, the daemon throws `Unauthenticated` before reaching any handler. This invariant is a guard against accidentally regressing in v0.4 when JWT-derived principals join the model.

#### 3. Derivation rules per transport

| Transport | Mechanism | `uid` value | `displayName` source |
| --- | --- | --- | --- |
| UDS, linux | `getsockopt(SO_PEERCRED)` → uid | `String(ucred.uid)` | `getpwuid_r(uid).pw_gecos` (best-effort) |
| UDS, mac | `getsockopt(LOCAL_PEERCRED)` → xucred → cr_uid | `String(uid)` | `dscl . -read /Users/<name> RealName` (best-effort) |
| Named pipe, win | `ImpersonateNamedPipeClient` + `OpenThreadToken` + `GetTokenInformation(TokenUser)` | `LookupAccountSid` returns `SID-as-string` | `LookupAccountSid` returns name |
| Loopback TCP | OS-specific PID lookup → owning uid/SID (see [Chapter 03](#chapter-03--listeners-and-transport) §5) | as above | as above |

Display name is best-effort only — if lookup fails, set to empty string and continue. **`uid` MUST resolve or the request is rejected with `Unauthenticated`.**

#### 4. RPC-layer enforcement

Every session-touching handler runs an `assertOwnership(ctx.principal, session)` check before reading or writing session-scoped state. The check is **NOT** delegated to SQL — it is an explicit early return because:

(a) Listing RPCs filter by `owner_id` in SQL, but get/update/destroy RPCs take a session_id from the client; an SQL-only filter would return "not found" instead of "permission denied", and we want the distinction in logs.

(b) v0.4 with multiple principal kinds will need cross-principal admin RPCs (e.g., user with `local-user` principal lists everyone's sessions for support); the early return is the obvious place to add `if (principal.kind === "admin") return;`.

```ts
// packages/daemon/src/auth.ts
export function assertOwnership(p: Principal, s: Session): void {
  const sessionOwner = s.ownerId;          // e.g., "local-user:1000"
  const callerOwner = principalKey(p);     // e.g., "local-user:1000"
  if (sessionOwner !== callerOwner) {
    throw new ConnectError(
      "session not owned by caller",
      Code.PermissionDenied,
      undefined,
      [errorDetail("session.not_owned", { session_id: s.id })],
    );
  }
}
```

#### 5. Per-RPC enforcement matrix

<!-- F1: closes R0 05-P0.1 / R0 05-P0.2 / R0 05-P0.3 / R2 P0-04-3 / R2 P0-05-2 — principal-scoping baseline locked at v0.3 freeze; security-sensitive Settings keys removed from RPC. -->

| RPC | Enforcement |
| --- | --- |
| `Hello` | none (returns the principal; auth already happened in middleware) |
| `ListSessions` | SQL `WHERE owner_id = ?` with `principalKey(ctx.principal)`; **no per-row check** because none escape the filter |
| `GetSession` | load by id; `assertOwnership` before returning |
| `CreateSession` | new session's `owner_id := principalKey(ctx.principal)`; no further check |
| `DestroySession` | load by id; `assertOwnership`; then delete + tear down PTY + kill claude CLI |
| `WatchSessions` | `WatchSessionsRequest.scope` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §3) defaults to `WATCH_SCOPE_OWN`; daemon filters the in-memory event bus by `principalKey(ctx.principal)`; `WATCH_SCOPE_ALL` is rejected with `PermissionDenied` in v0.3 (the enum value exists for v0.4 admin principals only) |
| `Attach` (PtyService) | load session by id; `assertOwnership`; then begin streaming |
| `SendInput` | as above |
| `Resize` | as above |
| `GetCrashLog` / `WatchCrashLog` | `OwnerFilter` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §5) defaults to `OWNER_FILTER_OWN`; daemon filters `crash_log` by `owner_id IN (principalKey(ctx.principal), 'daemon-self')`; `OWNER_FILTER_ALL` is rejected in v0.3 with `PermissionDenied` (parity with `SETTINGS_SCOPE_PRINCIPAL` and `WATCH_SCOPE_ALL`); local-user clients use `OWNER_FILTER_OWN` which yields the same effective view (see [Chapter 07](#chapter-07--data-and-state) §3 for the column and [Chapter 09](#chapter-09--crash-collector) §1 for source-attribution rules) |
| `GetSettings` / `UpdateSettings` | `SettingsScope` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §6) defaults to `SETTINGS_SCOPE_GLOBAL`; v0.3 daemon rejects `SETTINGS_SCOPE_PRINCIPAL` with `InvalidArgument` (the enum value exists for v0.4 only). Open to any local-user principal because v0.3 has exactly one. **`claude_binary_path` and any other code-execution-controlling key is NOT a `Settings` proto field** (see [Chapter 04](#chapter-04--proto-and-rpc-surface) §6); these are read by the daemon from the install-time config file only. There is no RPC path to set them in v0.3 or v0.4 — the boundary is mechanical (the field does not exist on the wire). |

**Why crash log + settings ship principal-scoped from v0.3 day one**: even with exactly one principal, the schema, proto enum, and SQL columns are present so that v0.4 multi-principal lands as new enum-value branches and new row inserts — not as a column add or a request-shape change. See [Chapter 15](#chapter-15--zero-rework-audit) §1 (rows §5, §10) for the audit verdict. The `principal_aliases` table ([Chapter 07](#chapter-07--data-and-state) §3) is empty in v0.3 and exists so v0.4 can thread `local-user` continuity (e.g., user uid 1000 → SSO sub) without rewriting historical `owner_id` values.

#### 6. Session create flow (canonical)

```
client                            daemon                                 sqlite        pty/claude
  │ CreateSession(cwd, env,         │                                       │               │
  │   claude_args, geometry)        │                                       │               │
  ├────────────────────────────────▶│                                       │               │
  │                                 │ ctx.principal = peerCred middleware   │               │
  │                                 │ id := ULID()                          │               │
  │                                 │ ownerId := principalKey(principal)    │               │
  │                                 │ INSERT into sessions (id, owner_id,   │               │
  │                                 │   state=STARTING, cwd, ...)──────────▶│               │
  │                                 │ spawn xterm-headless host             │               │
  │                                 │ spawn `claude` cli child──────────────┼──────────────▶│
  │                                 │ wire pty master ↔ claude stdio        │               │
  │                                 │ UPDATE state=RUNNING ─────────────────▶│               │
  │                                 │ emit SessionEvent.created on bus      │               │
  │ CreateSessionResponse(session)  │                                       │               │
  │◀────────────────────────────────┤                                       │               │
```

#### 7. Restoring sessions on daemon restart

On daemon boot (per [Chapter 02](#chapter-02--process-topology) §3 step 4), the daemon reads every session row with `state IN (STARTING, RUNNING)` and:

1. Re-spawns `claude` CLI with the recorded cwd, env, args.
2. Re-creates the xterm-headless host and replays the most recent snapshot from `pty_snapshot` table (see [Chapter 07](#chapter-07--data-and-state) §3).
3. Updates state to `RUNNING` (or `CRASHED` if claude CLI fails to spawn) and writes a `crash_log` entry on failure.

The principal is **not** re-derived on daemon restart — the recorded `owner_id` in the row is authoritative. (The principal model deliberately makes the recorded id stable across reboots; `local-user:1000` is the same identity yesterday and today.)

#### 8. v0.4 delta

- **Add** `cf-access:<sub>` to the `Principal` union; add `CfAccess` proto message; add JWT validator middleware on Listener B that produces it. Existing peer-cred middleware on Listener A: unchanged.
- **Use** the existing `crash_log.owner_id` column (already `NOT NULL` from v0.3 with `'daemon-self'` sentinel for daemon-side crashes; see [Chapter 07](#chapter-07--data-and-state) §3); v0.4 simply starts setting it to attributable principalKeys for cf-access principals.
- **Use** the existing `settings(scope, key, value)` shape (already shipped in v0.3 with `scope = 'global'`); v0.4 inserts new rows with `scope = 'principal:<principalKey>'`.
- **Populate** the existing `principal_aliases` table (empty in v0.3) to thread `local-user` continuity into cf-access principals when a user moves between identity sources.
- **Add** optional admin principal kind for support flows; `assertOwnership` gets one early-return clause; `WATCH_SCOPE_ALL` and `OWNER_FILTER_ALL` are accepted from admin principals only.
- **Unchanged**: `Session.owner_id` column, `principalKey` format, every existing handler, every existing enforcement point, RPC-layer enforcement contract, session restore on boot, `crash_log.owner_id` column shape, `settings` table shape, `principal_aliases` table shape, the exclusion of `claude_binary_path` from the RPC surface.


---

## Chapter 06 — PTY: Snapshot + Delta

The PTY subsystem is the highest-risk component in v0.3: it is the only piece that must survive a hard Electron kill with binary-identical state on reattach (ship-gate (b) and (c) — see brief §11). This chapter pins the per-session topology, the snapshot encoding, the delta wire format (precisely, because v0.3 freezes it), the persistence cadence, the reconnect/replay semantics, and the 1-hour zero-loss validation harness. The proto envelope is in [Chapter 04](#chapter-04--proto-and-rpc-surface) §4; this chapter pins the bytes inside `PtySnapshot.screen_state` and the bytes inside `PtyDelta.payload`.

#### 1. Per-session topology

```
       claude CLI (subprocess of pty-host)
            │ stdio
            ▼
   ┌────────────────┐
   │ node-pty master│ ◀── SendInput RPC bytes (raw) forwarded over IPC from daemon
   └────────┬───────┘
            │ raw VT bytes (master.onData)
            ▼
   ┌──────────────────────────────────┐
   │ pty-host CHILD PROCESS (per sess)│
   │  - xterm-headless Terminal       │   ◀── used as state machine, never rendered
   │  - delta accumulator             │
   │  - snapshot scheduler            │
   │  - subscribers list (Attach RPCs)│
   └──────────────────────────────────┘
            │  IPC (Node `child_process.fork` channel)
            ▼
   ┌──────────────────────────────────┐
   │ daemon main process              │
   │  - SQLite write coalescer        │   ◀── single sqlite handle, all sessions
   │  - Connect handler dispatch      │
   │  - per-session subscriber fanout │
   └──────────────────────────────────┘
            │
            ├──▶ in-memory ring of last N deltas (N = 4096) — held in pty-host child
            ├──▶ SQLite `pty_delta` table (every delta, capped retention)
            └──▶ SQLite `pty_snapshot` table (every K seconds OR every M deltas)
```

**One pty-host CHILD PROCESS per Session** — `child_process.fork(pty-host.js)` from the daemon, NOT a `worker_threads` Worker. This is the F3-locked v0.3 position. **Why a process boundary, not a thread**:

- A worker crash from a memory-corruption bug in `node-pty` or its native dependency would take the whole daemon process down (workers share v8 heap and the daemon's address space). A child-process crash is contained: the OS reaps the child, the daemon `child.on('exit')` handler writes a `crash_log` row, marks the session `CRASHED`, and the daemon keeps serving every other session.
- v0.4 multi-principal lands additively on top of this boundary: each session's pty-host child already runs as a separate OS process and can be respawned with reduced privileges (per-principal uid drop) without touching the daemon main process. Locking the worker_threads model in v0.3 would have required a v0.4 reshape (worker → process) to get the same isolation — that reshape would be a non-additive zero-rework violation. Locking the process boundary now is forever-additive.
- IPC overhead is acceptable for v0.3: the per-session bandwidth is bounded by ship-gate (c)'s 250 MB / 60 min budget (≈ 70 KB/s average; bursty to ~20 MB/s for short windows). Node's `child_process.fork` IPC channel handles this comfortably; the SQLite write path is identical (the child sends `(delta_bytes, seq, ts)` tuples to the daemon main thread which appends to the write coalescer).
- SQLite stays single-handle in the daemon main process (avoiding multi-writer contention); the per-session child does NOT open SQLite. Snapshot bytes (post-zstd, see §2) cross the IPC channel as `Buffer`s.
- The child-process boundary makes the v0.4 "per-principal helper process" model a no-op design extension: the same child architecture, just spawned with a different uid. v0.4 does NOT add a new process boundary; it inherits this one.

`child_process.fork` is preferred over `child_process.spawn` because the IPC channel is built-in and `Buffer` transfers serialize cleanly. The pty-host child entrypoint is a small TypeScript file (`packages/daemon/src/pty/pty-host.ts`); it imports `node-pty` and `xterm-headless` directly. The `claude` CLI is the child of the pty-host (NOT of the daemon), so killing the pty-host kills `claude` automatically — the daemon never has to clean up orphaned `claude` processes after a pty-host crash.

<!-- F5: closes R0 06-P1.1 — UTF-8 spawn env locked so multi-byte/CJK is byte-identical across OSes; the delta wire format is raw VT (§3) and must not depend on the host's user locale. -->

**Spawn env UTF-8 contract (FOREVER-STABLE, ship-gate (c) prerequisite)** — when the pty-host child spawns the `claude` CLI via `node-pty`, the spawn env MUST include the following overrides regardless of the daemon's inherited environment:

- Linux + macOS: `LANG=C.UTF-8` AND `LC_ALL=C.UTF-8` (override any inherited `LANG`/`LC_ALL`/`LC_CTYPE`). On macOS where `C.UTF-8` is not a registered locale on every system, fall back to `en_US.UTF-8`; the daemon probes `locale -a | grep -F C.UTF-8` once at startup and caches the choice.
- Windows: pre-spawn run `chcp 65001` in the same console session via `node-pty`'s `cols`/`rows` initialization wrapper (the pty-host writes `cmd /c chcp 65001 >nul && claude.exe ...` as the spawn argv when on Windows), AND set env `PYTHONIOENCODING=utf-8` for any subprocess `claude` may spawn that respects it.

Any `claude` output bytes must be decodable as UTF-8 by xterm-headless on the daemon side AND xterm.js on the renderer side; the snapshot byte-equality assertion in ship-gate (c) (§8) only holds when both ends decode the exact same byte sequence. The spawn env contract is locked here (forever-stable in v0.3); v0.4 multi-principal helpers inherit the same env override.

<!-- F5: closes R3 P0-06-01 (escalated) — PTY input backpressure cap; SendInput must be bounded so a stuck child cannot bloat daemon RAM unboundedly. -->

**PTY input backpressure (FOREVER-STABLE)** — the daemon enforces a per-session pending-write byte cap of **1 MiB** on the `node-pty` master write queue. The pty-host child tracks `pendingWriteBytes` (sum of bytes passed to `master.write(buf)` minus bytes drained per node-pty's `drain` event). On `SendInput(session_id, bytes)`:

- If `pendingWriteBytes + bytes.length > 1 MiB`: the RPC returns `RESOURCE_EXHAUSTED` (Connect status code) with `ErrorDetail.code = "pty.input_overflow"` and the daemon writes a `crash_log` row (`source = "pty_input_overflow"`, `summary` includes `session_id` + current `pendingWriteBytes`); NO bytes from this `SendInput` are written to the master.
- The cap is per session (not aggregate across sessions). The cap is hard (no queueing on the daemon side); clients implement their own retry on `RESOURCE_EXHAUSTED`.
- This bounds pty-host child RSS growth when `claude` is unresponsive; combined with the in-memory delta ring cap N=4096 (§2 / §6) and snapshot-write failure handling below, the daemon is bounded in worst case to: (snapshot ring × 4096 entries) + (pty-host pending writes 1 MiB) + (subscriber unacked backlog 4096 deltas, see §5).

<!-- F5: closes R3 P1-06-04 (escalated) — child-process crash semantics (note: F3 moved this off worker_threads to child_process; the wording here adapts the original "worker crash" finding to child-process exit). -->

**Child-process crash semantics (FOREVER-STABLE)** — the daemon's `child.on('exit', (code, signal) => ...)` handler treats any non-zero exit (or any signal-induced termination) as a fatal pty-host crash for that session:

1. The daemon issues `SIGKILL` to the `claude` CLI process (which is the grandchild via the pty-host); on Linux/macOS the daemon also `kill(-pgid, SIGKILL)` to ensure any `claude`-spawned subprocesses are reaped.
2. The session's `state` flips to `CRASHED` (NOT `CLOSED`) and `should_be_running` is set to `0` so the daemon does NOT respawn it on next boot.
3. The daemon writes a `crash_log` row (`source = "pty_host_crash"`, includes exit code/signal, child-process pid, session_id).
4. All Attach subscribers for this session receive `PtyFrame.session_ended` with `reason = CRASHED` and stream is closed with `INTERNAL`.
5. The user MUST explicitly recreate the session (CreateSession with the same cwd/claude_args is the supported path); the daemon does NOT auto-recreate.

**Test-only crash branch (FOREVER-STABLE)** — to make the crash path testable in `pty-host-crash.spec.ts`, the pty-host child entrypoint reads env `CCSM_PTY_TEST_CRASH_ON` (set ONLY by the test harness; daemon production code never sets it). When set to e.g. `after-bytes:1024`, the pty-host child calls `process.exit(137)` after the first 1024 bytes of `claude` output cross the IPC boundary. This branch is gated by `if (process.env.NODE_ENV !== 'production')` AND the env var presence; production sea builds strip the branch via `tsc` dead-code elimination since the env-var name is a string literal compared against an undefined env in production.

> **MUST-SPIKE [child-process-pty-throughput]** (replaces the v0.2-era worker-thread spike): hypothesis: a Node 22 child process with `node-pty` + `xterm-headless` and an IPC channel back to the daemon keeps up with `claude` CLI's burstiest output (initial code-block dump ≥ 2 MB) without dropping or coalescing-with-loss. · validation: synthetic emitter writing 50 MB of mixed VT in 30s; assert every byte appears in the child's xterm Terminal state and every delta's seq is contiguous when received in the daemon main process. · fallback: tighten the segmentation cadence (16 ms / 16 KiB → 8 ms / 8 KiB) and/or apply zstd compression to delta payloads on the IPC channel (snapshots are already zstd-compressed per §2).

#### 2. Snapshot: encoding (bytes inside `PtySnapshot.screen_state`)

`schema_version = 1` for v0.3. **The on-wire `PtySnapshot.screen_state` bytes are zstd-compressed from day one** (F3-locked) — uncompressed v1 is 5-7 MB for a 80×24 terminal with 10k scrollback lines, which is too large for cold-start replay over CF Tunnel in v0.4 and is wasteful even on loopback. Shipping compression in v0.3 means v0.4 NEVER has to bump `schema_version` to add compression — the compression is part of v1.

The on-wire byte layout is:

```
struct SnapshotV1Wire {
  uint8  outer_magic[4];     // "CSS1" — Ccsm Snapshot v1
  uint8  codec;              // 1 = zstd (forever-stable v1 default); 2 = gzip-via-DecompressionStream (browser fallback, v0.4 web client may emit/accept)
  uint8  reserved[3];        // MUST be zero in v1; reader rejects non-zero so v2 can repurpose
  uint32 inner_len;          // length of the compressed payload that follows
  uint8  inner[inner_len];   // codec-compressed bytes; decompress yields SnapshotV1Inner below
}

struct SnapshotV1Inner {
  uint8  inner_magic[4];     // "CSS1" — same magic; nesting is intentional so a corrupted outer header doesn't smuggle in a different inner schema
  uint16 cols;
  uint16 rows;
  uint32 cursor_row;        // 0-based
  uint32 cursor_col;        // 0-based
  uint8  cursor_visible;    // 0 or 1
  uint8  cursor_style;      // 0=block, 1=underline, 2=bar
  uint32 scrollback_lines;  // count of lines below
  uint32 viewport_lines;    // == rows; included for forward-compat
  uint8  modes_bitmap[8];   // app-cursor, app-keypad, alt-screen, mouse-modes, ...
                            // bit positions are FOREVER-STABLE; new modes use new bits
  uint32 attrs_palette_len;
  AttrEntry attrs_palette[attrs_palette_len];   // dedup table for cell attrs
  // lines: scrollback first (oldest→newest), then viewport (top→bottom)
  Line lines[scrollback_lines + viewport_lines];
}

struct AttrEntry {
  uint32 fg_rgb;       // 0xRRGGBB; 0xFF000001 = default
  uint32 bg_rgb;       // same
  uint16 flags;        // bold, italic, underline, blink, reverse, dim, strike, hidden
}

struct Line {
  uint16 cell_count;
  Cell   cells[cell_count];
  uint8  wrapped;      // continuation-line marker
}

struct Cell {
  uint32 codepoint;    // unicode scalar value of the BASE grapheme cluster character; 0 = empty
  uint32 attrs_index;  // index into attrs_palette
  uint8  width;        // 1 or 2 (for east-asian wide)
  uint8  combiner_count;        // number of combining marks following this cell (0 if none)
  uint32 combiners[combiner_count]; // unicode scalar values of combining marks (in original sequence order)
}
```

**Codec rules** (forever-stable v1):

- Daemon ALWAYS emits `codec = 1` (zstd) in v0.3. The zstd dictionary is the empty dictionary (no shared dict) so the bytes are self-contained.
- Web/iOS clients in v0.4 MAY consume `codec = 1` via the `@bokuweb/zstd-wasm` (or equivalent) wasm module; for browsers without wasm or for size-constrained mobile builds, daemon MAY be configured (server-side `Settings`) to emit `codec = 2` (gzip), which decompresses via the browser's native `DecompressionStream("gzip")` with no extra wasm. v0.3 daemon MUST support reading both codecs (round-trip tests cover this) but MUST emit `codec = 1` by default.
- Both codecs decompress to the SAME `SnapshotV1Inner` byte layout; the inner bytes are forever-stable.
- `reserved` bytes MUST be zero in v1; readers MUST reject non-zero so v2 can repurpose them (e.g., chunked snapshots, dictionary-id, etc.).

<!-- F5: closes R4 P0 ch 06 SnapshotV1 encoder non-determinism — palette ordering and modes_bitmap bit→mode mapping pinned so encode(state) is byte-identical across runs and across daemon vs client. -->

**Encoder determinism rules** (FOREVER-STABLE v1; ship-gate (c) byte-equality depends on these):

- **`attrs_palette` ordering**: the encoder walks cells in canonical order — **scrollback lines oldest→newest, then viewport lines top→bottom; within each line left→right** — and appends each previously-unseen `(fg_rgb, bg_rgb, flags)` tuple to the palette **in order of first appearance**. The first cell scanned that has the default attrs produces palette entry `0`. Two encoders given the same input cells MUST produce the same palette ordering.
- **`modes_bitmap[8]` bit→mode mapping** (each byte LSB→MSB; bit 0 of byte 0 is the lowest):
  - byte 0 bit 0: DECCKM (application cursor keys, `CSI ? 1 h`)
  - byte 0 bit 1: DECKPAM (application keypad, `ESC =`)
  - byte 0 bit 2: alt-screen active (`CSI ? 1049 h`)
  - byte 0 bit 3: bracketed paste (`CSI ? 2004 h`)
  - byte 0 bit 4: mouse mode X10 (`CSI ? 9 h`)
  - byte 0 bit 5: mouse mode VT200 (`CSI ? 1000 h`)
  - byte 0 bit 6: mouse mode any-event (`CSI ? 1003 h`)
  - byte 0 bit 7: mouse SGR encoding (`CSI ? 1006 h`)
  - byte 1 bit 0: DECTCEM cursor visible (`CSI ? 25 h`) — redundant with `cursor_visible` field; kept here for forward-compat
  - byte 1 bit 1: focus-tracking (`CSI ? 1004 h`)
  - byte 1 bit 2: DECOM origin mode (`CSI ? 6 h`)
  - byte 1 bit 3: DECAWM auto-wrap (`CSI ? 7 h`)
  - byte 1 bit 4: reverse video (`CSI ? 5 h`)
  - byte 1 bits 5-7 + bytes 2-7: RESERVED, MUST be zero in v1 (readers reject non-zero so v2 can grow). New modes in v0.4+ use the next contiguous bit.
- **Grapheme cluster handling** (R5 P0-06-1): the encoder MUST preserve combining marks. For each xterm-headless cell, the base character goes into `Cell.codepoint`; any combining marks attached to that cell go into `Cell.combiners[]` in their original sequence order with `combiner_count` set accordingly. A bare ASCII cell has `combiner_count = 0` and emits zero `combiners` bytes. A cell with `e + COMBINING ACUTE ACCENT` has `codepoint = U+0065`, `combiner_count = 1`, `combiners[0] = U+0301`. xterm-headless's internal cell representation already preserves the combining-mark chain via its `Cell.getChars()` API; the encoder iterates over the full grapheme cluster string and decomposes into base + combiners. This is mandatory for ship-gate (c) which mixes UTF-8 / CJK / RTL workloads (§8 step 2) — without combiners, accented Latin and Hangul precomposed-vs-decomposed sequences would lose information across encode/decode/re-encode.

**Decoder spec** (FOREVER-STABLE v1; ship-gate (c) replay path):

The v0.3 client (Electron renderer) decodes `SnapshotV1` via a **custom decoder that mutates an xterm.js `Terminal` buffer directly** (`packages/electron/src/renderer/pty/snapshot-decoder.ts`). xterm.js's `SerializeAddon` is **explicitly rejected** for the inverse path (it produces ANSI text which round-trips lossily — see "Why a custom binary" below). The decoder steps:

1. Validate outer magic (`"CSS1"`), `codec`, `reserved` bytes; reject non-v1 wrappers.
2. Decompress `inner` per `codec` (zstd or gzip) → `SnapshotV1Inner` bytes.
3. Validate inner magic, `cols`/`rows`; create a fresh xterm.js `Terminal({ cols, rows, scrollback: scrollback_lines })`.
4. For each scrollback line then each viewport line, for each cell, call into the (private but stable) xterm.js buffer API to write `(codepoint + combiners) → BufferLine` directly with the resolved attrs from `attrs_palette[attrs_index]`. Width is taken from `Cell.width`; wide-cell continuation cells are inserted as required by xterm.js's invariants.
5. Apply `modes_bitmap` bit-by-bit by writing the corresponding `CSI ? N h/l` sequences through `Terminal.write()` so xterm.js's mode-state machine stays consistent.
6. Position cursor (`cursor_row`, `cursor_col`) and apply `cursor_visible` / `cursor_style`.

The decoder lives client-side; the daemon never decodes its own snapshots in production. Test code in `packages/daemon/test/integration/snapshot-roundtrip.spec.ts` imports the decoder from a shared package (`packages/snapshot-codec/`) so daemon-side property tests can do `decode(encode(state)) ≈ state`. This shared codec package has zero runtime dependencies beyond zstd; it is forever-stable.

All multi-byte integers are little-endian. The format is **stable for `schema_version == 1`** (covering both inner layout AND outer codec wrapper). New fields require `schema_version = 2`; daemon and client both retain code for every shipped version forever. Compression-codec additions stay inside `codec` byte (open enum bounded by what readers tolerate); they do NOT bump `schema_version`.

**Why a custom binary, not e.g. xterm-headless's serializer**: (a) xterm.js's `SerializeAddon` produces ANSI text which loses cell-level attribute precision for some edge cases (256-color blends, wide cell continuation); (b) we want to checksum the snapshot deterministically so replay tests can compare bytes; (c) we want the wire size predictable (uncompressed inner payload ≤ ~5-7 MB for 80×24 + 10k lines scrollback typical; zstd-compressed `screen_state` typically 200-800 KB which is dogfood-acceptable on loopback AND survives a v0.4 cold cf-tunnel attach without a multi-second stall).

> **MUST-SPIKE [snapshot-roundtrip-fidelity]**: hypothesis: a SnapshotV1 encoded from xterm-headless state X, decoded in a fresh xterm-headless instance Y, and re-encoded, produces byte-identical SnapshotV1. · validation: property-based test with 1000 random VT byte sequences fed into X, assert encode(X) == encode(decode(encode(X))). · fallback: lower the bar to "rendered text + cursor + style match"; would weaken ship-gate (c) — escalate to user before lowering.

#### 3. Delta: wire format (bytes inside `PtyDelta.payload`)

A delta payload is **a contiguous slice of raw VT bytes** as emitted by `node-pty` master. No re-encoding, no escape-sequence parsing on the daemon side before storing. **Why raw**:

- xterm-headless on the client side replays raw VT correctly by definition (it's the same state machine as on the daemon side).
- Storing raw avoids round-trip loss (any encode/decode would be a bug surface).
- It is the smallest representation (no per-cell expansion).

Delta segmentation rules (daemon-side):

1. The pty-host worker reads from `node-pty` master `data` events. Each event yields a `Buffer`.
2. The worker accumulates bytes for **at most 16 ms or 16 KiB**, whichever first; emits a `PtyDelta` with monotonic `seq` (per session, starting at 1 after each snapshot's `base_seq`).
3. Empty intervals (no bytes) emit no delta.
4. The worker also feeds the same bytes into its xterm-headless `Terminal.write()` so its in-memory state stays current for snapshot generation.

Delta `seq` is **per session**, **monotonically increasing by 1**, and **never reused**. After a snapshot is taken, the snapshot's `base_seq` equals the most recent delta's `seq` at the moment of capture. New deltas after that snapshot start at `base_seq + 1`.

<!-- F5: closes R0 06-P1.2 — segmentation cadence is per-session, NOT per-subscriber. The forbidden-pattern lock lives in chapter 15 §3 (F8 owns); the narrative lock lives here. -->

**Segmentation cadence is per-session** (FOREVER-STABLE) — the 16 ms / 16 KiB accumulator runs once per session in the pty-host child, BEFORE the multi-subscriber broadcast (§6). Every Attach subscriber for the same session sees the SAME delta `seq` boundaries; the daemon does NOT re-segment per subscriber. This invariant is what makes `since_seq` resume cheap (the daemon stores deltas keyed by `(session_id, seq)`, not `(session_id, subscriber_id, seq)`) and what makes the in-memory ring (§5) shareable across subscribers. v0.4 web/iOS subscribers do not re-segment either; they get the exact same byte boundaries as Electron.

#### 4. Snapshot cadence

Daemon takes a snapshot for each session when ANY of:
- `K_TIME = 30 seconds` since last snapshot AND at least one delta since.
- `M_DELTAS = 256` deltas since last snapshot.
- `B_BYTES = 1 MiB` total delta bytes since last snapshot.
- An explicit `Resize` was processed (geometry change is hard to replay via deltas alone).

<!-- F5: closes R0 06-P1.3 — Resize-triggered snapshot coalescing (drag-resize emits Resize many times per second; without coalescing the daemon would queue a snapshot per Resize). -->

**Resize-snapshot coalescing** (FOREVER-STABLE) — when multiple `Resize` RPCs arrive for the same session within a 500 ms window, the daemon takes **at most one** Resize-triggered snapshot per 500 ms per session. The pty-host child holds a per-session `resizeSnapshotPendingUntil: number | null` timestamp; on Resize, if `pendingUntil > now` the snapshot is suppressed (the geometry update still applies to xterm-headless and is reflected in the next time-or-delta-or-byte-triggered snapshot); otherwise the snapshot is taken and `pendingUntil = now + 500`. The K_TIME / M_DELTAS / B_BYTES triggers still fire normally regardless of resize coalescing.

<!-- F5: closes R3 P1-06-02 (escalated) — snapshot write failure handling; in-memory ring N=4096; 3 consecutive failures → DEGRADED state. -->

**In-memory delta ring + snapshot write failure** (FOREVER-STABLE) — the pty-host child holds an in-memory ring of the last `N=4096` deltas per session (the same N as `DELTA_RETENTION_SEQS`). On snapshot generation, the child serializes the SnapshotV1 bytes and `postMessage`s them to the daemon main process which writes the `pty_snapshot` row through the write coalescer ([Chapter 07](#chapter-07--data-and-state) §5).

If the SQLite write of a snapshot fails (disk full, I/O error, write-coalescer rejects with `RESOURCE_EXHAUSTED`):
- The daemon writes a `crash_log` row with `source = "pty_snapshot_write"`, `summary` includes session_id and the SQLite error code, `detail` includes the snapshot's `base_seq` and byte length.
- The session continues to stream live deltas to subscribers. The in-memory ring still holds the last 4096 deltas so reconnect-via-delta-replay still works for clients that haven't fallen too far behind.
- A per-session counter `consecutiveSnapshotWriteFailures` increments. On reaching `3`, the session transitions to a `DEGRADED` state (new SessionState enum value, additive in v0.3): subscribers receive `PtyFrame.session_state_changed(DEGRADED)`, the daemon stops attempting snapshot writes for this session for the next 60 seconds, and the daemon emits a `crash_log` row with `source = "pty_session_degraded"`. After the cool-down window, the daemon retries; on success the counter resets and state returns to `RUNNING`. The daemon process itself does NOT crash; other sessions are unaffected.

On snapshot, the daemon writes a `pty_snapshot` row (see [Chapter 07](#chapter-07--data-and-state) §3) and **prunes** `pty_delta` rows with `seq < new_snapshot.base_seq - DELTA_RETENTION_SEQS` where `DELTA_RETENTION_SEQS = 4096` — keeping a window large enough that any client connected within the last few snapshots can resume by delta replay rather than re-fetching a snapshot.

#### 5. Reconnect / replay semantics

Client calls `Attach(session_id, since_seq)`. Daemon decision tree:

```
if since_seq == 0:
  # fresh client; send snapshot then live deltas
  snapshot := load latest pty_snapshot for session
  emit PtyFrame.snapshot(snapshot)
  resume_seq := snapshot.base_seq + 1
elif since_seq >= oldest_retained_delta_seq:
  # client can resume; replay missing deltas
  replay := pty_delta WHERE seq > since_seq AND seq <= current_max_seq
  resume_seq := since_seq + 1
else:
  # client too far behind retained window; fall back to snapshot
  snapshot := load latest pty_snapshot
  emit PtyFrame.snapshot(snapshot)
  resume_seq := snapshot.base_seq + 1

stream every delta from resume_seq onward as PtyFrame.delta;
emit PtyFrame.heartbeat every 10s when no delta in flight.
```

The client (Electron) maintains its own `lastAppliedSeq`. On any Attach, it sends `since_seq = lastAppliedSeq`. On disconnect mid-stream, it reconnects with the last seq it actually applied (NOT the last seq it received, in case of partial application).

**Per-frame ack** (F3): `AttachRequest.requires_ack` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §4) is `false` by default; v0.3 Electron leaves it false (HTTP/2 flow control + `since_seq` resume tree are sufficient over loopback). v0.4 web/iOS clients running over CF Tunnel set `requires_ack = true` and call `PtyService.AckPty(session_id, applied_seq)` after persisting each frame. When `requires_ack` is true, the daemon tracks per-subscriber `last_acked_seq`; if a subscriber's unacked-frame backlog exceeds N=4096 deltas, the daemon closes that subscriber's stream with `RESOURCE_EXHAUSTED("subscriber ack backlog exceeded")` and the client reconnects with the last-acked seq. The mechanism ships in v0.3 so v0.4 reliability over high-latency transports requires zero proto change.

#### 6. Daemon-side multi-attach

A session may have N concurrent Attach streams (e.g., Electron crashed and relaunched while the old stream is still being torn down; a future v0.4 web client attaching alongside Electron). The pty-host worker maintains a `Set<Subscriber>` and broadcasts every delta to all. There is no per-subscriber back-pressure beyond Connect's HTTP/2 flow control — if one subscriber is slow, its stream falls behind; if it falls outside the retention window, the daemon closes its stream with `PreconditionFailed("subscriber too slow; reattach")` and the client reconnects.

#### 7. Daemon restart replay

On daemon restart, the pty-host worker for a recovered session starts with the most recent snapshot from SQLite, then writes the post-snapshot deltas back into xterm-headless to bring its in-memory state current, then starts emitting fresh deltas as `claude` CLI continues to produce output. (See [Chapter 05](#chapter-05--session-and-principal) §7 for the full restore flow.)

#### 8. 1-hour zero-loss validation harness (ship-gate (c))

Test name: `pty-soak-1h`. Lives in `packages/daemon/test/integration/pty-soak-1h.spec.ts` and the corresponding Electron-side harness in `packages/electron/test/e2e/pty-soak-reconnect.spec.ts`.

```
1. Boot daemon under test (in-process for unit; service-installed for E2E).
2. CreateSession with cwd=tmpdir, claude_args=["--simulate-workload", "60m"].
   The test build of claude CLI emits a deterministic stream:
     - mixed-language code blocks (UTF-8, CJK, RTL)
     - 256-color sequences and SGR resets
     - cursor positioning (CUP, CUU, CUD)
     - alt-screen enter/exit cycles (vim simulator phase)
     - bursts (1 MB in 50 ms) and idles (10 s of nothing)
     Total volume: ~250 MB over 60 minutes.
3. Electron-side harness Attach(session_id, since_seq=0); records every applied frame.
4. At t=10m, t=25m, t=40m: SIGKILL the Electron harness; immediately relaunch;
   Attach with the recorded last applied seq.
5. At t=60m: stop session; export the daemon-side xterm-headless Terminal state as SnapshotV1.
6. Compare against the client-side xterm-headless Terminal state (after replaying every applied frame from boot).
7. Assert SnapshotV1 byte-equality.
```

Pass criterion: SnapshotV1 byte-equality. Allowed deviation: zero. Test runs in CI nightly and gates v0.3 ship.

#### 9. v0.4 delta

- **Add** v0.4 web/iOS clients call the same `PtyService.Attach`; the daemon already broadcasts to N subscribers (§6) and `AckPty` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §4) is already wired so high-latency clients get reliable ack-driven flow control. No daemon change.
- **Add** new `codec` enum values to the SnapshotV1 wrapper (§2) if profiling demands a denser codec (e.g., zstd-with-dictionary); v0.3-shipped `codec = 1` (zstd) and `codec = 2` (gzip) retained forever. `schema_version` stays at 1.
- **Add** delta batching mode for high-latency networks (web client over CF Tunnel); add new optional `Attach.batch_window_ms` field; daemon defaults to current behavior. Existing field numbers and semantics: unchanged.
- **Unchanged**: SnapshotV1 inner encoding, raw-VT delta payload, snapshot cadence, reconnect decision tree, multi-attach broadcast, daemon restart replay, the 1-hour soak harness, the pty-host child-process boundary.

#### 10. Test inventory (ship-gate (b) + (c) verifiability)

<!-- F5: closes R4 P0/P1 ch 06 test-additions — every behavioral lock above gets a named spec file referenced from chapter 12 §3. -->

The following spec files MUST exist and pass in CI before v0.3 ship. Paths are relative to `packages/daemon/` unless noted otherwise.

| Spec file | Purpose | Closes |
| --- | --- | --- |
| `test/integration/pty-soak-1h.spec.ts` | 1-hour zero-loss workload (§8) | ship-gate (c) |
| `test/integration/pty-daemon-restart-replay.spec.ts` | Daemon restart mid-session; reattach; replay yields byte-identical Terminal state (ship-gate (b) for daemon-restart variant) | R4 P0 ch 06 |
| `test/integration/pty-multi-attach.spec.ts` | N concurrent Attach streams receive same byte boundaries; one slow subscriber doesn't block others; eviction at retention boundary (§6) | R4 P1 ch 06 multi-attach |
| `test/integration/pty/snapshot-cadence.spec.ts` | K_TIME / M_DELTAS / B_BYTES triggers at extreme low (1-byte burst) and extreme high (saturated 50 MB/s) workloads; Resize coalescing (§4 500 ms cap) | R4 P1 ch 06 cadence |
| `test/integration/pty-host-crash.spec.ts` | Test-only `CCSM_PTY_TEST_CRASH_ON` env triggers child-process exit; daemon writes `crash_log source=pty_host_crash`; session state CRASHED; subscribers receive `session_ended`; daemon survives | R4 P1 ch 06 worker→child crash testability |
| `test/integration/daemon-restart-claude-spawn-fail.spec.ts` | On daemon restart, simulate `claude` binary missing; daemon writes `crash_log source=claude_spawn_fail`; session marked CRASHED; UI surfaces failure | R4 P1 ch 06 daemon-restart claude-spawn-fail |
| `test/integration/snapshot-roundtrip.spec.ts` (property-based) | encode(state) == encode(decode(encode(state))) for 1000 random VT byte sequences (covers grapheme clusters, modes_bitmap, palette ordering — §2) | MUST-SPIKE [snapshot-roundtrip-fidelity] |

The `pty-soak-1h` test runs nightly only (60 min); all others run per-PR.


---

## Chapter 07 — Data and State

The daemon owns all state. Electron is stateless across launches (modulo trivial UI prefs in `localStorage`; not authoritative). This chapter pins the SQLite schema, the per-OS state directory layout, the migration story, the WAL/checkpoint discipline, and the backup/recovery posture.

#### 1. Storage choice: SQLite via `better-sqlite3`

Single-file SQLite database, `better-sqlite3` driver, WAL mode, `synchronous = NORMAL` **default** (configurable per §3 below via `Settings.sqlite_synchronous`), `foreign_keys = ON`. Synchronous (NOT async) driver because:
- The daemon serializes writes through the main thread's coalescer (pty-host workers `postMessage` deltas; main thread batches writes).
- Synchronous calls eliminate a class of write-ordering bugs that async drivers introduce (interleaved transactions across event-loop ticks).
- `better-sqlite3` is a native module that bundles cleanly into Node 22 sea (see [Chapter 10](#chapter-10--build-package-installer) — flagged MUST-SPIKE).

> **MUST-SPIKE [better-sqlite3-in-sea]**: hypothesis: `better-sqlite3` (a `.node` binary) can be embedded in a Node 22 sea blob and loaded at runtime. · validation: build sea on each OS, run `new Database(":memory:")` smoke. · fallback: ship `better-sqlite3.node` alongside the sea executable and `require()` it via an absolute path resolved relative to the executable.

#### 2. State directory layout (per OS)

<!-- F2: closes R0 03-P0.3 / R2 P0-02-3 — descriptor path is locked unconditionally per OS; no per-install variation. -->

| OS | Daemon state root | DB path | Crash log file (raw) | Listener descriptor |
| --- | --- | --- | --- | --- |
| Windows | `%PROGRAMDATA%\ccsm\` | `state\ccsm.db` | `state\crash-raw.ndjson` | `%PROGRAMDATA%\ccsm\listener-a.json` (LOCKED unconditionally; NEVER `%LOCALAPPDATA%`, NEVER `%APPDATA%`; DACL `BUILTIN\Users:Read` + `BUILTIN\Administrators:FullControl` + `LocalService:Modify` per [Chapter 03](#chapter-03--listeners-and-transport) §3) |
| macOS | `/Library/Application Support/ccsm/` | `state/ccsm.db` | `state/crash-raw.ndjson` | `/Library/Application Support/ccsm/listener-a.json` (system-wide; NEVER `~/Library/...`; mode `0644` owner `_ccsm:_ccsm`) |
| Linux | `/var/lib/ccsm/` | `state/ccsm.db` | `state/crash-raw.ndjson` | `/var/lib/ccsm/listener-a.json` (durable state dir, NOT `/run/ccsm/`; mode `0644` owner `ccsm:ccsm` for FHS group-readability) |

All paths created with mode `0700` for the daemon's service account EXCEPT the descriptor file which is mode `0644` (group-readable so per-user Electron can read it without joining the daemon's service-account group). Directory ownership and ACL set by the installer (see [Chapter 10](#chapter-10--build-package-installer) §5).

<!-- F5: closes R0 07-P1.1 — systemd RuntimeDirectory directives are locked here so the installer template (chapter 10 §5) and the daemon's bind logic (chapter 02 §3) reference one canonical source. -->

**Linux systemd directives (locked)** — the `ccsm-daemon.service` unit MUST include the following directives so systemd creates and tears down the runtime directory with correct ownership/mode automatically. The daemon does NOT create `/run/ccsm/` itself; it relies on systemd:

```ini
[Service]
RuntimeDirectory=ccsm
RuntimeDirectoryMode=0750
StateDirectory=ccsm
StateDirectoryMode=0750
User=ccsm
Group=ccsm
```

`RuntimeDirectory=ccsm` causes systemd to create `/run/ccsm/` owned by `ccsm:ccsm` mode `0750` on service start and remove it on stop. `/run/ccsm/` is where the daemon binds the Listener-A UDS ([Chapter 03](#chapter-03--listeners-and-transport) §3) — the descriptor file `listener-a.json` lives in `/var/lib/ccsm/` (the StateDirectory) per §2 above, NOT in `/run/ccsm/`, because the descriptor must persist across daemon restarts to drive Electron's `boot_id` mismatch retry path. `0750` (group-readable) lets the per-user Electron's group membership in `ccsm` (set by the installer) `connect()` the UDS without needing world-write.

##### 2.1 Descriptor file lifecycle (locked, no installer or shutdown-hook GC required)

<!-- F2: closes R2 P0-02-3 / R2 P0-03-4 — atomic write; per-boot rewrite; no within-boot churn; orphan files between boots are normal and handled by boot_id mismatch. -->

- Daemon writes the descriptor exactly **once per daemon boot**, atomically (write `listener-a.json.tmp` → `fsync` → `rename`), at startup ordering step 5 ([Chapter 02](#chapter-02--process-topology) §3) BEFORE Supervisor `/healthz` flips to 200. The descriptor carries `boot_id` (random UUIDv4 per boot, regenerated on every daemon process start), `daemon_pid`, `listener_addr`, `protocol_version`, plus the §3.2 fields in [Chapter 03](#chapter-03--listeners-and-transport).
- Daemon does NOT re-write the descriptor within a single boot. Listener A reconnect inside the same daemon process keeps the same `boot_id` and address; nothing on disk changes.
- On daemon clean shutdown the file is **left in place**. Orphan files between daemon boots are normal — Electron's `boot_id` mismatch check ([Chapter 03](#chapter-03--listeners-and-transport) §3.3) catches stale files on the next connect attempt and triggers a re-read with backoff. There is no installer / shutdown-hook GC step required for descriptor files.
- On daemon start, the daemon ALWAYS rewrites the file (does not trust prior contents) — the new `boot_id` is the freshness witness; even if the address is identical the file is rewritten so a stale `daemon_pid` doesn't linger.
- On daemon hard crash (no graceful unlink): the OS leaves the file in place; the next daemon boot rewrites it; any Electron that connected between crash and rewrite hits the `boot_id` mismatch path and retries.

XDG: on Linux, the daemon runs as a system service (not `--user`), so `XDG_*` user vars do not apply; `/var/lib/ccsm/` is the FHS-correct path. **Do not respect `XDG_DATA_HOME` for daemon state** — the daemon may run with no logged-in user.

Electron-side state (per-user, ephemeral): `%APPDATA%\ccsm-electron\` (win), `~/Library/Application Support/ccsm-electron/` (mac), `${XDG_CONFIG_HOME:-~/.config}/ccsm-electron/` (linux). Contains: window geometry, last-applied-seq cache for fast reconnect, theme. **NOT** authoritative; deletable any time.

#### 3. SQLite schema (v0.3 baseline)

All tables created by the migration `001_initial.sql`. ULIDs as `TEXT PRIMARY KEY` (lexicographically time-ordered, 26 chars).

```sql
PRAGMA journal_mode = WAL;
-- synchronous is configurable per Settings.sqlite_synchronous (see below); daemon applies the
-- chosen value at boot AFTER opening the connection but BEFORE running migrations.
-- Default: NORMAL. Allowed values: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA'. Default 'NORMAL' is the
-- ship value for v0.3 dogfood; users on flaky storage MAY raise to 'FULL' via Settings.
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_size_limit = 67108864;  -- 64 MiB cap on -wal file growth (see §5 WAL discipline)

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL  -- unix ms
);

CREATE TABLE principals (
  id            TEXT PRIMARY KEY,             -- principalKey, e.g. "local-user:1000"
  kind          TEXT NOT NULL,                -- "local-user" (v0.3)
  display_name  TEXT NOT NULL DEFAULT '',
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,           -- ULID
  owner_id        TEXT NOT NULL REFERENCES principals(id),
  state           INTEGER NOT NULL,           -- mirrors SessionState enum int
  cwd             TEXT NOT NULL,
  env_json        TEXT NOT NULL,              -- JSON object
  claude_args_json TEXT NOT NULL,             -- JSON array
  geometry_cols   INTEGER NOT NULL,
  geometry_rows   INTEGER NOT NULL,
  exit_code       INTEGER NOT NULL DEFAULT -1,-- -1 if not exited
  created_ms      INTEGER NOT NULL,
  last_active_ms  INTEGER NOT NULL,
  should_be_running INTEGER NOT NULL DEFAULT 1 -- 0 if user destroyed; 1 if daemon should respawn on boot
  -- should_be_running semantics (R5 P0-07-1, F5): chapter 05 §7 daemon-restart restore loop reads
  -- `SELECT id FROM sessions WHERE should_be_running = 1 AND state IN (RUNNING, DEGRADED)`
  -- to decide which sessions to respawn after daemon boot. CreateSession sets it to 1; explicit
  -- DestroySession RPC sets it to 0; PTY crash (state=CRASHED) flips it to 0 (chapter 06 §1) so
  -- the daemon does NOT auto-recreate a crashed pty-host on next boot. v0.4 multi-principal
  -- daemon respects the same column with no schema change.
);
CREATE INDEX idx_sessions_owner_state ON sessions(owner_id, state);

CREATE TABLE pty_snapshot (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  base_seq   INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  geometry_cols INTEGER NOT NULL,
  geometry_rows INTEGER NOT NULL,
  payload    BLOB NOT NULL,                   -- SnapshotV1 bytes (chapter 06 §2)
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, base_seq)
);
CREATE INDEX idx_pty_snapshot_recent ON pty_snapshot(session_id, base_seq DESC);

CREATE TABLE pty_delta (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  payload    BLOB NOT NULL,                   -- raw VT bytes (chapter 06 §3)
  ts_ms      INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
-- pruning: see chapter 06 §4

<!-- F1: closes R0 07-P0.1 / R0 07-P0.2 / R0 07-P0.3 / R0 09-P0.1 — owner_id, scoped settings, and principal_aliases land in 001_initial.sql so v0.4 multi-principal scoping is row-additive, not column-additive. -->

CREATE TABLE crash_log (
  id        TEXT PRIMARY KEY,                 -- ULID
  ts_ms     INTEGER NOT NULL,
  source    TEXT NOT NULL,                    -- chapter 04 §5 / chapter 09 §1 open string set
  summary   TEXT NOT NULL,
  detail    TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  owner_id  TEXT NOT NULL DEFAULT 'daemon-self' -- principalKey for session-attributable crashes; sentinel 'daemon-self' otherwise (see chapter 09 §1)
);
CREATE INDEX idx_crash_log_recent ON crash_log(ts_ms DESC);
CREATE INDEX idx_crash_log_owner_recent ON crash_log(owner_id, ts_ms DESC);

CREATE TABLE settings (
  -- Composite PK from day one so v0.4 per-principal overrides land as new
  -- rows with scope='principal:<principalKey>', not as a column add or a
  -- new table. v0.3 daemon writes scope='global' for every row and rejects
  -- any other scope at the RPC layer (see chapter 04 §6 and chapter 05 §5).
  scope TEXT NOT NULL,                         -- 'global' in v0.3; 'principal:<principalKey>' in v0.4+
  key   TEXT NOT NULL,
  value TEXT NOT NULL,                         -- JSON-encoded; readers parse per key
  PRIMARY KEY (scope, key)
);

CREATE TABLE principal_aliases (
  -- Empty in v0.3; populated in v0.4 to thread local-user continuity
  -- across identity sources (e.g., a user's local-user uid → their
  -- cf-access sub). Keyed by alias so a single canonical principal can
  -- absorb many aliases over time. v0.3 daemon ignores this table.
  alias_principal_key     TEXT NOT NULL PRIMARY KEY,
  canonical_principal_key TEXT NOT NULL,
  created_ms              INTEGER NOT NULL
);

CREATE TABLE cwd_state (
  -- Per-session "last known cwd" tracker so a session restored after crash
  -- restarts in the cwd the user was actually in, not the original CreateSession cwd.
  -- Update path (R4 P1 ch 07, F5): the pty-host child parses OSC 7 sequences
  -- (xterm/iTerm2 "current working directory" notification: ESC ] 7 ; file://<host>/<path> BEL)
  -- from the raw VT byte stream as the SOLE source of truth for cwd updates. The shell
  -- (claude's spawned shell, via PROMPT_COMMAND/precmd hooks) is responsible for emitting
  -- OSC 7 on every cd; the daemon does NOT shell out to lsof/proc to discover cwd. On parse,
  -- the pty-host child posts {kind: "cwd_update", sessionId, cwd, tsMs} to the daemon main
  -- process which UPSERTs this row through the write coalescer (§5). Restored sessions read
  -- this row at boot; if absent (no OSC 7 ever observed), they fall back to sessions.cwd.
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  cwd        TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
```

<!-- F5: closes R0 07-P1.2 — SQLite synchronous configurability moved to Settings so users on flaky storage can opt into FULL without a daemon code change or schema migration. -->

**Settings keys consumed by the storage layer** (FOREVER-STABLE in v0.3; live in the `settings` table with `scope = 'global'`):

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `sqlite_synchronous` | string enum | `"NORMAL"` | Applied as `PRAGMA synchronous = <value>` at boot AFTER opening the connection. Allowed: `"OFF"`, `"NORMAL"`, `"FULL"`, `"EXTRA"`. Daemon rejects any other value at the `UpdateSettings` RPC layer ([Chapter 04](#chapter-04--proto-and-rpc-surface) §6) with `INVALID_ARGUMENT`. Change requires daemon restart to take effect (the value is read once at boot). |
| `wal_autocheckpoint_pages` | integer | `1000` | Applied as `PRAGMA wal_autocheckpoint = <value>` at boot. Range 100–100000. |
| `pty_snapshot_compression_codec` | integer | `1` | `1 = zstd`, `2 = gzip` ([Chapter 06](#chapter-06--pty-snapshot--delta) §2). |

#### 4. Migration story

- One file per migration: `packages/daemon/src/db/migrations/NNN_<name>.sql`. v0.3 ships exactly `001_initial.sql`.
- On daemon boot: read `schema_migrations.version`, run any unapplied files in order in a transaction, insert the row, commit.
- **Migrations are forward-only**. No `down`. If a migration is wrong, the next migration fixes it forward.
- **v0.3 migration files are immutable after v0.3 ships.** v0.4 starts at `002_*.sql`. Editing `001_initial.sql` post-ship is a hard CI block (`buf breaking`-style: a SHA256 of `001_initial.sql` is committed as a constant in `packages/daemon/src/db/migrations/locked.ts`; CI compares).

<!-- F5: closes R0 07-P1.3 + R4 P0 ch 07 migration immutability SHA256 lock — the lock is enforced by a CI script that compares the in-tree SHA against the SHA recorded at the v0.3 release tag, so any post-tag edit fails CI. -->

**Migration SHA256 lock (CI-enforced, FOREVER-STABLE)** — the immutability invariant is mechanically enforced:

1. At v0.3 tag time, CI computes `sha256sum packages/daemon/src/db/migrations/001_initial.sql` and writes the digest into the GitHub release body under the heading `### Migration locks` (one line per migration). The release notes for v0.3.0 are the canonical source.
2. The script `tools/check-migration-locks.sh` (run in CI on every PR after the v0.3 tag exists) does:
   - `gh release view v0.3.0 --json body --jq .body` to fetch release notes from the v0.3 release tag (NOT from `main` branch — the release tag is the immutable witness).
   - Parses the `### Migration locks` block to extract `(filename → sha256)` pairs.
   - For each pair, computes the local SHA of the file at HEAD and compares.
   - Exits non-zero on any mismatch OR on any v0.3-vintage file (`001_*.sql`) that has been deleted.
   - Pre-tag (no v0.3 release exists yet), the script no-ops — it's only meaningful AFTER the freeze.
3. The script also enforces that `packages/daemon/src/db/migrations/locked.ts` exports a `MIGRATION_LOCKS` const matching the release-tag SHAs; a developer who edits `001_initial.sql` and updates `locked.ts` to match will still fail CI because the script compares against the GitHub release body, not against `locked.ts`. `locked.ts` is the runtime self-check (daemon at boot computes SHAs of bundled migrations and asserts against `MIGRATION_LOCKS`); the GitHub release body is the source-of-truth that CI cross-checks.
4. v0.4 adds `002_*.sql` etc.; CI extends the release-notes block with new entries at v0.4 tag time. The v0.3 entries remain forever — any deletion/edit of v0.3 files breaks CI on every subsequent PR.

#### 5. Write coalescing

- pty-host workers `postMessage({ kind: "delta", sessionId, seq, payload, tsMs })` to main thread.
- Main thread enqueues into a `BetterQueue` keyed by session.
- A 16 ms tick flushes per-session delta batches as one `INSERT INTO pty_delta` prepared statement repeated inside one `IMMEDIATE` transaction.
- Snapshot writes are out-of-band: own transaction, runs during a quiescent moment (no current delta flush in progress for that session); blocks deltas for that session for the snapshot duration.
- WAL checkpoint: `PRAGMA wal_autocheckpoint = 1000` (overridable per Settings); full `PRAGMA wal_checkpoint(TRUNCATE)` on graceful shutdown only.

<!-- F5: closes R3 P1-07-03 (escalated) + R4 P1 ch 07 write coalescer backpressure + WAL discipline. -->

**Failure handling (FOREVER-STABLE)** — every write through the coalescer is wrapped in `try { txn() } catch (err) { ... }`:

- On `SQLITE_FULL` / `SQLITE_IOERR` / `SQLITE_READONLY` / any disk-class error: the failed batch's bytes are dropped (NOT retried — retrying a full disk just spins). The daemon writes a `crash_log` row (`source = "sqlite_write_failure"`, `summary` includes the error code, the table name, and the session_id if applicable). The daemon process does NOT crash.
- A per-session `consecutiveDbWriteFailures` counter increments. On reaching `3`, the session transitions to `DEGRADED` (the same enum value as [Chapter 06](#chapter-06--pty-snapshot--delta) §4): live deltas continue to stream to subscribers from the in-memory ring (chapter 06 §4 N=4096), but no new rows are written until the cool-down period (60 s) expires and a probe write succeeds. This makes the daemon **survive disk-full** rather than die.
- Snapshot write failures follow the identical path ([Chapter 06](#chapter-06--pty-snapshot--delta) §4) — the snapshot crash_log source is `pty_snapshot_write` and the daemon emits `pty_session_degraded` after 3 consecutive snapshot write failures specifically.

**Queue cap and shed-load policy** — the coalescer's per-session queue is capped at `8 MiB` of pending payload bytes. On overflow:

- Pty-host child posts to the daemon main process which checks the cap before enqueuing. If exceeded, the daemon `postMessage`s back `{ kind: "ack", sessionId, seq, status: "RESOURCE_EXHAUSTED" }` to the pty-host child, which translates this into a paused state for the affected session (the child stops draining `node-pty` master events; node-pty's internal kernel-side buffer absorbs the back-pressure until either `claude` blocks or the OS pty buffer fills, at which point `claude` itself blocks on its stdout write). The daemon writes a `crash_log` row (`source = "sqlite_queue_overflow"`, includes session_id and queue depth).
- This bounds daemon RSS during disk-class incidents; the cap (8 MiB) is small enough that it triggers well before OOM but large enough to absorb a few seconds of typical bursty `claude` output.

**WAL discipline** (FOREVER-STABLE) —

- `PRAGMA journal_size_limit = 67108864` (64 MiB) is set at boot (see §3 PRAGMA list); SQLite truncates the `-wal` file to this size after each checkpoint, bounding worst-case `-wal` growth.
- `PRAGMA wal_autocheckpoint = 1000` triggers an automatic PASSIVE checkpoint roughly every 1000 pages (~4 MiB at 4 KiB page size).
- Daemon issues `PRAGMA wal_checkpoint(TRUNCATE)` on graceful shutdown to leave a clean DB on disk.
- Daemon does NOT issue `wal_checkpoint(FULL)` or `wal_checkpoint(RESTART)` during normal operation — these block writers and are only used in maintenance flows (Backup → Export, Recovery).

#### 6. Backup and recovery

v0.3 has **no automated backup**. Recovery posture:

- WAL mode + `synchronous = NORMAL` (or `FULL` per Settings) survives process kill with at most the most recent uncommitted transaction lost.
- User-initiated backup: `Settings → Backup → Export` runs `VACUUM INTO '<path>'`; UX in [Chapter 12](#chapter-12--testing-strategy) §4 has the test for this.
- Restore: `Settings → Restore` stops sessions, swaps the file, reboots the daemon. v0.3 only. Risky; gated behind a confirmation dialog naming each session that will be terminated.

<!-- F5: closes R3 P0-07-01 (escalated) + R4 P0 ch 07 corrupt-DB recovery — recovery is modal, surfaced to the user, and audit-traceable through a NDJSON sidecar that is written BEFORE the new DB is opened so the recovery event survives even if the post-recovery DB also fails. -->

**Corrupt-DB recovery (FOREVER-STABLE)** — daemon boot ordering for the integrity check:

1. **Open** `state/ccsm.db` read-only via `better-sqlite3` (`{ readonly: true }`); apply `PRAGMA busy_timeout = 5000`.
2. **Run** `PRAGMA integrity_check` (NOT `quick_check` — full check is mandatory at boot; it costs O(seconds) on a multi-MiB DB which is acceptable on the boot path).
3. **Treat any result other than the single string `"ok"` as failure** (R4 P1 ch 07). SQLite returns multiple rows when corruption is found, OR a single row with non-`"ok"` text on partial corruption — both are failures.
4. **On failure** (BEFORE opening any new DB):
   - Compute `corrupt_path = state/ccsm.db.corrupt-<unix_ms>`.
   - `rename` the corrupt DB and its `-wal` / `-shm` siblings to `<corrupt_path>` / `<corrupt_path>-wal` / `<corrupt_path>-shm` atomically. (Failure here is unrecoverable; daemon exits with a fatal log entry to systemd journal / Windows event log / launchd; supervisor restarts and tries again.)
   - **Append a NDJSON line to `state/crash-raw.ndjson`** (NOT to the new SQLite — the new DB doesn't exist yet) with the shape `{"ts_ms": <now>, "source": "sqlite_corruption_recovered", "owner_id": "daemon-self", "summary": "PRAGMA integrity_check returned non-ok; renamed db to <corrupt_path>", "detail": "<integrity_check output, truncated to 64 KiB>"}`. The NDJSON file is the FOREVER-STABLE crash sidecar ([Chapter 09](#chapter-09--crash-collector) §1 capture-source `sqlite_corruption_recovered`); it is read on next-successful-boot and replayed into the new `crash_log` table.
   - `fsync` the NDJSON file's directory.
   - **Set the daemon's `recovery_modal_pending` flag** (in-memory boolean exposed via `Supervisor /healthz` JSON `{ ..., "recovery_modal": { "pending": true, "ts_ms": <now>, "corrupt_path": "..." } }`). Electron polls `/healthz` on attach; if `recovery_modal.pending`, it shows a **blocking modal** (NOT a toast) on launch with copy: "ccsm detected database corruption at \<ts\>. Your sessions and crash history could not be recovered. The corrupted database has been preserved at \<path\> for diagnostics. A fresh database has been initialized." with an Acknowledge button that POSTs to Supervisor `/ack-recovery` to clear the flag.
5. **Open** a fresh `state/ccsm.db` read-write; run `001_initial.sql`; record `schema_migrations.version = 1`.
6. **Replay** any NDJSON lines from `state/crash-raw.ndjson` into the new `crash_log` table ([Chapter 09](#chapter-09--crash-collector) §3); leave the NDJSON file in place (it's append-only; the daemon tracks a `crash_raw_offset` in a sidecar `state/crash-raw.offset` file to avoid re-replaying on restart).
7. **Continue boot**.

This ordering ensures that even if the new DB fails to open (e.g., disk full immediately after recovery), the corruption event is on disk in a human-readable text file. Step 6 is best-effort; if it fails, the NDJSON line stays unread and is retried on next successful boot.

**Why no in-place repair**: SQLite's `.recover` CLI is not bundled with `better-sqlite3` and a v0.3 daemon does not embed a SQLite shell. Power-loss corruption in WAL mode is rare; the recovery path optimizes for "daemon survives, user is told, original file is preserved for diagnostics" over "daemon attempts magic restoration".

#### 7. v0.4 delta

- **Add** new migration files `002_*.sql`, `003_*.sql`, ... (additive only):
  - `crash_log.uploaded_at INTEGER` column for upload tracking (NULL = never uploaded).
  - `tunnel_state` table for cloudflared sidecar config.
  - new `principals.kind` value `cf-access`.
- **Use** existing `crash_log.owner_id` column (already `NOT NULL` from v0.3 with `'daemon-self'` sentinel) — v0.4 starts populating it with attributable principalKeys for cf-access principals; no schema change.
- **Use** existing `settings(scope, key, value)` shape — v0.4 inserts new rows with `scope = 'principal:<principalKey>'`; existing `scope = 'global'` rows remain valid as defaults.
- **Populate** existing `principal_aliases` table — v0.4 inserts mapping rows to thread `local-user` uid continuity into cf-access `sub` values; v0.3 daemon ignores the table.
- **Add** optional automated daily backup (writes `VACUUM INTO` to a rolling location); v0.3 manual backup remains.
- **Unchanged**: every column listed in §3, every table definition, the pty wire payloads, the migration discipline, the per-OS state root, the `crash_log.owner_id` column shape, the `settings (scope, key, value)` shape, the `principal_aliases` table shape.

#### 8. Test inventory (data/state ship-gate verifiability)

<!-- F5: closes R4 P0/P1 ch 07 test-additions — every behavioral lock above gets a named spec file referenced from chapter 12 §3. -->

The following spec files MUST exist and pass in CI before v0.3 ship. Paths are relative to `packages/daemon/`.

| Spec file | Purpose | Closes |
| --- | --- | --- |
| `test/integration/db/migration-lock.spec.ts` | `tools/check-migration-locks.sh` rejects an edited `001_initial.sql`; runtime self-check (`MIGRATION_LOCKS` const) rejects mismatched bundled migrations | R4 P0 ch 07 migration immutability |
| `test/integration/db/integrity-check-recovery.spec.ts` | Inject corruption (truncate `-wal`, scribble random bytes mid-page); daemon boots; `PRAGMA integrity_check` returns non-`"ok"`; daemon renames corrupt files; writes `crash-raw.ndjson` BEFORE opening new DB; `/healthz` reports `recovery_modal.pending = true`; new DB has fresh `001_initial.sql` schema; replays NDJSON into `crash_log` after Acknowledge | R3 P0-07-01 + R4 P0 ch 07 corrupt-DB recovery |
| `test/integration/db/wal-discipline.spec.ts` | Sustained 10 MiB/s write workload for 60 s; assert `-wal` file never exceeds `journal_size_limit` (64 MiB); assert PASSIVE checkpoints fire at ~1000-page boundary; assert `wal_checkpoint(TRUNCATE)` runs on graceful shutdown | R4 P1 ch 07 WAL |
| `test/integration/db/write-coalescer-overflow.spec.ts` | Saturate per-session queue past 8 MiB cap; assert daemon emits `RESOURCE_EXHAUSTED`-equivalent ack to pty-host; assert `crash_log source=sqlite_queue_overflow` row written; assert daemon survives | R4 P1 ch 07 write coalescer backpressure |
| `test/integration/db/disk-full-degraded.spec.ts` | Mount tmpfs with size `<` minimum payload; trigger 3 consecutive write failures; assert session transitions to `DEGRADED`; assert daemon process survives; assert other sessions unaffected | R3 P1-07-03 escalated |
| `test/integration/db/sqlite-synchronous-config.spec.ts` | Set `Settings.sqlite_synchronous = "FULL"`; restart daemon; assert `PRAGMA synchronous` returns 2 (FULL). Set invalid value; assert RPC rejects with `INVALID_ARGUMENT`. | R0 07-P1.2 |
| `test/integration/db/cwd-state-osc7.spec.ts` | Pty-host child receives `ESC ] 7 ; file://host/tmp/foo BEL` in raw VT stream; assert `cwd_state` row UPSERT'd with `cwd = "/tmp/foo"`; restart daemon; assert restored session restarts in `/tmp/foo` not original cwd | R4 P1 ch 07 cwd_state |


---

## Chapter 08 — Electron Client Migration

v0.3 ship-gate (a) requires zero `contextBridge` / `ipcMain` / `ipcRenderer` references in `packages/electron/src` (brief §11(a)). This chapter inventories every existing Electron IPC surface, maps each to a Connect call against Listener A using the proto from [Chapter 04](#chapter-04--proto-and-rpc-surface), and pins the big-bang cutover plan, the dead-code removal procedure, and the verification harness. Migration is one PR (sequenced behind the daemon-side RPC PRs); incremental coexistence is forbidden.

#### 1. Migration philosophy: big-bang, single PR

Brief §3 says **big-bang**. Why not incremental:

- Coexistence (some calls IPC, some Connect) demands two state-sync paths, two error models, and two test paths — exactly the rework the zero-rework rule forbids.
- The Electron renderer's React tree treats all data as coming from one provider; introducing a second source mid-tree requires plumbing flags everywhere.
- A clean cutover lets us delete `contextBridge`/`ipcMain` files entirely, which makes ship-gate (a) a `git rm` + `grep` rather than a partial-deletion audit.

The cutover PR is large but mechanically reviewable: every IPC call is replaced by a Connect call with a 1:1 mapping table (§3 below).

#### 2. Existing IPC surface inventory

<!-- F6: closes R1 P0.1 (chapter 08) — §2 inventory replaced with the enumeration produced by `grep -rn "ipcMain\.handle\|ipcMain\.on\|contextBridge\.exposeInMainWorld" electron/` against the v0.2 codebase. Every channel is mapped to a disposition in §3 below; silent drops are forbidden. -->

The following table is the v0.3 starting state — the canonical enumeration of every `ipcMain.handle` / `ipcMain.on` / `contextBridge.exposeInMainWorld` registration in the v0.2 Electron app, grouped by source file. This list MUST be re-verified by `grep -rn "ipcMain\.handle\|ipcMain\.on\|contextBridge\.exposeInMainWorld" electron/` at the moment the migration PR is opened; any addition since this spec was written MUST be added to the §3 mapping before the PR merges. The §3 mapping assigns every channel to one of four dispositions:

- **(a) Connect RPC** — handled by an RPC against Listener A (existing or new in [Chapter 04](#chapter-04--proto-and-rpc-surface))
- **(b) renderer-only** — pure browser API in the renderer process; no IPC, no RPC
- **(c) electron-main-only** — kept as an `ipcMain.handle` channel exempt from `lint:no-ipc` via `.no-ipc-allowlist` ([Chapter 12](#chapter-12--testing-strategy) §3); these are sanctioned non-Connect main↔renderer channels for OS-chrome / OS-shell concerns that have no daemon home and no browser equivalent (frameless titlebar, native folder picker, in-app updater)
- **(d) explicitly-cut** — feature dropped in v0.3; loss acknowledged in [Chapter 01](#chapter-01--overview) §1.2 non-goals (manager-handled brief amendment, dispatch plan §3) and added to the v0.2-feature-checklist as a known regression

| Source file (v0.2) | Channel / API | Direction | Purpose |
| --- | --- | --- | --- |
| `electron/ipc/dbIpc.ts` | `db:load`, `db:save` | renderer ↔ main | renderer-side persistence (theme, font, sidebar width, drafts, recent CWDs LRU, closeAction, notifyEnabled, crashReporting opt-out, pending session-rename queue, last-used model, auto-update preference, sessionTitles backfill state, etc.) |
| `electron/ipc/sessionIpc.ts` | `sessionTitles:get` | renderer → main | read JSONL-derived session title from claude SDK |
| `electron/ipc/sessionIpc.ts` | `sessionTitles:rename` | renderer → main | `renameSession` in claude SDK |
| `electron/ipc/sessionIpc.ts` | `sessionTitles:listForProject` | renderer → main | list sessions in a project dir |
| `electron/ipc/sessionIpc.ts` | `sessionTitles:enqueuePending`, `sessionTitles:flushPending` | renderer → main | pending-rename queue when JSONL not yet present |
| `electron/ipc/sessionIpc.ts` | `session:setActive` | renderer → main | drives badge/notify focus muting |
| `electron/ipc/sessionIpc.ts` | `notify:userInput` | renderer → main | drives notify decider Rule 1 (60s post-input mute) |
| `electron/ipc/sessionIpc.ts` | `session:setName` | renderer → main | friendly-name mirror so toasts label correctly |
| `electron/ipc/sessionIpc.ts` | `session:state`, `session:title`, `session:cwdRedirected`, `session:activate` | main → renderer | push channels |
| `electron/ipc/utilityIpc.ts` | `import:scan` | renderer → main | scan claude CLI projects directory for importable historic sessions |
| `electron/ipc/utilityIpc.ts` | `import:recentCwds`, `app:userCwds:get`, `app:userCwds:push` | renderer → main | ccsm-owned LRU of user-picked cwds |
| `electron/ipc/utilityIpc.ts` | `app:userHome` | renderer → main | `os.homedir()` for default-cwd fallback |
| `electron/ipc/utilityIpc.ts` | `cwd:pick` | renderer → main | Electron native folder picker (`dialog.showOpenDialog`); StatusBar "Browse..." button |
| `electron/ipc/utilityIpc.ts` | `paths:exist` | renderer → main | batched existence check during hydration |
| `electron/ipc/systemIpc.ts` | `ccsm:get-system-locale` | renderer → main | OS locale for i18n seed |
| `electron/ipc/systemIpc.ts` | `ccsm:set-language` | renderer → main | push resolved UI language so OS notifications match |
| `electron/ipc/systemIpc.ts` | `app:getVersion` | renderer → main | app version string |
| `electron/ipc/systemIpc.ts` | `settings:defaultModel` | renderer → main | read `~/.claude/settings.json` `model` field as new-session default |
| `electron/ipc/windowIpc.ts` | `window:minimize`, `window:toggleMaximize`, `window:close`, `window:isMaximized` | renderer → main | custom titlebar controls (frameless window) |
| `electron/ipc/windowIpc.ts` | `window:maximizedChanged`, `window:beforeHide`, `window:afterShow` | main → renderer | titlebar state push |
| `electron/updater.ts` | `updates:status`, `updates:check`, `updates:download`, `updates:install`, `updates:getAutoCheck`, `updates:setAutoCheck` | renderer → main | electron-updater controls |
| `electron/updater.ts` | `updates:status`, `update:downloaded` | main → renderer | updater state push |
| `electron/ptyHost/ipcRegistrar.ts` | `pty:list`, `pty:spawn`, `pty:attach`, `pty:detach`, `pty:input`, `pty:resize`, `pty:kill`, `pty:get`, `pty:getBufferSnapshot` | renderer → main | PTY lifecycle |
| `electron/ptyHost/ipcRegistrar.ts` | `pty:checkClaudeAvailable` | renderer → main | detect whether `claude` CLI is on PATH and resolve the path |
| `electron/ptyHost/ipcRegistrar.ts` | `pty:data`, `pty:exit` | main → renderer | PTY output / exit push |
| `electron/preload/bridges/ccsmPty.ts` | `clipboard.readText`, `clipboard.writeText` | preload-exposed | terminal pane copy/paste via `clipboard` module |
| `electron/preload/bridges/ccsmNotify.ts` | `notify:flash` | main → renderer | AgentIcon halo pulse from main-side flash sink |
| `electron/sentry/init.ts` (no IPC channel; toggle pref) | `crashReporting` opt-out | renderer pref | gates Sentry network upload init |

#### 3. Channel disposition mapping

<!-- F6: closes R1 P0.1 / P0.2 / P0.3 / P0.4 / P0.5 / P0.6 (chapter 08) — every v0.2 channel from §2 mapped to a disposition. New RPCs land in [Chapter 04](#chapter-04--proto-and-rpc-surface): `RenameSession`, `GetSessionTitle`, `ListProjectSessions`, `ListImportableSessions`, `ImportSession`, `CheckClaudeAvailable`, `GetRawCrashLog`, `NotifyService.{WatchNotifyEvents, MarkUserInput, SetActiveSid, SetFocused}`, `DraftService.{GetDraft, UpdateDraft}`. New `Settings` fields: `ui_prefs` (map), `detected_claude_default_model`, `user_home_path`, `locale`, `sentry_enabled`. New `Session.runtime_pid`. -->

The dispositions per §2:

| Channel / API | Disposition | Replacement |
| --- | --- | --- |
| `db:load`, `db:save` | (a) Connect RPC | `SettingsService.GetSettings` / `UpdateSettings` against `Settings.ui_prefs` map ([Chapter 04](#chapter-04--proto-and-rpc-surface) §6). Drafts move to `DraftService.{GetDraft, UpdateDraft}` (per-session). All `app_state` keys move to `ui_prefs`; daemon DB is the single source of truth across Electron / v0.4 web / v0.4 iOS. |
| `sessionTitles:get` | (a) Connect RPC | `SessionService.GetSessionTitle` |
| `sessionTitles:rename` | (a) Connect RPC | `SessionService.RenameSession` |
| `sessionTitles:listForProject` | (a) Connect RPC | `SessionService.ListProjectSessions` |
| `sessionTitles:enqueuePending`, `sessionTitles:flushPending` | (a) Connect RPC | Daemon owns the pending-rename queue (state in daemon); client calls `RenameSession` and daemon enqueues internally if SDK summary is not yet present. The two queue-management RPCs disappear from the client surface (daemon-internal). |
| `session:setActive` | (a) Connect RPC | `NotifyService.SetActiveSid` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §6.1) |
| `notify:userInput` | (a) Connect RPC | `NotifyService.MarkUserInput` |
| `session:setName` | (a) Connect RPC | Folded into `RenameSession` (one rename surface; toast labels read from `GetSessionTitle`) |
| `session:state` (push) | (a) Connect RPC | `SessionService.WatchSessions` carries state changes via `SessionEvent.updated`; OSC-title-derived state moves into `NotifyService.WatchNotifyEvents` `NOTIFY_KIND_TITLE` |
| `session:title` (push) | (a) Connect RPC | `NotifyService.WatchNotifyEvents` `NOTIFY_KIND_TITLE` |
| `session:cwdRedirected` (push) | (a) Connect RPC | `SessionService.WatchSessions` `SessionEvent.updated` (cwd is a `Session` field; updates flow naturally) |
| `session:activate` (push) | (a) Connect RPC | `NotifyService.WatchNotifyEvents` `NOTIFY_KIND_TOAST` carries the click-target session_id; renderer maps to a focus action |
| `import:scan` | (a) Connect RPC | `SessionService.ListImportableSessions` |
| `import:recentCwds`, `app:userCwds:get`, `app:userCwds:push` | (a) Connect RPC | LRU stored in `Settings.ui_prefs["recent_cwds"]` (JSON array, max 20); daemon trims server-side on update |
| `app:userHome` | (a) Connect RPC | `Settings.user_home_path` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §6) |
| `window:minimize`, `window:toggleMaximize`, `window:close`, `window:isMaximized` | (b) renderer-only — DELETED | Wave 0e (#247) reverted to native OS chrome (Wave 0c #953 disabled `frameless`); the OS title bar provides min/max/close + window drag without IPC. The self-drawn `WindowControls` + `DragRegion` components and the `useExitAnimation` hook were deleted from the renderer. v0.4 web/iOS already use OS-native window chrome. |
| `window:maximizedChanged`, `window:beforeHide`, `window:afterShow` | (b) renderer-only — DELETED | Same rationale; the main → renderer push variants were the wire under the deleted titlebar UI. No allowlist entry. |
| `cwd:pick` | (c) electron-main-only | Electron native folder picker has no daemon home and no browser equivalent. Kept as `ipcMain.handle("cwd:pick", ...)` in `electron/ipc-allowlisted/folder-picker.ts`; that file is on `tools/.no-ipc-allowlist`. v0.4 web client substitutes a typed text field with autocomplete (additive net-new package; not a regression of v0.3 ship). |
| `paths:exist` | (a) Connect RPC | Daemon-side existence check piggybacked on session hydration: daemon already knows session cwd; existence flag added to `Session` in v0.4 if needed (additive). v0.3: client lazily marks a session "stale-cwd" on first attach failure (no batched-stat RPC needed at v0.3 freeze). |
| `ccsm:get-system-locale` | (a) Connect RPC | `Settings.locale` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §6); daemon resolves at boot from OS APIs |
| `ccsm:set-language` | (a) Connect RPC | `SettingsService.UpdateSettings` writing `Settings.locale`; daemon picks up for OS notification language |
| `app:getVersion` | (b) renderer-only | Electron version is bundled at build time as `import.meta.env.APP_VERSION` (Vite); no IPC, no RPC. v0.4 web/iOS get the same from their own bundles. Daemon version is separate (`Hello.daemon_version` from [Chapter 04](#chapter-04--proto-and-rpc-surface) §3). |
| `settings:defaultModel` | (a) Connect RPC | `Settings.detected_claude_default_model` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §6); daemon reads `~/.claude/settings.json` |
| `updates:status`, `updates:check`, `updates:download`, `updates:install`, `updates:getAutoCheck`, `updates:setAutoCheck`, `update:downloaded` | (c) electron-main-only | `electron-updater` is Electron-process-bound (autoUpdater APIs require Electron main); no daemon equivalent. Kept as `ipcMain.handle` channels (request/response) + the two `webContents.send` push channels in `electron/ipc-allowlisted/updater-ipc.ts`; that file is on `tools/.no-ipc-allowlist`. The renderer-side bridge lives in `electron/ipc-allowlisted/preload-allowlisted.ts` (also allowlisted). v0.4 web client gets updates via service-worker / browser refresh; v0.4 iOS via App Store. Updater UI in renderer Settings stays. |
| `pty:list`, `pty:spawn`, `pty:get` | (a) Connect RPC | `SessionService.ListSessions` / `CreateSession` / `GetSession` (PTY lifecycle is session lifecycle in v0.3) |
| `pty:attach`, `pty:detach`, `pty:data` | (a) Connect RPC | `PtyService.Attach` (server-stream); detach by closing the stream |
| `pty:input` | (a) Connect RPC | `PtyService.SendInput` |
| `pty:resize` | (a) Connect RPC | `PtyService.Resize` |
| `pty:kill` | (a) Connect RPC | `SessionService.DestroySession` |
| `pty:getBufferSnapshot` | (a) Connect RPC | First frame of `PtyService.Attach` (`PtyFrame.snapshot`); explicit snapshot RPC not needed |
| `pty:exit` (push) | (a) Connect RPC | `SessionService.WatchSessions` `SessionEvent.updated` carries `state == EXITED` + `exit_code` + `runtime_pid` cleared |
| `pty:checkClaudeAvailable` | (a) Connect RPC | `PtyService.CheckClaudeAvailable` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §4) |
| `clipboard.readText`, `clipboard.writeText` | (b) renderer-only | Standard browser `navigator.clipboard.{readText,writeText}` from the renderer. Requires a one-time user-gesture for read on first use; v0.2 had no such gesture (preload-exposed `clipboard` module bypassed it), so the renderer's terminal paste handler MUST request permission on first paste. v0.4 web/iOS use the same browser API. |
| `notify:flash` (push) | (a) Connect RPC | `NotifyService.WatchNotifyEvents` `NOTIFY_KIND_FLASH` |
| `crashReporting` opt-out | (a) Connect RPC | `Settings.sentry_enabled` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §6); [Chapter 09](#chapter-09--crash-collector) §5 details the read path |

The legacy `app:open-external` channel from older v0.3 drafts is **explicitly cut**: opening external URLs is now `window.open(url, '_blank')` in the renderer for `https?://` only (rejected for `file://`, `javascript:`, etc. — see §3.2 below); opening daemon-side files (e.g., the raw crash log) is replaced with `CrashService.GetRawCrashLog` + a "Download raw log" UI in [Chapter 09](#chapter-09--crash-collector) §5. Symmetric across Electron / v0.4 web / v0.4 iOS.

> If any new IPC is found during migration that does NOT fit into one of the existing services, the migration PR MUST add the corresponding RPC to proto + daemon BEFORE merging the Electron change. New RPCs follow the additivity contract from [Chapter 04](#chapter-04--proto-and-rpc-surface) §8 — this is a v0.3 first-ship addition, not a v0.4 add.

##### 3.1 `.no-ipc-allowlist` contract (electron-main-only channels)

<!-- F6: closes R1 P0.3 / P0.6 / P1.5 (chapter 08) + R4 P0 ch 08 lint allowlist mechanism. Wave 0e (#247) finalized the v0.3 allowlist as the cwd:pick + updates:* clusters; the window:* cluster was deleted in favour of native OS chrome (Wave 0c #953 disabled frameless). The allowlist is path-based (one repo-relative path per line) — the actual lint script (tools/lint-no-ipc.sh) reads file paths and skips them from the forbidden-symbol grep. -->

The `tools/.no-ipc-allowlist` file enumerates the **finite, frozen** set of repo-relative source paths that are exempt from the `lint:no-ipc` rule's forbidden-symbol grep ([Chapter 12](#chapter-12--testing-strategy) §3 implements; §5h.1 below specifies). v0.3 contents are exactly:

```
# Renderer-side descriptor preload (per §4.1 — bootstrap mechanism).
packages/electron/src/preload/preload-descriptor.ts

# Native folder picker (cwd:pick) — no daemon home, no browser equivalent.
electron/ipc-allowlisted/folder-picker.ts

# In-app updater (updates:* + update:downloaded push) — electron-updater
# is Electron-process-bound; v0.4 web/iOS use service-worker / App Store.
electron/ipc-allowlisted/updater-ipc.ts

# Renderer-side preload bridge for the two channel clusters above.
# contextBridge.exposeInMainWorld lives ONLY here per rule 4 below.
electron/ipc-allowlisted/preload-allowlisted.ts
```

**Channel inventory (the only `ipcMain.handle` / `webContents.send` call sites permitted under the allowlist)**:

- `cwd:pick` (renderer → main, request/response) — `electron/ipc-allowlisted/folder-picker.ts`.
- `updates:status`, `updates:check`, `updates:download`, `updates:install`, `updates:getAutoCheck`, `updates:setAutoCheck` (renderer → main, request/response) — `electron/ipc-allowlisted/updater-ipc.ts`.
- `updates:status`, `update:downloaded` (main → renderer, push via `webContents.send`) — `electron/ipc-allowlisted/updater-ipc.ts`. These are the ONLY `webContents.send` call sites outside the transport bridge per §5h.1 rule 4.

The `window:*` cluster (`window:minimize` / `window:toggleMaximize` / `window:close` / `window:isMaximized` / `window:maximizedChanged` / `window:beforeHide` / `window:afterShow`) is **NOT allowlisted** — Wave 0e (#247) deleted the renderer-side `WindowControls` + `DragRegion` components and the `useExitAnimation` hook, and the BrowserWindow runs with native OS chrome (`frame: true`, since #953). v0.4 web/iOS also use OS-native chrome.

**Rules**:

1. Every entry in this file is a **repo-relative source path** (one per line). Comments start with `#`. Blank lines ignored.
2. The file is FROZEN at v0.3 ship. Adding a new entry post-ship is a brief amendment + chapter 15 §3 forbidden-pattern review (the only legitimate path is a NEW OS-chrome / OS-shell concern that has no daemon home AND no browser equivalent).
3. The corresponding `ipcMain.handle` registrations live in named files under `electron/ipc-allowlisted/` (one file per channel cluster: `folder-picker.ts`, `updater-ipc.ts`). The `lint:no-ipc` rule scopes the allowlist file-by-file: only files on the allowlist may import `ipcMain` / `ipcRenderer` / `contextBridge` or call `webContents.send`, and the lint script enforces this by skipping listed paths from the forbidden-symbol grep.
4. `contextBridge.exposeInMainWorld` is NOT allowlisted under any circumstance — the descriptor injection mechanism uses `protocol.handle` (§4.1) and OS-chrome / OS-shell channels expose their renderer-side wrappers via a separate `electron/ipc-allowlisted/preload-allowlisted.ts` (also enumerated in `.no-ipc-allowlist`).

##### 3.2 Renderer-only `window.open` URL safety

<!-- F6: closes R4 P1 ch 08 `app:open-external` URL safety test. -->

The renderer's "open external link" affordance accepts `https?://` only; every other scheme (`file://`, `javascript:`, `data:`, `chrome://`, `app://`, etc.) is rejected before `window.open` is called. The check lives in `packages/electron/src/renderer/lib/safe-open-url.ts` (a tiny module that wraps `URL` parsing + scheme allowlist) and is exercised by `packages/electron/test/ui/safe-open-url.spec.ts` covering: `https://example.com` (allowed), `http://example.com` (allowed), `file:///etc/passwd` (rejected), `javascript:alert(1)` (rejected), malformed URL (rejected), empty string (rejected). v0.4 web/iOS reuse the same module (it has no Electron-specific imports).

#### 4. Electron process model post-migration

<!-- F2: closes R0 08-P0.2 / R0 08-P0.3 / R2 P0-08-1 / R2 P0-08-2 — bootstrap mechanism is descriptor-handshake-by-fetch (no contextBridge); transport bridge ships unconditionally; DNS rebinding mitigated by bridge bound to UDS / named pipe (no loopback TCP for bridge↔daemon); descriptor authenticity via descriptor-file boot_id verification (HelloResponse does NOT echo boot_id — proto fields are pinned to meta/daemon_version/proto_version/principal/listener_id; see ch04 §3). -->

```
electron main process (minimal):
  - BrowserWindow lifecycle (create/show/close)
  - reads listener-a.json ([Chapter 03](#chapter-03--listeners-and-transport) §3) at app start; pins
    descriptor + boot_id for the renderer's session
  - hosts the renderer transport bridge (see §4.2 below) — ships unconditionally in v0.3
  - registers a custom scheme handler via protocol.handle so the renderer can
    fetch app://ccsm/listener-descriptor.json and read the (validated) descriptor
    without contextBridge / additionalArguments
  - NO ipcMain.handle calls
  - NO business logic
  - tray menu (quit / open settings) — UI, no IPC

electron preload (minimal — no contextBridge):
  - intentionally empty (or omitted entirely); the descriptor reaches the
    renderer via the app:// scheme, NOT via injection
  - NO contextBridge.exposeInMainWorld for callable APIs OR for data
  - sandbox: true; nodeIntegration: false; contextIsolation: true on every BrowserWindow

electron renderer:
  - on boot, fetch("app://ccsm/listener-descriptor.json") → parse → construct Connect
    transport pointed at the bridge (see §4.2)
  - immediately calls Hello to confirm reachability + protocol compatibility, and
    verifies the descriptor's boot_id matches the cached pin from the prior connect
    (descriptor file is the boot_id witness — HelloResponse does NOT echo boot_id;
    see [Chapter 03](#chapter-03--listeners-and-transport) §3.3 + ch04 §3); rejects + retries on mismatch
  - wraps the proto-generated SessionService/PtyService/... clients in React Query / TanStack Query hooks
  - all UI state comes from RPC results
```

##### 4.1 Bootstrap mechanism (locked: descriptor served via `protocol.handle`, no `contextBridge`)

R0 08-P0.2 flagged that `webPreferences.additionalArguments` does NOT inject onto `window` under context isolation — `additionalArguments` only appends to the renderer's `process.argv`, which is invisible from the renderer's window scope. The naive fix (`contextBridge.exposeInMainWorld`) trips ship-gate (a). The locked v0.3 mechanism avoids both:

1. Electron main reads `listener-a.json` from the locked per-OS path ([Chapter 07](#chapter-07--data-and-state) §2 / [Chapter 03](#chapter-03--listeners-and-transport) §3) at app start.
2. Electron main rewrites the descriptor's `address` field to point at the bridge's loopback endpoint (§4.2) — the renderer never sees the daemon's UDS / named pipe path because the renderer never speaks to it directly.
3. Electron main registers a custom scheme handler via `protocol.handle("app", ...)` that serves the rewritten descriptor at `app://ccsm/listener-descriptor.json` (read-only; `Content-Type: application/json`).
4. Renderer at boot calls `await fetch("app://ccsm/listener-descriptor.json")` and parses the result. No `contextBridge`, no `additionalArguments`, no preload-injected globals — `lint:no-ipc` (§5h.1) passes mechanically.
5. Renderer constructs the Connect transport from the descriptor, calls `Hello` to confirm reachability + protocol compatibility, and verifies the freshly-read `descriptor.boot_id` matches its cached pin per [Chapter 03](#chapter-03--listeners-and-transport) §3.3 before any other RPC. The descriptor file (served via `app://`) is the `boot_id` witness; `HelloResponse` carries `meta` / `daemon_version` / `proto_version` / `principal` / `listener_id` only and does NOT echo `boot_id` (proto is forever-stable; ch04 §3 / proto `session.proto`).

##### 4.2 Renderer transport bridge — ships unconditionally in v0.3

**Decision (locked, no spike outcome required)**: the Electron main process hosts a transport bridge for the renderer; v0.3 ships this bridge **unconditionally** on every OS. The bridge is `packages/electron/src/main/transport-bridge.ts`.

**Why ship unconditionally (R5 P1-14-2 + R0 08-P0.3 resolution)**:

1. **Predictability across OS** — Chromium fetch cannot use UDS or named pipes anywhere; loopback TCP works but the daemon's chosen Listener A transport may be UDS or named pipe per OS. Shipping the bridge eliminates the per-OS conditional in the renderer.
2. **Avoids Electron renderer-side gotchas** — `additionalArguments` doesn't hit `window` under context isolation; preload `contextBridge` trips `lint:no-ipc`; `protocol.handle` only serves data, not full Connect framing. The bridge sidesteps every one of these.
3. **Zero-rework for v0.4** — the v0.4 web client uses `connect-web` directly (browser → cloudflared → Listener B); v0.4 iOS uses `connect-swift` directly (iOS → cloudflared → Listener B). NEITHER goes through the Electron transport bridge — they don't even ship the Electron renderer code. So the bridge is forever Electron-internal; v0.4 never modifies it. [Chapter 15](#chapter-15--zero-rework-audit) §3 forbidden-pattern locks this: "v0.4 MUST NOT modify `packages/electron/src/main/transport-bridge.ts` for web/iOS reasons; web/iOS do not use it."

**Bridge shape**:

- Renderer ↔ bridge: `http2` server on `127.0.0.1:<ephemeral-port>` bound on `127.0.0.1` only (no `0.0.0.0`); `Host:` header MUST equal `127.0.0.1:<our-port>` (anything else → 421 Misdirected Request — closes the structural part of R2 P0-08-1 / R2 P0-03-1 DNS-rebinding hole at the bridge layer; per-request `Host:` allowlist enforcement is restated here, the deeper bearer-token belt-and-suspenders is deferred to v0.4 per dispatch plan §0).
- Bridge ↔ daemon: speaks the daemon's chosen Listener A transport (UDS / named pipe / loopback TCP / loopback TLS — whichever was negotiated). For UDS / named pipe, the bridge is the ONLY caller across the OS-level socket; the renderer never touches it. This means the bridge sits "around" the otherwise UDS-protected daemon BUT ONLY exposes loopback TCP to the renderer (which is the only way Chromium can speak Connect).
- The bridge is NOT an IPC re-introduction (it speaks Connect, same proto, no `ipcMain.handle`); ship-gate (a) grep still passes.
- Bridge process identity: the bridge runs in Electron main, so the daemon's peer-cred sees the Electron main process's uid (== the logged-in user). Correct attribution for v0.3 single-user.

#### 5. Cutover sequence (single PR)

1. (Pre-PR) Daemon-side PRs land: every RPC in [Chapter 04](#chapter-04--proto-and-rpc-surface) is implemented and tested behind a feature-flag-gated daemon binary. Connection descriptor is written. Listener A binds. Integration tests against the daemon pass.
2. (PR) The Electron migration PR:
   a. Add `packages/electron/src/rpc/clients.ts` constructing typed clients from the descriptor.
   b. Add `packages/electron/src/rpc/queries.ts` wrapping each in React Query hooks.
   c. Replace every existing `ipcRenderer.invoke(...)` and `ipcRenderer.on(...)` site with the corresponding hook (mechanical 1:1).
   d. Delete `packages/electron/src/main/ipc/` directory.
   e. Delete `packages/electron/src/preload/contextBridge.ts`.
   e2. Re-create the allowlisted `ipcMain.handle` registrations under `electron/ipc-allowlisted/{folder-picker.ts, updater-ipc.ts}` (per §3.1) and the matching renderer-side wrappers in `electron/ipc-allowlisted/preload-allowlisted.ts`. Both surfaces use `electron`'s `ipcMain` / `ipcRenderer` directly — only these files may. The `window:*` cluster is NOT re-created (Wave 0e #247: native OS chrome owns window controls).
   f. Replace preload with an empty (or omitted) file; the descriptor reaches the renderer via `protocol.handle("app", ...)` per §4.1, NOT via injection.
   g. Update `packages/electron/src/main/index.ts` to remove all `ipcMain.handle` registrations, register `protocol.handle("app", ...)` for the descriptor (§4.1), spin up the transport bridge (§4.2), and spawn a tray menu only.
   h. Add the `npm run lint:no-ipc` script per §5h.1 (canonical specification below).
   i. Wire the script into CI (see [Chapter 12](#chapter-12--testing-strategy) §3).
3. (Post-merge) E2E test (ship-gate (a)/(b)/(c)) runs in CI nightly and on every release tag.

##### 5h.1 `lint:no-ipc` canonical specification (single source of truth, this chapter)

<!-- F2: closes R5 P0-08-1 / R0 P0-08-1 / R4 P0 ch 08 / ch 12 — chapter 08 specifies; chapter 12 implements; brief references this section. -->

This chapter specifies the v0.3 canonical form of the `lint:no-ipc` ship-gate. Any divergence in 00-brief.md or [Chapter 12](#chapter-12--testing-strategy) is a documentation bug — chapter 08 §5h.1 is the source of truth. [Chapter 12](#chapter-12--testing-strategy) §3 implements the actual ESLint config + CI wiring; this section pins WHAT must be forbidden:

**Forbidden patterns (rejecting any one of these blocks the PR)**:

1. `import { ipcMain | ipcRenderer | contextBridge } from "electron"` — any named import of these three symbols from the `electron` package, in any source file under `packages/electron/src/`.
2. `require("electron").ipcMain` / `require("electron").ipcRenderer` / `require("electron").contextBridge` — destructuring or property access on the dynamically-required `electron` module.
3. Any method call shaped `.send(` / `.handle(` / `.on(` / `.invoke(` / `.handleOnce(` invoked on a symbol whose value flows from one of the forbidden Electron imports above (caught by ESLint `no-restricted-properties` + a custom rule `ccsm/no-electron-ipc-call` that performs intra-file constant-tracking; full rule body lives in [Chapter 11](#chapter-11--monorepo-layout) §5).
4. Any usage of `webContents.send`, `webContents.executeJavaScript`, `MessageChannelMain`, `MessagePortMain`, or `process.parentPort` outside `packages/electron/src/main/transport-bridge.ts` AND outside `electron/ipc-allowlisted/` (the only sanctioned non-Connect main↔renderer surfaces). The bridge is exempt because it speaks Connect framing; the allowlisted IPC files use `webContents.send` only for the push variants of allowlisted channels (currently `updates:status` and `update:downloaded`).

**Allowlist**: the FROZEN `tools/.no-ipc-allowlist` file (§3.1) enumerates the finite set of repo-relative source paths exempt from the forbidden-symbol grep. The corresponding files live under `electron/ipc-allowlisted/` (and the descriptor preload under `packages/electron/src/preload/`); the lint script scopes the allowlist file-by-file (only those files may import `ipcMain` / `ipcRenderer` / `contextBridge` or call `webContents.send`). The descriptor injection mechanism uses `protocol.handle` (§4.1), which is NOT on the forbidden-pattern list — no allowlist entry is needed for it. `contextBridge.exposeInMainWorld` lives ONLY in `electron/ipc-allowlisted/preload-allowlisted.ts`.

**Implementation reference**: [Chapter 12](#chapter-12--testing-strategy) §3 ships the actual ESLint config + the `tools/lint-no-ipc.sh` driver script + the CI wiring; chapter 08 §5h.1 is the spec.

#### 6. Renderer error-handling contract

- Every RPC may fail with `UNAVAILABLE` (daemon restarting); UI shows a non-blocking banner "Reconnecting..." and the underlying React Query retries with backoff.
- `PERMISSION_DENIED` is treated as a programming error (the only principal in v0.3 is `local-user`; ownership mismatch should not happen on a single-user machine). UI shows an error toast and logs to console; UX is "should be impossible".
- `FAILED_PRECONDITION` from `Hello` (version mismatch) shows a blocking modal "Daemon version X is incompatible with this Electron build (min Y). Please update.".
- Stream errors (`Attach`, `WatchSessions`, `WatchCrashLog`, `WatchNotifyEvents`) trigger automatic reattach with exponential backoff capped at 30s. Reattach uses the recorded last-applied seq for `Attach`. The backoff schedule is locked: `min(30s, 500ms * 2^attempt + jitter)` where jitter is uniform [0, 250ms]. Tested in `packages/electron/test/rpc/reconnect-backoff.spec.ts` with a fault-injecting transport.

##### 6.1 Daemon cold-start UX (daemon unreachable at boot)

<!-- F6: closes R1 P1.3 (chapter 08) — daemon-crash → blank-screen UX. -->

If the renderer's first `Hello` does not succeed within **8 seconds** (cold-start budget; covers daemon-still-starting on a slow VM), the renderer renders a blocking modal:

> **ccsm daemon is not running.**
>
> The ccsm background service did not respond after 8 seconds. The renderer will keep retrying in the background.
>
> [Try again now] [Open service troubleshooting]

- "Try again now" forces an immediate `Hello` retry (resets the backoff timer).
- "Open service troubleshooting" opens a renderer-side help page (no IPC, no RPC) with per-OS instructions: Windows (`Get-Service ccsm`), macOS (`launchctl print system/com.ccsm.daemon`), Linux (`systemctl status ccsm`).
- The modal is dismissible only by a successful `Hello`. The renderer continues retrying with the standard backoff (§6 above) in the background; on success the modal disappears and normal UI hydrates.

This converts the "blank screen with reconnecting banner forever" failure mode into an actionable user-facing diagnosis. The modal is a renderer-only React component (no IPC, no RPC); it depends only on the connection state surfaced by the Connect transport's first-Hello failure path.

##### 6.2 React Query renderer state layer

<!-- F6: closes R0 08-P1.2 — abstraction shape locked; v0.4 web/iOS share or duplicate. -->

The renderer wraps every proto-generated client method in a thin React Query hook layer at `packages/electron/src/renderer/rpc/queries.ts`. The abstraction shape is **forever-stable**:

- Unary RPCs: one hook per method, named `use<MethodName>` (e.g., `useListSessions(params)`), backed by `useQuery` / `useSuspenseQuery` (read) or `useMutation` (write).
- Server-stream RPCs: one hook per method, named `useWatch<Name>` (e.g., `useWatchSessions()`), backed by a custom hook that subscribes on mount, pushes events into a React Query cache key, and unsubscribes on unmount.
- Hooks return the same `{data, error, isPending, ...}` shape across all methods.

v0.4 web client may either (a) share the file (move to `packages/shared-renderer/`) additively, or (b) duplicate. Either is fine because the abstraction shape is locked. v0.4 iOS uses native SwiftUI state; the abstraction shape concept (one hook per RPC) maps to a parallel Swift module (`SessionService.listSessions() async throws -> [Session]`). [Chapter 11](#chapter-11--monorepo-layout) §2 documents the package boundary.

#### 7. Verification harness (ship-gate (a) and (b))

- Static (gate (a)): the `lint:no-ipc` script in CI; blocks merge.
- Runtime (gate (b)): an E2E test at `packages/electron/test/e2e/sigkill-reattach.spec.ts` that:
  1. Starts daemon (in CI: in-process; in nightly: service-installed VM).
  2. Launches Electron in test mode, creates 3 sessions, waits for `RUNNING`.
  3. Records each session's last applied PTY seq AND each session's `runtime_pid` (from `Session.runtime_pid`, [Chapter 04](#chapter-04--proto-and-rpc-surface) §3 — added in v0.3 freeze precisely for this gate).
  4. SIGKILLs the Electron main PID.
  5. Verifies daemon is still up via Supervisor `/healthz`.
  6. Verifies each session's `claude` CLI subprocess is still alive by probing the recorded `runtime_pid`: on POSIX `process.kill(pid, 0)` (signal 0 tests existence without delivering a signal); on Windows `Get-Process -Id <pid>` via a `child_process.spawnSync('powershell', ...)`. Exit code 0 → alive.
  7. Relaunches Electron; waits for connect; verifies the 3 sessions appear; reattaches each; asserts `Attach` returns deltas continuing from the recorded seq (no gap, no duplicate).
- Bridge round-trip (gate (b) supplement): `packages/electron/test/rpc/bridge-roundtrip.spec.ts` exercises bridge → daemon for unary, server-stream, error, and slow-consumer cases. Closes R4 P1 transport-bridge testability.
- Descriptor immutability: `packages/electron/test/preload/descriptor-immutable.spec.ts` asserts the descriptor served via `protocol.handle` cannot be tampered with from the renderer (renderer-side mutation does not propagate; the Connect transport is constructed exactly once at boot from the original descriptor). Closes R4 P1 descriptor-tamper testability.
- Stream backoff: `packages/electron/test/rpc/reconnect-backoff.spec.ts` (per §6 above).
- Open-external URL safety: `packages/electron/test/ui/safe-open-url.spec.ts` (per §3.2).
- Big-bang rollback story: the migration PR ships a feature flag `CCSM_TRANSPORT=ipc|connect` in the Electron main process selecting between the legacy IPC stack and the Connect stack for ONE release after merge. Default flips to `connect` immediately; the `ipc` path is retained only as a fast-revert escape hatch (per [Chapter 13](#chapter-13--release-slicing) §2 phase 8 split). Removed in v0.3.1 cleanup.

#### 8. v0.4 delta

- **Add** new RPCs as needed; the renderer's clients factory automatically picks them up from regenerated proto stubs. Existing call sites: unchanged.
- **Add** new UI for v0.4 features (tunnel toggle, principal switcher) by composing additional React Query hooks against new RPCs.
- **Web/iOS clients DO NOT use the transport bridge** (§4.2): they speak `connect-web` / `connect-swift` directly to Listener B over cloudflared. The bridge is forever Electron-internal; [Chapter 15](#chapter-15--zero-rework-audit) §3 forbidden-pattern locks "v0.4 MUST NOT modify `packages/electron/src/main/transport-bridge.ts` for web/iOS reasons."
- **Unchanged**: every existing call site, the `protocol.handle` descriptor injection mechanism (§4.1), the `lint:no-ipc` rule (still gates merge in v0.4 too — chapter 08 §5h.1 is forever-stable), the error contract, the cutover-style migration philosophy (v0.4 web/iOS clients are net-new packages, not migrations), the descriptor schema (additions only in NEW top-level fields per [Chapter 03](#chapter-03--listeners-and-transport) §3.2).


---

## Chapter 09 — Crash Collector

v0.3 captures daemon-side crashes locally to SQLite, exposes them via the `CrashService` RPC, and renders them in the Electron Settings UI. There is no network upload in v0.3 (brief §10). v0.4 adds upload as an additive consumer of the same SQLite table — the capture path is forever-stable. This chapter pins the capture sources, the storage schema, the rotation policy, the surfacing path, and the v0.4 upload-additive contract.

<!-- F1: closes R0 09-P0.1 / R0 09-P0.3 / R5 P0-09-1 — owner_id pinned at v0.3 freeze with daemon-self sentinel; capture-source open-set unified across 04 / 05 / 09 / 15. -->

#### 1. Capture sources (v0.3, named — open set)

The daemon registers crash capture handlers at boot, before any RPC handler runs. The list below enumerates the v0.3 named sources but is **NOT exhaustive**: `crash_log.source` is an open string set (see [Chapter 04](#chapter-04--proto-and-rpc-surface) §5 `CrashEntry.source`) and v0.4 may add new sources additively without a proto bump or schema change. [Chapter 05](#chapter-05--session-and-principal) §5 and [Chapter 15](#chapter-15--zero-rework-audit) §3 reference this same open-set.

| Source | Hook | Severity | What is recorded | Default `owner_id` |
| --- | --- | --- | --- | --- |
| `uncaughtException` | `process.on("uncaughtException", ...)` | fatal | error message, stack, then exit(1) — service manager restarts | `daemon-self` |
| `unhandledRejection` | `process.on("unhandledRejection", ...)` | warn (v0.3) | reason, stack of `Error` if any; daemon does NOT exit (Node's default deprecation behavior is for v0.4 to revisit) | `daemon-self` |
| `claude_exit` | child `exit` event with `code != 0` | warn | exit code, signal, last 4 KiB of stderr ring buffer, session_id | session's `principalKey` |
| `claude_signal` | child `exit` with `signal` set | warn | signal name, session_id | session's `principalKey` |
| `claude_spawn` | child `error` event during `spawn` (binary missing, ENOENT, EACCES) or non-zero `exit` within 500 ms of spawn | warn | session_id, attempted argv, error code | session's `principalKey` |
| `pty_eof` | pty master `close` event when session is `RUNNING` and `should_be_running == 1` | warn | session_id, last 1 KiB of pty output | session's `principalKey` |
| `session_restore` | failure to re-spawn or replay during boot-time session restore ([Chapter 05](#chapter-05--session-and-principal) §7) | warn | session_id, restore stage, error | session's `principalKey` |
| `sqlite_open` | `new Database(path)` throws at boot | fatal | path, error code, errno | `daemon-self` |
| `sqlite_op` | any `prepare/run/all` throw | warn | sql (redacted), error code; one entry per ~60s per code-class to prevent flooding | `daemon-self` (or session principalKey if the failing query is session-scoped) |
| `worker_exit` | `worker.on("exit", code)` with `code != 0` for any pty-host worker | warn | session_id, exit code | session's `principalKey` |
| `listener_bind` | `server.listen` error event during startup step 5 | fatal | listener id, bind descriptor, errno | `daemon-self` |
| `migration` | exception during `runMigrations()` | fatal | migration version, error | `daemon-self` |
| `watchdog_miss` | systemd `WATCHDOG=1` not sent in time → daemon receives `SIGABRT` | fatal (captured by signal handler before exit) | uptime at miss | `daemon-self` |

**Source string values** in `crash_log.source` are an **open set**. The names above are the v0.3 baseline; v0.4 (and any v0.3.x patch) may add new sources freely. Clients tolerate unknown values per the [Chapter 04](#chapter-04--proto-and-rpc-surface) §5 contract. Chapters [Chapter 04](#chapter-04--proto-and-rpc-surface), [Chapter 05](#chapter-05--session-and-principal), and [Chapter 15](#chapter-15--zero-rework-audit) all reference this same open-set; any chapter that lists sources MUST disclaim exhaustiveness.

**owner_id attribution** (locks the wire field defined in [Chapter 04](#chapter-04--proto-and-rpc-surface) §5 `CrashEntry.owner_id` and the column in [Chapter 07](#chapter-07--data-and-state) §3 `crash_log.owner_id`):

- Daemon-side crashes that cannot be tied to a specific session (any `sqlite_*`, `listener_bind`, `migration`, `watchdog_miss`, top-level `uncaughtException` / `unhandledRejection`) record `owner_id = "daemon-self"`.
- Session-attributable crashes (`claude_*`, `pty_eof`, `worker_exit`, `session_restore`) record `owner_id` as the session's `principalKey` (e.g., `"local-user:1000"`).
- The sentinel `"daemon-self"` is **NOT** a valid `principalKey` — `principalKey` is always `kind:identifier` with a non-empty kind, and `daemon-self` has no colon. v0.4 cf-access principals never collide.

#### 2. Storage schema

Crash entries land in the `crash_log` SQLite table (schema in [Chapter 07](#chapter-07--data-and-state) §3). One row per crash event. ULID primary key (lexicographically time-ordered).

For fatal sources where the daemon cannot guarantee a successful SQLite write before exit (e.g., SQLite itself is the source), the daemon also appends a single line of newline-delimited JSON to the **raw crash log file** at `state/crash-raw.ndjson` (per [Chapter 07](#chapter-07--data-and-state) §2). The NDJSON line shape is forever-stable; `owner_id` is required and uses the `"daemon-self"` sentinel for daemon-side crashes:

```json
{"id":"01H...","ts_ms":1714600000000,"source":"sqlite_open","summary":"...","detail":"...","labels":{"path":"..."},"owner_id":"daemon-self"}
```

Session-attributable crashes that take the NDJSON path (rare — typically only `worker_exit` if SQLite is also down) carry the session's `principalKey` in `owner_id`. v0.4 may add principal-attributed sources additively without changing the line shape.

On next successful daemon boot, the daemon scans `crash-raw.ndjson`, imports any entries not already in `crash_log` (by id), then truncates the file. This ensures fatal events that prevented SQLite writes still surface to the user post-recovery.

#### 3. Rotation and capping

- Cap on entry count: default 10000 rows; exceeding → delete oldest by `ts_ms`.
- Cap on age: default 90 days; exceeding → delete by `ts_ms < now - 90d`.
- Both caps configurable via `Settings.crash_retention` (see [Chapter 04](#chapter-04--proto-and-rpc-surface) §6); daemon enforces hard caps `max_entries ≤ 10000`, `max_age_days ≤ 90`.
- Pruner runs at boot and every 6 hours.

#### 4. RPC surface

Defined in [Chapter 04](#chapter-04--proto-and-rpc-surface) §5:

- `CrashService.GetCrashLog(limit, since_unix_ms, owner_filter)` returns recent entries (newest first), capped at 1000 per call. Pagination implicit via `since_unix_ms` for older windows. `owner_filter` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §5) defaults to `OWNER_FILTER_OWN` and filters `crash_log` by `owner_id IN (principalKey(ctx.principal), 'daemon-self')`.
- `CrashService.WatchCrashLog(owner_filter)` server-streams new entries as they land, applying the same `owner_filter` semantics.
- `CrashService.GetRawCrashLog()` (added F6 — closes R0 09-P0.2 / R0 08-P0.1) server-streams the bytes of `state/crash-raw.ndjson` as 64 KiB chunks. Used by the "Download raw log" UI (§5 below). v0.4 web/iOS use this RPC unchanged; the renderer concatenates chunks and persists via the platform's native save mechanism (Electron: File System Access API; v0.4 web: browser save dialog; v0.4 iOS: share sheet).

In v0.3 with a single `local-user` principal, both `OWNER_FILTER_OWN` and `OWNER_FILTER_ALL` return the same effective set (the principal's session-attributable crashes plus all `daemon-self` crashes). v0.4 multi-principal makes the distinction binding: `OWNER_FILTER_ALL` is admin-only. The column, the proto field, and the filter semantics all ship in v0.3 so v0.4 enforcement is a behavior change inside an unchanged surface (see [Chapter 05](#chapter-05--session-and-principal) §5 and [Chapter 15](#chapter-15--zero-rework-audit) §3 forbidden-pattern 14).

#### 5. Settings UI surface

<!-- F6: closes R0 09-P0.2 / R5 P1-09-4 ("Open raw log file" → "Download raw log" via GetRawCrashLog); R1 P1.1 (Sentry toggle reads Settings.sentry_enabled). -->

Electron's Settings page renders:

- A table of recent crashes (newest first), columns: time, source, summary. Row click expands to show `detail` (multiline, monospace) and `labels` (key/value chips).
- A counter "X crashes in last 7 days". Clicking filters the table.
- A "Copy as JSON" button per row (renderer-only — copies the displayed payload to clipboard via `navigator.clipboard.writeText`).
- A **"Download raw log"** button that calls `CrashService.GetRawCrashLog`, concatenates the streamed `RawCrashChunk` bytes, and saves to a user-chosen path (Electron: renderer's File System Access API `window.showSaveFilePicker`; v0.4 web: same API; v0.4 iOS: share sheet). Shown unconditionally — daemon scopes the read to its own filesystem (the renderer never touches the daemon-side path). Replaces the previous "Open raw log file" affordance, which depended on `app:open-external` opening a `file://` URL — rejected by [Chapter 08](#chapter-08--electron-client-migration) §3.2's URL safety policy AND meaningless in v0.4 web/iOS.
- A **"Send to Sentry"** toggle bound to `Settings.sentry_enabled` ([Chapter 04](#chapter-04--proto-and-rpc-surface) §6). Default true (matches v0.2). When false, the Electron-side Sentry init in `packages/electron/src/sentry/init.ts` skips initialization. The daemon's local SQLite crash log (capture path in §1) is independent of this toggle and is always-on. v0.4's "Send to Anthropic" upload UI for the SQLite log will be a sibling toggle (separate boolean, separate consent flow).
- Retention controls bound to `SettingsService.UpdateSettings`.

No network upload UI for the SQLite log in v0.3. The "Send to Anthropic" button (for the daemon's SQLite log) is **not present** (not commented out, not behind a flag — it does not exist). v0.4 adds it as an additive UI element next to the Sentry toggle.

#### 6. Watchdog (linux only, v0.3)

Linux systemd unit declares `WatchdogSec=30s`. Daemon main thread emits `WATCHDOG=1` via `systemd-notify` (or equivalent direct socket write) every 10s. **Why on the main thread**: the main thread is what blocks on coalesced SQLite writes; if it hangs, the entire RPC surface is dead. Worker thread liveness is implicit (workers signal via `postMessage`; main checks last-message-age per worker every tick).

Windows / macOS lack a comparable cheap watchdog primitive; v0.3 does NOT implement one (would need a sidecar). Service managers on those platforms restart on process death only. macOS hang detection is **deferred to v0.4 hardening** (see [Chapter 14](#chapter-14--risks-and-spikes) — the `[watchdog-darwin-approach]` MUST-SPIKE is removed from the v0.3 spike registry).

##### 6.1 "Crashes since you last looked" badge

<!-- F6: closes R1 P1.2 (chapter 09) — daemon crashes after Electron exit produce no user-visible signal until the user goes looking. Surface a passive count on Settings. -->

The Settings page surfaces a passive count `crashesSinceLastSeen` on the Crash Reporting section header (e.g., "Crash Reporting · **3 new crashes**"). The count is computed by the renderer comparing `WatchCrashLog`'s emitted entries against a renderer-stored `last_seen_crash_id` (persisted via `Settings.ui_prefs["crash.last_seen_id"]`). Opening the Crash Reporting section flushes `last_seen_crash_id` to the most recent entry's id. Cheap addition; converts silent recurring daemon crashes into an in-app passive signal users notice on next launch.

#### 6.2 Capture-sources table-driven contract

<!-- F6: closes R4 P1 ch 09 — capture sources declared in a single table-driven module so spec-list and tests derive from the same source-of-truth. -->

The §1 capture-sources table is mirrored in code at `packages/daemon/src/crash/sources.ts` as an exported `const CAPTURE_SOURCES = [...] as const` array. Each entry has `{name: string, severity: 'fatal'|'warn', defaultOwnerId: 'daemon-self'|'session-principal'}`. Tests in `packages/daemon/test/crash/capture.spec.ts` iterate the array and assert one row lands per source under a synthetic-fire harness. Adding a v0.4 source means appending to `CAPTURE_SOURCES`; the test grows automatically. Rate-limiting on the `sqlite_op` source ("one entry per ~60s per code-class to prevent flooding") is exercised by `packages/daemon/test/crash/rate-limit.spec.ts`. Linux watchdog `WATCHDOG=1` keepalive (§6) is exercised by `packages/daemon/test/integration/watchdog-linux.spec.ts` running daemon under a simulated systemd (set `NOTIFY_SOCKET` env, listen on a UDS, assert `WATCHDOG=1` arrives every 10±2s for 60s). Crash-raw recovery silent-loss failure modes are exercised by `packages/daemon/test/crash/crash-raw-recovery.spec.ts` covering: (a) partial line at end of file, (b) file missing, (c) file present but empty, (d) malformed entries (non-JSON, missing fields), (e) truncation race (daemon killed during truncate). All five cases must complete without losing already-imported entries.

> **REMOVED (deferred to v0.4 hardening)**: the previous `[watchdog-darwin-approach]` MUST-SPIKE has been removed from the v0.3 spike registry per dispatch plan §2 F11. macOS hang detection is a v0.4 hardening item.

#### 7. v0.4 delta

- **Use** existing `crash_log.owner_id` column (already `NOT NULL` from v0.3 with `'daemon-self'` sentinel — see [Chapter 07](#chapter-07--data-and-state) §3) — v0.4 starts populating attributable principalKeys for cf-access sessions; no schema change.
- **Add** `crash_log.uploaded_at INTEGER NULL` column for upload tracking. Existing rows valid (NULL = never uploaded).
- **Add** `CrashService.UploadCrashLog(...)` RPC (or a separate `CrashUploadService`) — additive RPC.
- **Add** "Send to Anthropic" UI in Settings; toggleable; defaults off.
- **Add** Windows / macOS watchdog implementations as additive sidecars or in-process timers.
- **Add** new capture sources additively (the v0.3 list in §1 is explicitly an open set, not exhaustive).
- **Unchanged**: `crash_log.owner_id` column shape, `OwnerFilter` enum semantics in `GetCrashLog` / `WatchCrashLog`, NDJSON line shape (including `owner_id` field with `"daemon-self"` sentinel), `crash_log` baseline schema, `crash-raw.ndjson` import-on-boot recovery, RPC names and signatures listed in §4, Settings UI table layout (v0.4 adds rows / buttons but does not reshape).


---

## Chapter 10 — Build, Package, Installer

The daemon ships as a single executable per OS via Node 22 sea (Single Executable Applications, GA in Node 22) with native modules (`node-pty`, `better-sqlite3`, `xterm-headless`'s C++-free deps, `@connectrpc/connect-node`) embedded or sidecar-loaded. The Electron app ships per-OS as the standard Electron bundle. Each OS has its own installer (MSI / pkg / deb + rpm) that registers the daemon as a system service, places binaries, creates state directories, and verifies via Supervisor `/healthz` before declaring success. Uninstall reverses every step — ship-gate (d) tests this on a fresh Win 11 25H2 VM round-trip. This chapter pins the build pipeline, the native-module strategy, the per-OS installer responsibilities, and the verification harness.

#### 1. Daemon binary: Node 22 sea

Build command per OS:

```bash
# packages/daemon/scripts/build-sea.sh (mac/linux) and .ps1 (win)
node --experimental-sea-config sea-config.json
node -e "require('fs').copyFileSync(process.execPath,'dist/ccsm-daemon')"
npx postject dist/ccsm-daemon NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
codesign / signtool / debsign as appropriate
```

`sea-config.json` includes:
- `main: "dist/bundle.js"` — esbuild-produced single-file CJS bundle of all daemon source + npm deps that ARE pure-JS.
- `disableExperimentalSEAWarning: true`
- `useCodeCache: true`
- `useSnapshot: false` (snapshot complicates native module init; revisit in v0.4 if startup is too slow).

> **MUST-SPIKE [sea-on-22-three-os]**: hypothesis: `node --experimental-sea-config` + `postject` produces a working single binary on Win 11 25H2, macOS 14 (arm64 + x64), Ubuntu 22.04. · validation: build a minimal "hello world" daemon that opens Listener A, runs `Hello` RPC, exits cleanly. Run on each target. · fallback: switch to `pkg` (Vercel) — note `pkg` is in maintenance mode and Node 22 support is unofficial; second fallback is a plain `node + bundle.js + node_modules/` zip with a launcher script (loses single-file but ships).

#### 2. Native module strategy

Node sea cannot embed `.node` binaries inside the blob. Strategy: ship native `.node` files **alongside** the executable in the install directory; resolve via an absolute path computed from `process.execPath`.

```ts
// packages/daemon/src/native-loader.ts
import path from "node:path";
import { createRequire } from "node:module";
const here = path.dirname(process.execPath);
const requireNative = createRequire(path.join(here, "native/"));
export const Database = requireNative("./better_sqlite3.node");
export const pty = requireNative("./pty.node");
```

Per-OS native bundle layout:

```
<install-dir>/
  ccsm-daemon(.exe)            # the sea binary
  native/
    better_sqlite3.node        # built for the target OS+arch+Node-ABI
    pty.node                   # node-pty
```

Build matrix: `{win-x64, win-arm64, darwin-x64, darwin-arm64, linux-x64, linux-arm64} × {Node 22 ABI}`. Cross-compile native modules in CI using `prebuildify` or vendor's prebuilt artifacts when available.

> **MUST-SPIKE [node-pty-22]**: hypothesis: `node-pty` builds against Node 22 ABI on all six matrix combos. · validation: prebuildify in CI; smoke-spawn `bash` / `cmd.exe` and read 1 KB. · fallback: pin to Node 22 LTS minor with known-good prebuilds; if a target is broken, ship a `child_process` fallback for that OS only with a feature flag — would weaken ship-gate (c) on that OS — escalate to user.

> **MUST-SPIKE [better-sqlite3-22-arm64]**: hypothesis: `better-sqlite3` prebuilds exist for Node 22 ABI on darwin-arm64 and linux-arm64. · validation: install in CI matrix, open `:memory:`, run a CREATE+INSERT+SELECT. · fallback: build from source in CI per target.

#### 3. Code signing

| OS | Signing | Notarization |
| --- | --- | --- |
| Windows | `signtool sign /fd SHA256 /tr <RFC3161-TSA> /td SHA256` with EV cert | n/a |
| macOS | `codesign --sign "Developer ID Application: ..." --options runtime --timestamp` | `xcrun notarytool submit --wait`; staple |
| Linux | `debsigs` for .deb; `rpm --addsign` for .rpm; detached `.sig` for raw binary | n/a |

Both the daemon binary AND the native `.node` files are signed. Installer is signed.

> **MUST-SPIKE [macos-notarization-sea]**: hypothesis: a Node sea binary passes Apple notarization with hardened runtime + entitlements `com.apple.security.cs.allow-jit` (Node uses V8 JIT). · validation: notarize a hello-world sea; check stapler. · fallback: revert to a notarized .app bundle wrapping a non-sea `node + bundle.js + node_modules/`.
>
> **Pre-resolution (R5 P0-10-1)**: this spike MUST be resolved in phase 0 (see [Chapter 13](#chapter-13--release-slicing)) BEFORE stage-6 (release packaging). If notarization is rejected, the fallback (.app-wrapped bundle) ships, and the §1 sea pipeline downgrades for macOS only — §1 continues to apply for Win + Linux unchanged; §2 native-loading mechanism is unchanged because the .app bundle still loads `.node` files via `createRequire(process.execPath/..)`; §6 build matrix swaps `build-daemon-mac` output from `ccsm-daemon` (sea binary) to `Ccsm.app/Contents/MacOS/ccsm-daemon` (`node` interpreter + `bundle.js` + `node_modules/`); §5.2 pkg installer payload becomes the `.app` bundle rather than the bare binary. Document the fallback decision in the v0.3 release notes.

#### 4. Electron build

Standard `electron-builder` per OS. Outputs:
- Windows: NSIS or MSIX (we pick **MSI via electron-builder + custom action** because MSI is what enterprise IT can deploy via GPO; NSIS is fine for non-managed; v0.3 ships MSI as primary).
- macOS: `.app` inside a `.dmg`, signed + notarized.
- Linux: `.deb` and `.rpm` (and an `AppImage` for distros we don't first-class).

Electron does NOT bundle native modules at runtime in v0.3 (no `node-pty` in renderer; no `better-sqlite3`); it is purely UI + Connect client. This dramatically simplifies the Electron build (no `electron-rebuild` step, no per-Electron-version ABI rebuilds).

#### 5. Per-OS installer responsibilities

Installer responsibilities common to all OSes:
1. Place `ccsm-daemon` binary + `native/` directory.
2. Place Electron app bundle.
3. Create state directory with correct ownership (per [Chapter 07](#chapter-07--data-and-state) §2) and ACL.
4. Create per-OS service account if needed (`_ccsm` mac, `ccsm` linux; LocalService is built-in on win).
5. Register the daemon as a system service.
6. Start the service.
7. Wait up to 10 s for `GET /healthz` on Supervisor UDS to return 200. **Failure mode**: if `/healthz` does not return 200 within the 10 s budget, the installer (a) captures the last 200 lines of the daemon's stdout/stderr (per-OS service-manager log: `journalctl -u ccsm-daemon -n 200`, `log show --predicate 'subsystem == "com.ccsm.daemon"' --last 1m`, Win Event Viewer `Get-WinEvent -LogName Application -ProviderName ccsm-daemon -MaxEvents 200`) into the installer log, (b) attempts service stop, (c) marks the install as failed and returns a non-zero exit / MSI error code (Win: `ERROR_INSTALL_FAILURE` 1603) so MSI rolls back atomic file placement, (d) leaves the state directory intact (no destructive cleanup on first-install failure — a re-attempt should succeed without data loss). Tested by `tools/installer-roundtrip.{ps1,sh}` `--inject-healthz-fail` variant: the test pre-stages a daemon binary that exits non-zero on startup, runs the installer, asserts non-zero exit, asserts service unregistered, asserts state dir untouched.
8. Add Electron to Start menu / `/Applications` / `.desktop` entry.
9. Register an uninstaller entry.

Common to all uninstallers:
1. Stop the service (wait up to 10 s for clean exit).
2. Unregister the service.
3. Remove the binary, native dir, Electron bundle, Start menu / launcher entries.
4. Prompt user "remove user data?" (default no). For unattended / silent installs (Windows MSI: `msiexec /x ... /qn`; mac/linux: scripted), the prompt is suppressed and the decision is taken from the public MSI property `REMOVEUSERDATA` (`0` = keep — default; `1` = remove). On mac/linux, the equivalent is the env var `CCSM_REMOVE_USER_DATA=1` consumed by the uninstaller script. Ship-gate (d) exercises BOTH variants (interactive + silent with `REMOVEUSERDATA=1` and silent with `REMOVEUSERDATA=0`).
5. If yes: remove state directory.
6. Remove the uninstaller entry.

Specifics:

##### 5.1 Windows MSI

- Tool: WiX 4 (driven by electron-builder's MSI builder OR a hand-written WiX project; pick by which is more reliable for service registration — MUST-SPIKE `[msi-tooling-pick]`, see [Chapter 14](#chapter-14--risks-and-spikes)).
- Service registration: WiX `<ServiceInstall>` element (NOT a `sc.exe` custom action — declarative is cleaner for uninstall). This is the locked decision for v0.3; the contradiction in some earlier text mentioning `node-windows` / `sc.exe` as alternatives is resolved here in favor of WiX `<ServiceInstall>`. **NOTE for chapter 02**: chapter 02's service-management text MUST align with this choice (cross-fixer F4 to update). The MSI also configures service failure actions (verified post-install via `sc qfailure ccsm-daemon` — restart on first/second failure, run-program on third) and a per-service SID type (verified via `sc qsidtype ccsm-daemon` returning `RESTRICTED` or `UNRESTRICTED` per the WiX `<ServiceConfig>` element); the `MUST-SPIKE [msi-service-install-25h2]` fallback path (PowerShell `New-Service`) is exercised by the same ship-gate (d) test path with a feature flag in the installer (CI variant `ccsm-setup-*-fallback.msi`).
- ACLs on `%PROGRAMDATA%\ccsm\`: grant LocalService Modify; grant interactive user Read on the listener descriptor file.
- Registry: minimal — just the standard MSI `Uninstall` key. No app-specific keys.
- Uninstall verification (ship-gate (d)): script asserts none of the following exist after uninstall:
  - `%ProgramFiles%\ccsm\`
  - `%ProgramData%\ccsm\` (if user opted to remove)
  - Service `ccsm-daemon` in `sc query`
  - Scheduled tasks named `ccsm*`
  - Registry `HKLM\SYSTEM\CurrentControlSet\Services\ccsm-daemon`
  - `Uninstall` registry entry for the product

##### 5.2 macOS pkg

- Tool: `pkgbuild` + `productbuild`, signed with Developer ID Installer cert, notarized.
- LaunchDaemon plist installed to `/Library/LaunchDaemons/com.ccsm.daemon.plist`.
- Postinstall script: `launchctl bootstrap system /Library/LaunchDaemons/com.ccsm.daemon.plist; launchctl enable system/com.ccsm.daemon; launchctl kickstart -k system/com.ccsm.daemon`.
- Uninstaller: a separate `ccsm-uninstall.command` script in `/Library/Application Support/ccsm/`. Round-trip tested by `tools/installer-roundtrip.sh` (mac variant): install pkg → assert `launchctl print system/com.ccsm.daemon` shows running → run `ccsm-uninstall.command` (with `CCSM_REMOVE_USER_DATA=1` and again with `=0`) → assert plist absent + binary absent + (data dir absent or present per flag).

##### 5.3 Linux deb + rpm

- Build with `fpm` driven from `packages/daemon/scripts/build-pkg.sh`.
- Postinst: create `ccsm` user, install `ccsm-daemon.service`, `systemctl daemon-reload && systemctl enable --now ccsm-daemon`.
- Postrm: `systemctl disable --now ccsm-daemon; userdel ccsm` (purge mode only).

> **MUST-SPIKE [msi-service-install-25h2]**: hypothesis: WiX 4 `<ServiceInstall>` for a sea binary works on Win 11 25H2 with proper SDDL. · validation: build MSI, install on clean 25H2 VM, verify `Get-Service ccsm-daemon` shows Running. · fallback: PowerShell `New-Service` from a custom action with SDDL programmatically applied.

#### 6. Cross-OS build matrix (CI)

| Job | OS | Arch | Node | Output |
| --- | --- | --- | --- | --- |
| `build-daemon-win` | windows-latest | x64, arm64 | 22 | `ccsm-daemon.exe` + native/ |
| `build-daemon-mac` | macos-14 | x64, arm64 (universal2) | 22 | `ccsm-daemon` + native/ |
| `build-daemon-linux` | ubuntu-22.04 | x64, arm64 | 22 | `ccsm-daemon` + native/ |
| `build-electron-*` | matching OS | matching arch | 22 | electron bundle |
| `package-win-msi` | windows-latest | matching | n/a | `ccsm-setup-x.y.z-x64.msi` |
| `package-mac-pkg` | macos-14 | matching | n/a | `ccsm-x.y.z.pkg` |
| `package-linux-deb` / `-rpm` | ubuntu-22.04 | matching | n/a | `.deb` / `.rpm` |
| `e2e-win-installer-vm` | self-hosted Win 11 25H2 | x64 | n/a | ship-gate (d) result |

**Self-hosted Win 11 25H2 runner provisioning (R4 P0 ship-gate (d))**: provisioning is descoped from this chapter. v0.3 ships against an operator-provisioned self-hosted runner; the snapshot-restore mechanism, base image build, and network configuration live in a separate `infra/win11-runner/` repo. The runner registers under the GitHub Actions label `self-hosted-win11-25h2-vm` referenced in the matrix above and in [Chapter 11](#chapter-11--monorepo-layout) §6. If the runner is unavailable on a release candidate, ship-gate (d) is run manually on the operator's Win 11 25H2 device and the result is posted to release notes (see [Chapter 12](#chapter-12--testing-strategy) and brief §11(d) clarification).

**Cross-arch (arm64) native smoke**: `build-daemon-{win,mac,linux}` arm64 jobs cross-compile native modules via `prebuildify`. Smoke testing on real arm64 hardware: `darwin-arm64` is smoke-tested on the macos-14 runner (which is arm64-native — Apple silicon). `linux-arm64` and `win-arm64` are cross-built only in v0.3 CI; smoke testing on real arm64 hardware (Raspberry Pi 4 / Surface Pro X) is performed manually pre-tag and the result posted to release notes — automation is deferred to v0.4 once a self-hosted arm64 runner exists. The `tools/sea-smoke/` script (see §7 below) is reused for the manual arm64 smoke step.

**Installer e2e in CI scope**: v0.3 CI runs the full installer e2e (ship-gate (d)) only on Windows (see `e2e-win-installer-vm` above). macOS pkg and Linux deb/rpm installers are smoke-tested manually pre-tag using `tools/installer-roundtrip.sh` against an operator workstation; results are posted to release notes (matches brief §11(d)). v0.4 expands installer e2e coverage to mac + linux self-hosted runners.

#### 7. Verification harness scripts

Two scripts close the per-OS sea binary smoke + signing verification gaps (R4 P0).

**`tools/sea-smoke/`** — invoked at the end of each `e2e-installer-{win,mac,linux}` job AFTER the installer has placed the daemon and registered the service. Steps (one shell variant + one PowerShell variant share the same step list):

1. Start the OS service (or reuse the installer-started service): `systemctl start ccsm-daemon` / `launchctl kickstart system/com.ccsm.daemon` / `Start-Service ccsm-daemon`.
2. Poll Supervisor `/healthz` (per-OS UDS path from [Chapter 02](#chapter-02--process-topology) §2) for HTTP 200 within 10 s; fail otherwise.
3. Open Listener A via descriptor (per [Chapter 03](#chapter-03--listeners-and-transport) §1) and call `Hello` RPC; assert `proto_version` matches expected.
4. Call `SessionService.CreateSession({ command: "echo ok" })`; assert returned `Session.id` non-empty.
5. Subscribe to `PtyService.Attach({ session_id })` stream and assert at least one delta arrives within 5 s containing the literal bytes `ok`.
6. Stop the daemon: `systemctl stop ccsm-daemon` / `launchctl bootout system/com.ccsm.daemon` / `Stop-Service ccsm-daemon`; assert process exits within 5 s.
7. Exit non-zero on any step failure; capture per-OS service-manager log on failure (same capture rule as §5 step 7).

This script runs the actual built `ccsm-daemon` binary placed by the real installer, not a dev-mode `node bundle.js` invocation — that is the entire point. The script is reused by the manual mac/linux pre-tag installer smoke (see §6 above) and by the manual arm64 smoke step.

**`tools/verify-signing.{sh,ps1}`** — invoked in each `package-{win-msi,mac-pkg,linux-deb,linux-rpm}` job AFTER signing and BEFORE artifact upload. Per-OS commands:

- Windows (`verify-signing.ps1`): for each of `ccsm-daemon.exe`, `native\*.node`, and `ccsm-setup-*.msi`, run `Get-AuthenticodeSignature <path>` and assert `.Status -eq 'Valid'` AND `.SignerCertificate.Subject -match 'CN=<expected EV CN>'` AND `.TimeStamperCertificate -ne $null`. Fail the job if any path is `NotSigned` / `HashMismatch` / `UnknownError`.
- macOS (`verify-signing.sh` mac branch): for each of `ccsm-daemon`, every `*.node` under `native/`, the `.app` bundle (if fallback path is taken — see §1), and the `.pkg`, run `codesign --verify --deep --strict --verbose=4 <path>` AND `spctl --assess --type install --verbose <path>` (or `--type execute` for the bare binary). Assert exit zero and that the output contains `accepted` / `valid on disk`.
- Linux (`verify-signing.sh` linux branch): for the `.deb`, run `dpkg-sig --verify <path>` and assert `GOODSIG`; for the `.rpm`, run `rpm --checksig -v <path>` and assert `(sha256) Header SHA256 digest: OK` and `Header V4 RSA/SHA256 Signature, key ID ...: OK`; for the bare binary, verify the detached `.sig` via `gpg --verify ccsm-daemon.sig ccsm-daemon`.

Both scripts are committed in the repo root `tools/` directory (see [Chapter 11](#chapter-11--monorepo-layout) §2 directory layout — addition).

#### 8. Update flow (R2 P0-10-1)

v0.3 ships a minimal in-place update flow invoked by a future updater (out of scope for v0.3 ship — the flow is specified now so v0.3.x patch releases CAN ship without re-architecture). The flow operates on an already-downloaded, already-signature-verified replacement binary at a staging path (the updater is responsible for download + signature verification using `tools/verify-signing.*` from §7). Flow:

1. **Stop service**: `Stop-Service ccsm-daemon` / `launchctl bootout system/com.ccsm.daemon` / `systemctl stop ccsm-daemon` with a 10 s timeout. If the service has not exited within 10 s, escalate: Win `Stop-Service -Force` → if still running after 5 s, `taskkill /F /PID <pid>`; mac `launchctl kill SIGKILL system/com.ccsm.daemon`; linux `systemctl kill --signal=SIGKILL ccsm-daemon`. Verify via `Get-Process` / `pgrep` that the PID is gone before proceeding.
2. **Replace binary**: rename existing `ccsm-daemon(.exe)` to `ccsm-daemon.prev(.exe)` (atomic on all three OSes when source + dest are on the same volume; installers MUST place binaries on the same volume as state); move staging binary into place; preserve native/ directory ACLs (do NOT replace `native/` unless the staging payload includes a new `native/`; in that case, atomically rename `native/` → `native.prev/` and stage `native/`).
3. **Restart service**: `Start-Service` / `launchctl bootstrap system /Library/LaunchDaemons/com.ccsm.daemon.plist` / `systemctl start ccsm-daemon`.
4. **Health check + rollback**: poll Supervisor `/healthz` for HTTP 200 within 10 s. If 200: delete `ccsm-daemon.prev(.exe)` and `native.prev/` (if staged); update succeeded. If timeout: rollback — stop the failing service (with the same 10 s + SIGKILL escalation as step 1), atomically rename `ccsm-daemon.prev(.exe)` → `ccsm-daemon(.exe)` and `native.prev/` → `native/`, restart service, poll `/healthz` again, log a `crash_log` entry with source `update_rollback` (regardless of whether the rollback healthz succeeds, so the user sees the failure surfaced via [Chapter 09](#chapter-09--crash-collector)). The user-facing updater UX surfaces both update-success and update-rollback states.

This flow is the same on all three OSes modulo the per-OS commands. It is exercised by `tools/update-flow.spec.{ps1,sh}` invoked in a manual pre-release smoke (not in per-PR CI for v0.3; promoted to CI in v0.4). The `tools/verify-signing.*` script (§7) is the upstream integrity gate; this flow trusts that the staging binary is already verified.

#### 9. v0.4 delta

- **Add** cloudflared binary to the daemon install (download in postinst or vendor in installer; pick MUST-SPIKE later).
- **Add** new Electron features wrapped in same installer; no new installer technology.
- **Add** new sea-config entries if v0.4 adds new pure-JS deps.
- **Unchanged**: sea pipeline, native loading mechanism, signing/notarization steps, per-OS installer technology choices, ship-gate (d) verification approach, the install/uninstall step lists.


---

## Chapter 11 — Monorepo Layout

v0.3 ships a monorepo with three packages: `packages/daemon`, `packages/electron`, `packages/proto`. v0.4 will add `packages/web` and `packages/ios` as additive packages (brief §8). Tooling must support shared proto codegen, independent build/test per package, and cross-package CI orchestration. This chapter pins the workspace tool choice (with justification), the directory layout, the codegen pipeline, the per-package CI matrix, and the additive-package contract for v0.4.

#### 1. Workspace tool: pnpm workspaces + Turborepo

**Decision**: pnpm workspaces for dependency management; Turborepo for task orchestration / caching.

| Candidate | Verdict | Why |
| --- | --- | --- |
| npm workspaces (alone) | rejected | no built-in task graph / caching; CI would re-run everything per PR |
| yarn workspaces | rejected | yarn is in flux (berry split); not worth the migration risk |
| pnpm workspaces (alone) | partial | great deps; we still need a task runner |
| Turborepo | accepted as task layer | mature, simple `turbo.json`, free for OSS, content-addressable cache works locally and in CI |
| Nx | rejected | overkill (heavy plugin ecosystem we don't need); harder to onboard; we are not building 50 packages |
| **pnpm workspaces + Turborepo** | **accepted** | pnpm: strict dep isolation, fast install, CI-cache-friendly `pnpm-lock.yaml`. Turborepo: per-task hash-based caching → only changed packages rebuild. |

**Why not just one tool**: pnpm doesn't do task graphs; Turborepo doesn't do dep resolution. The two are designed to coexist (Turborepo's docs first-class pnpm).

#### 2. Directory layout

```
ccsm/                                # repo root
├── package.json                     # private; "workspaces": [...] handled by pnpm-workspace.yaml
├── pnpm-workspace.yaml
├── pnpm-lock.yaml                   # committed
├── turbo.json
├── tsconfig.base.json               # shared TS config; packages extend
├── .github/workflows/               # CI — see §6
├── docs/superpowers/specs/...       # this spec; not a package
├── packages/
│   ├── proto/
│   │   ├── package.json             # name: "@ccsm/proto"
│   │   ├── src/ccsm/v1/*.proto      # proto sources; `buf.yaml` declares `modules.path: src`
│   │   ├── buf.yaml
│   │   ├── buf.gen.yaml
│   │   ├── gen/                     # generated code; gitignored; built by `pnpm run gen`
│   │   │   ├── ts/                  # protoc-gen-es output (messages + GenService descriptors)
│   │   │   ├── go/                  # for v0.4 (placeholder dir; empty in v0.3)
│   │   │   └── swift/               # for v0.4
│   │   └── scripts/lock-buf-image.sh
│   ├── daemon/
│   │   ├── package.json             # name: "@ccsm/daemon"
│   │   ├── tsconfig.json            # extends ../../tsconfig.base.json
│   │   ├── src/
│   │   │   ├── index.ts             # entrypoint -> bundle.js -> sea
│   │   │   ├── listeners/           # chapter 03
│   │   │   ├── rpc/                 # handlers; consumes `@ccsm/proto` (re-exports `gen/ts/**`)
│   │   │   ├── pty/                 # chapter 06
│   │   │   ├── db/                  # chapter 07
│   │   │   ├── crash/               # chapter 09
│   │   │   ├── service/             # OS service entrypoint glue
│   │   │   └── native-loader.ts     # chapter 10 §2
│   │   ├── scripts/build-sea.{sh,ps1}
│   │   ├── test/{unit,integration,e2e}/
│   │   └── dist/                    # gitignored
│   └── electron/
│       ├── package.json             # name: "@ccsm/electron"
│       ├── tsconfig.json
│       ├── src/
│       │   ├── main/                # minimal; chapter 08 §4
│       │   ├── preload/             # 5 lines; chapter 08 §4
│       │   └── renderer/            # React app; consumes `@ccsm/proto` (re-exports `gen/ts/**`)
│       ├── electron-builder.yml
│       ├── test/{unit,e2e}/
│       └── dist/
└── tools/
    ├── lint-no-ipc.sh               # chapter 08 §5h
    ├── sea-smoke/                   # chapter 10 §7 — per-OS installed-daemon smoke
    │   ├── run.sh
    │   └── run.ps1
    ├── verify-signing.sh            # chapter 10 §7 — mac + linux signing verifier
    ├── verify-signing.ps1           # chapter 10 §7 — Windows Authenticode verifier
    ├── installer-roundtrip.sh       # chapter 10 §5.2 / §5.3 mac+linux install→uninstall
    ├── installer-roundtrip.ps1      # chapter 10 §5.1 Win MSI install→uninstall (ship-gate (d))
    └── update-flow.spec.sh          # chapter 10 §8 update-flow smoke (mac/linux; .ps1 sibling for win)
```

**Why `gen/` per package and gitignored**: generated proto code re-deriving from `.proto` is fast and deterministic; committing it would invite drift. CI runs `pnpm run gen` before any other task.

**Why empty `gen/go/` and `gen/swift/` directories now**: nothing — the v0.3 `buf.gen.yaml` simply does not list go/swift outputs. v0.4 adds the outputs to `buf.gen.yaml`; no directory restructure. The directory comment block in the README explains the v0.4 plan to readers.

#### 3. Workspace dep graph (v0.3)

```
@ccsm/proto    (no internal deps)
   ▲
   │
   ├── @ccsm/daemon
   └── @ccsm/electron
```

`@ccsm/daemon` and `@ccsm/electron` both depend on `@ccsm/proto`'s generated TS code via a workspace-protocol dep:

```jsonc
// packages/daemon/package.json
"dependencies": {
  "@ccsm/proto": "workspace:*"
}
```

pnpm symlinks `node_modules/@ccsm/proto` to `packages/proto`, which re-exports its generated `gen/ts/**` modules through `packages/proto/src/index.ts`; the `package.json` `"exports"` field points at that re-export so consumers can `import { SessionService } from '@ccsm/proto'` without reaching into the `gen/ts` path directly.

#### 4. Proto codegen pipeline

```
packages/proto/buf.gen.yaml
---
version: v2
plugins:
  # protoc-gen-es v2 generates both message types AND service descriptors
  # (`GenService<...>` constants). Connect-RPC consumes those descriptors
  # directly via `@connectrpc/connect` — no separate `connect-es` plugin
  # is needed (the v1 `connectrpc/es` plugin was deprecated by upstream
  # in favor of `protoc-gen-es` ≥ v2 emitting GenService).
  - local: protoc-gen-es
    out: gen/ts
    opt:
      - target=ts
      - import_extension=js
# v0.4 will append:
#  - remote: buf.build/connectrpc/go:v1.x
#    out: gen/go
#  - remote: buf.build/connectrpc/swift:v1.x
#    out: gen/swift
```

Codegen is invoked via `pnpm --filter @ccsm/proto run gen` which Turborepo treats as a prerequisite of `build` for all consumers (declared in `turbo.json`):

```json
{
  "tasks": {
    "build": { "dependsOn": ["^build", "@ccsm/proto#gen"], "outputs": ["dist/**", "gen/**"] },
    "gen":   { "outputs": ["gen/**"] },
    "test":  { "dependsOn": ["build"] },
    "lint":  {}
  }
}
```

Declaring `@ccsm/proto#gen` as a `build` dep (in addition to `^build`) ensures local-dev bootstrap works without manual `pnpm --filter @ccsm/proto run gen` — a fresh clone + `pnpm install && pnpm build` produces working generated code before any consumer compiles. `gen` is included in `outputs` of `build` so Turborepo cache-restores generated code along with `dist/`.

A `buf breaking` job runs in CI on every PR **from phase 1 onward** (not deferred until v0.3 ships). Pre-tag, the comparison target is the PR's merge-base SHA on the working branch (any in-flight `.proto` shift MUST be intentional and reviewed); post-tag, the comparison target is the v0.3 release tag (see [Chapter 04](#chapter-04--proto-and-rpc-surface) §7 / §8 and [Chapter 13](#chapter-13--release-slicing) §2 phase 1). In addition, every `.proto` file's SHA256 is recorded in `packages/proto/lock.json` (committed). CI runs a `proto-lock-check` step that recomputes SHA256 over each `.proto` file and rejects any PR that touches a `.proto` file without bumping the matching SHA in `lock.json`. The bump is mechanical: `pnpm --filter @ccsm/proto run lock` regenerates `lock.json` and the PR author commits the result.

#### 5. Per-package responsibilities

| Package | Owns | Forbidden |
| --- | --- | --- |
| `@ccsm/proto` | `.proto` files, `buf.gen.yaml`, generated code as build output | importing from any other package; ANY runtime logic |
| `@ccsm/daemon` | every line of daemon code; native module bundling | importing from `@ccsm/electron`; rendering UI |
| `@ccsm/electron` | every line of UI code; transport construction; React Query hooks | importing from `@ccsm/daemon`; spawning subprocesses; opening SQLite; native modules other than what Electron itself loads |

The "forbidden" column is enforced by ESLint's `no-restricted-imports` rule wired into each package's eslint config; CI lint catches violations.

The rule body, inline (each `packages/*/eslint.config.js` extends the root and adds package-specific patterns):

```js
// packages/electron/eslint.config.js (forbid daemon imports)
export default [
  {
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@ccsm/daemon", "@ccsm/daemon/*"], message: "@ccsm/electron MUST NOT import from @ccsm/daemon (chapter 11 §5)." },
          { group: ["node-pty", "better-sqlite3"], message: "Native modules belong in @ccsm/daemon, not the renderer/main (chapter 11 §5)." }
        ],
        paths: [
          { name: "electron", importNames: ["ipcMain", "ipcRenderer", "contextBridge"], message: "Forbidden by ship-gate (a) — see chapter 12 §1 / chapter 08 §5h. The lone exception is the descriptor preload, allow-listed via tools/lint-no-ipc.sh." }
        ]
      }]
    }
  }
];

// packages/daemon/eslint.config.js (forbid electron imports + UI)
export default [
  {
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@ccsm/electron", "@ccsm/electron/*"], message: "@ccsm/daemon MUST NOT import from @ccsm/electron (chapter 11 §5)." },
          { group: ["electron", "electron/*", "react", "react-dom"], message: "@ccsm/daemon is headless — UI deps forbidden (chapter 11 §5)." }
        ]
      }]
    }
  }
];

// packages/proto/eslint.config.js (forbid all internal imports + runtime)
export default [
  {
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@ccsm/*"], message: "@ccsm/proto MUST NOT import from any other package (chapter 11 §5)." }
        ]
      }]
    }
  }
];
```

#### 6. CI matrix (GitHub Actions)

```yaml
# .github/workflows/ci.yml (sketch)
on:
  pull_request:
  push:
    branches: [main, working]
    tags: ['v*']
  schedule:
    - cron: '0 7 * * *'   # 07:00 UTC daily — drives [soak] + [installer] nightly variants below

jobs:
  install:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - uses: actions/cache@v4
        with:
          # Turborepo cache key: lockfile + turbo config + every .proto file (codegen affects every consumer)
          path: .turbo
          key: turbo-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml','turbo.json','packages/proto/**/*.proto','packages/proto/lock.json') }}
          restore-keys: |
            turbo-${{ runner.os }}-
      - uses: actions/upload-artifact@v4
        with:
          # share node_modules + .turbo with downstream jobs to avoid re-installing
          name: install-cache
          path: |
            node_modules
            packages/*/node_modules
            .turbo
          retention-days: 1

  proto-gen-and-lint:
    needs: install
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: install-cache }
      - run: pnpm --filter @ccsm/proto run gen
      - run: pnpm --filter @ccsm/proto run lint   # buf lint
      - run: pnpm --filter @ccsm/proto run lock-check   # SHA256 per .proto MUST match lock.json (rejects .proto touch without lock bump)
      - run: pnpm --filter @ccsm/proto run breaking     # buf breaking; pre-tag: against merge-base SHA; post-tag: against v0.3 tag (active from phase 1)
      - run: pnpm --filter @ccsm/proto run version-drift-check   # daemon's PROTO_VERSION constant >= last release's PROTO_VERSION (see §7)

  daemon-test:
    needs: proto-gen-and-lint
    strategy:
      matrix: { os: [ubuntu-22.04, macos-14, windows-latest] }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: install-cache }
      - run: pnpm --filter @ccsm/daemon run build
      - run: pnpm --filter @ccsm/daemon run test:unit
      - run: pnpm --filter @ccsm/daemon run test:integration

  electron-test:
    needs: proto-gen-and-lint
    strategy:
      matrix: { os: [ubuntu-22.04, macos-14, windows-latest] }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: install-cache }
      - run: pnpm --filter @ccsm/electron run build
      - run: pnpm --filter @ccsm/electron run test:unit
      - run: pnpm --filter @ccsm/electron run lint:no-ipc   # ship-gate (a)

  package:
    needs: [daemon-test, electron-test]
    strategy:
      matrix:
        include:
          - { os: windows-latest, target: win-msi }
          - { os: macos-14, target: mac-pkg }
          - { os: ubuntu-22.04, target: linux-deb-rpm }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: install-cache }
      - run: pnpm run package:${{ matrix.target }}
      - run: bash tools/verify-signing.sh    # chapter 10 §7 (mac/linux); pwsh tools/verify-signing.ps1 on win
        if: matrix.os != 'windows-latest'
      - run: pwsh tools/verify-signing.ps1
        if: matrix.os == 'windows-latest'

  e2e-soak-1h:
    needs: package
    runs-on: [self-hosted, ccsm-soak]   # label provisioned in infra repo; 1 hour budget
    if: github.event_name == 'schedule' || contains(github.event.head_commit.message, '[soak]')
    steps:
      - run: pnpm run test:pty-soak   # ship-gate (c)

  e2e-installer-win:
    needs: package
    runs-on: [self-hosted, win11-25h2-vm]   # label = self-hosted-win11-25h2-vm; provisioning in infra/win11-runner/ (chapter 10 §6)
    if: github.event_name == 'schedule' || contains(github.event.head_commit.message, '[installer]')
    steps:
      - run: pwsh tools/installer-roundtrip.ps1   # ship-gate (d); invokes tools/sea-smoke/run.ps1 internally
```

Notes on the sketch:

- `install-cache` artifact share: every downstream job downloads the `node_modules` + `.turbo` artifact rather than re-running `pnpm install` per matrix cell — saves ~2 min per leaf job at the cost of one upload. Retention is 1 day because it is cheap to regenerate.
- Turborepo cache key uses `pnpm-lock.yaml` + `turbo.json` + every `.proto` file + `packages/proto/lock.json`. `.proto` changes invalidate codegen which transitively invalidates every consumer build; including the lock file ensures cache invalidates atomically with the bump.
- The `cron:` block at the top drives nightly soak + installer variants. Per-PR runs use `[soak]` / `[installer]` commit-message opt-in to keep PR feedback fast.
- Self-hosted runner labels: `[self-hosted, ccsm-soak]` for the 1 h soak runner; `[self-hosted, win11-25h2-vm]` for the ship-gate (d) runner. Both labels are provisioned out-of-band in the `infra/win11-runner/` repo (see chapter 10 §6).

#### 7. Versioning

- Single repo-wide version in `package.json` of the root and synced to each package via Changesets OR a tiny `scripts/sync-version.ts`. We pick **Changesets** because it integrates with PRs and produces the changelog.
- Daemon ↔ Electron version compatibility expressed in `Hello.proto_version` (see [Chapter 04](#chapter-04--proto-and-rpc-surface) §3); independent of npm version.
- **PROTO_VERSION drift check (CI)**: Changesets-driven version bumps are independent of `proto_version` (the latter is bumped only when `.proto` files change in a way that affects the wire). To prevent drift, `pnpm --filter @ccsm/proto run version-drift-check` (run in the `proto-gen-and-lint` CI job — see §6) asserts: the `PROTO_VERSION` constant exported by `@ccsm/proto` (read from `packages/proto/src/version.ts`) is `>=` the `PROTO_VERSION` recorded in the most recent git tag matching `v*` (read by `git show <tag>:packages/proto/src/version.ts`). The check fails the PR with an error message instructing the author to bump `PROTO_VERSION` IF AND ONLY IF a `.proto` file changed (the `proto-lock-check` step from §4 / §6 makes the `.proto` change visible). The check is a no-op on the very first release (no prior tag exists).

#### 8. v0.4 delta

- **Add** `packages/web/` (Vite + React + connect-web) and `packages/ios/` (Swift Package + connect-swift); both depend on `@ccsm/proto`.
- **Add** `gen/go/` and `gen/swift/` outputs to `buf.gen.yaml`; v0.3 `gen/ts/` continues unchanged.
- **Add** new CI jobs `web-test`, `ios-test`; matrix grows; existing jobs unchanged.
- **Add** `packages/cloudflared-config/` (or fold into `packages/daemon/` — decision deferred to v0.4) for tunnel config + lifecycle.
- **Unchanged**: pnpm + Turborepo choice, root layout, dep graph shape (just adds two leaves), proto codegen pipeline, ESLint forbidden-imports rule, per-package responsibility split, the v0.3 ship-gate jobs.


---

## Chapter 12 — Testing Strategy

v0.3 testing has four layers: unit (fast, per-package, per-PR), integration (daemon ↔ Electron over Listener A, per-PR on supported runners), E2E (per-OS package + service-installed, scheduled + on-demand), and the four ship-gate harnesses tied directly to brief §11 acceptance criteria. This chapter pins each layer's scope, the framework choice, the ship-gate harnesses, and the CI orchestration.

#### 1. Frameworks

| Layer | Framework | Why |
| --- | --- | --- |
| Unit (TS daemon + electron renderer) | **Vitest** | fast, ESM-native, parallel; same config for both packages |
| Integration | Vitest + a daemon-in-process bootstrap | spawns daemon code in-process (no native service install needed) |
| Electron E2E | **Playwright for Electron** | first-class Electron driver; works with the renderer's React app |
| Installer / service E2E | per-OS scripts (PowerShell on win, bash on mac/linux) | service install/uninstall is OS-shaped; using a single test runner is more harm than help |

#### 2. Unit tests

Per-package, fully isolated.

- `@ccsm/daemon` unit:
  - `principal.spec.ts` — `principalKey` format, derivation edge cases
  - `auth.spec.ts` — `assertOwnership` truth table
  - `db/migrations.spec.ts` — apply 001 to a `:memory:` DB, assert schema
  - `db/coalescer.spec.ts` — write batching ordering and atomicity
  - `pty/snapshot-codec.spec.ts` — round-trip property tests for SnapshotV1 (per [Chapter 06](#chapter-06--pty-snapshot--delta) §2)
  - `pty/delta-segmenter.spec.ts` — 16ms/16KiB cut policy
  - `pty/replay-invariant.property.spec.ts` — property-based test (fast-check) for the replay invariant: for any deterministic VT byte sequence S fed into a fresh xterm-headless `Terminal` X, `encode(snapshot(X))` equals `encode(snapshot(Y))` where Y is built by encoding a snapshot of X' (a checkpoint mid-stream of S) and replaying the post-checkpoint deltas of S into a fresh Terminal initialized from that snapshot. Shrinker catches edge-case VT byte sequences that the canned soak workload (§4.3) misses.
  - `crash/capture.spec.ts` — every source's mock fires once and writes one row
  - `listeners/peer-cred.spec.ts` — mocked syscall outputs map to expected principals

- `@ccsm/electron` unit:
  - `rpc/clients.spec.ts` — descriptor → transport factory (mocked transports per kind)
  - `rpc/queries.spec.ts` — React Query hook adapters (mock RPC, assert state transitions)
  - `ui/*.spec.tsx` — component-level (React Testing Library)

- `@ccsm/proto` unit:
  - `lock.spec.ts` — every `.proto` file's SHA256 vs a checked-in lockfile (forever-stable enforcement; not a buf-breaking replacement, complements it)
  - `proto/request-meta-validation.spec.ts` — `RequestMeta` field-presence + value-shape validation truth table ([Chapter 04](#chapter-04--proto-and-rpc-surface) §3)
  - `proto/open-string-tolerance.spec.ts` — daemon tolerates open-set string values (`client_kind="web"`, `client_kind="rust-cli"`, etc.) without rejection ([Chapter 04](#chapter-04--proto-and-rpc-surface) §3 / §7.1)
  - `proto/proto-min-version-truth-table.spec.ts` — proto min-version negotiation matrix (`HelloRequest.proto_min_version` × daemon supported set → accept/reject) ([Chapter 04](#chapter-04--proto-and-rpc-surface) §3)
  - `proto/error-detail-roundtrip.spec.ts` — `ErrorDetail` proto round-trips structured `code` / `retryable` fields byte-for-byte ([Chapter 04](#chapter-04--proto-and-rpc-surface) §2)
  - `buf-lint` runs in CI

#### 3. Integration tests (daemon ↔ Electron over Listener A)

Live in `packages/daemon/test/integration/` and `packages/electron/test/integration/`. Daemon runs in-process (not service-installed) on an ephemeral port / temp UDS path; Electron-side tests use the same Connect client a real renderer uses but driven by Vitest. **All integration test files use the `.spec.ts` extension** (no `.test.ts` — picked once, applied uniformly across chapter 12, chapter 06 §8, and CI invocations in [Chapter 11](#chapter-11--monorepo-layout) §6).

Per-RPC coverage criterion (see §6): every RPC declared in [Chapter 04](#chapter-04--proto-and-rpc-surface) MUST have at least one happy-path and one error-path integration test. The list below enumerates each:

- `connect-roundtrip.spec.ts` — SessionService happy paths: Hello, ListSessions, CreateSession, GetSession, DestroySession, WatchSessions stream events fire correctly on create/destroy.
- `pty-attach-stream.spec.ts` — PtyService.Attach happy path: create session with a deterministic test claude (`claude-sim --simulate-workload` short variant); Attach with `since_seq=0`; assert receive snapshot then deltas; replay and compare to daemon-side terminal state.
- `pty-reattach.spec.ts` — PtyService.Attach reattach path: record N deltas, disconnect, reattach with `since_seq=N`; assert deltas N+1..M arrive, no duplicates, no gaps.
- `pty-too-far-behind.spec.ts` — PtyService.Attach error path: simulate falling outside retention window, assert daemon falls back to snapshot.
- `pty-sendinput.spec.ts` — PtyService.SendInput happy path (typed bytes echo back as deltas); error path (SendInput on a destroyed session returns `FailedPrecondition`).
- `pty-resize.spec.ts` — PtyService.Resize happy path (resize 80×24 → 120×40 is observed as a Resize delta + snapshot triggered per chapter 06 §4); error path (resize on a destroyed session returns `FailedPrecondition`).
- `peer-cred-rejection.spec.ts` — pins the **two** peer-cred failure scenarios from chapter 03 §5 and chapter 05 §4:
  - **(a) peer-cred resolution failure**: middleware cannot resolve the calling pid → `Unauthenticated`.
  - **(b) peer-cred resolves but owner mismatch**: caller's `principalKey` differs from the session's `owner_id` → `PermissionDenied`.
  - Platform requirement: the OS-syscall path (real second uid binding) requires two real users; runner constraints — runs only on `matrix.os == 'ubuntu-22.04'` self-hosted runner with a pre-provisioned second account (`ccsm-test-other`) created via `useradd` in postinst; on `macos-*` and `windows-*` matrix legs, the test runs against the **mocked peer-cred middleware** (validates the auth chain but not the OS syscall) and is marked `requiresRealPeerCred=false`.
- `version-mismatch.spec.ts` — SessionService.Hello error path: `proto_min_version` higher than daemon's; assert `FailedPrecondition` with structured detail.
- `crash-stream.spec.ts` — CrashService.WatchCrashLog happy path: trigger every capture source via test hooks; assert each emitted.
- `crash-getlog.spec.ts` — CrashService.GetCrashLog happy path (returns latest N rows); error path (`NotFound` for unknown id).
- `settings-roundtrip.spec.ts` — SettingsService.Update + Get happy path: round-trip equal.
- `settings-error.spec.ts` — SettingsService error paths: Update with invalid schema returns `InvalidArgument`; Get on unknown key returns `NotFound`.
- `rpc/clients-transport-matrix.spec.ts` — parameterized over `transport ∈ {h2c-uds, h2c-loopback, h2-tls-loopback, h2-named-pipe}`; for each transport kind in the descriptor enum, construct a Connect transport from a synthesized descriptor and run `Hello`. Guards the MUST-SPIKE fallback paths ([Chapter 14](#chapter-14--risks-and-spikes)) so flipping the transport pick after a spike outcome doesn't ship an untested transport.
- `bundle/no-jwt-in-v03.spec.ts` — asserts the built sea bundle does NOT contain the string `jwtValidator` and `import('./jwt-validator')` rejects (file does not exist). Prevents accidental landing of v0.4 JWT middleware in v0.3 bundles (brief §1 mandate); also stands in for the absent `listener-b.ts` ([Chapter 03](#chapter-03--listeners-and-transport) §6 — v0.3 ships no listener-b file).

CI runs integration tests on `{ubuntu, macos, windows}` matrix per PR. Integration tests use a **temp file-based** SQLite DB (per-test tmpdir, deleted on teardown); unit tests use `:memory:` (see §2 `db/migrations.spec.ts`).

#### 4. The four ship-gate harnesses (brief §11)

##### 4.1 Ship-gate (a): no-IPC grep + ESLint backstop

The grep is the cheap fast layer; the ESLint rule is the sound layer. Both run in CI; either failing blocks merge. The grep catches stray string literals and template-stringy IPC channel names; the ESLint `no-restricted-imports` catches cases where the symbol is renamed or destructured (e.g., `import { ipcMain as M } from "electron"`).

`tools/lint-no-ipc.sh` (canonical script — referenced by [Chapter 08](#chapter-08--electron-client-migration) §5h, [Chapter 11](#chapter-11--monorepo-layout) §6, and this section; do NOT inline-duplicate the script anywhere else):

```bash
#!/usr/bin/env bash
set -euo pipefail
hits=$(grep -rEn 'contextBridge|ipcMain|ipcRenderer' packages/electron/src \
       --exclude-dir=node_modules --exclude-dir=dist || true)
# F3: optional descriptor-preload allowlist if F2 picks the contextBridge whitelist path.
# When `.no-ipc-allowlist` exists, each line is exactly a path (no line ranges).
# Allowlisted files MUST be < 100 lines so accidental growth is reviewed in PRs.
# Empty / missing file = no allowlist (the gate is unconditional).
if [ -f tools/.no-ipc-allowlist ]; then
  hits=$(echo "$hits" | grep -vFf tools/.no-ipc-allowlist || true)
fi
if [ -n "$hits" ]; then
  echo "FAIL: IPC residue:"; echo "$hits"; exit 1
fi
echo "PASS: zero IPC residue"
```

**v0.3 `tools/.no-ipc-allowlist` contents** are exactly: `packages/electron/src/preload/preload-descriptor.ts`, `electron/ipc-allowlisted/folder-picker.ts`, `electron/ipc-allowlisted/updater-ipc.ts`, `electron/ipc-allowlisted/preload-allowlisted.ts` (four lines plus comments — see chapter 08 §3.1 for the full file body and channel inventory). Any addition is a [Chapter 15](#chapter-15--zero-rework-audit) forever-stable touch and requires R4 sign-off.

ESLint backstop in `packages/electron/eslint.config.js` (flat-config v9, matching [Chapter 11](#chapter-11--monorepo-layout) §5; enforced in `electron-test` job per [Chapter 11](#chapter-11--monorepo-layout) §6):

```js
// F3: closes R4 P0 ch 12 ship-gate (a) — substring grep is unsound for renamed
// imports (e.g., `import { ipcMain as M } from "electron"`); pair the grep
// with a structural rule that catches the import itself, not the usage.
export default [
  {
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "electron",
          importNames: ["ipcMain", "ipcRenderer", "contextBridge"],
          message: "v0.3 forbids ipcMain / ipcRenderer / contextBridge — see chapter 08 §5; sanctioned exceptions go through tools/.no-ipc-allowlist (descriptor preload only).",
        }],
      }],
    },
  },
];
```

Wired into `electron-test` job (per [Chapter 11](#chapter-11--monorepo-layout) §6) as TWO sequential steps (grep then ESLint rule); both must pass; either failing blocks merge.

##### 4.2 Ship-gate (b): daemon survives Electron SIGKILL

Canonical test file: `packages/electron/test/e2e/sigkill-reattach.spec.ts` (Playwright for Electron + per-OS kill helper). [Chapter 08](#chapter-08--electron-client-migration) §7 references this file path; [Chapter 13](#chapter-13--release-slicing) phase 11 also references it. This is the single source of truth for ship-gate (b)'s test name and path.

1. Boot daemon. **Per-PR variant**: spawn the daemon as a real OS subprocess in its own process group (`spawn(process.execPath, ['-e', "require('@ccsm/daemon').main()"], { detached: true, stdio: 'pipe' })` on POSIX; `spawn(... , { windowsHide: true, detached: true })` + `CREATE_NEW_PROCESS_GROUP` on Windows). The in-process Worker variant is forbidden because `taskkill /F /IM electron.exe` (and `kill -9` of the Electron PID group on POSIX) can reap a fused daemon Worker, masking the failure mode the gate is meant to catch. **Nightly variant**: service-installed daemon (separate process tree by definition).
2. Launch Electron via Playwright; create 3 sessions; wait for `RUNNING`; for each, attach and read 100 deltas; record (a) last applied seq per session and (b) a snapshot of each client-side xterm-headless terminal after applying the 100 deltas (kept in memory for the byte-equality assertion in step 7).
3. Kill the Electron main PID with `taskkill /F` (win) / `kill -9` (mac/linux). On POSIX the Electron PID is killed; the daemon, in a separate process group from step 1, is unaffected.
4. Verify `curl <supervisor>/healthz` returns 200; verify `claude` PIDs still alive (`tasklist` / `ps`).
5. Relaunch Electron via Playwright; wait for `Hello`; verify the 3 sessions appear in `ListSessions`.
6. For each session, attach with the recorded last applied seq; assert receive deltas with `seq > recorded` immediately, no gaps. If the gap delta count `< DELTA_RETENTION_SEQS` (currently 4096), reattach receives those deltas without a `snapshot` frame; if `>= DELTA_RETENTION_SEQS`, a `snapshot` frame is expected. Step 7's byte-equality assertion is the load-bearing gate regardless of which path is taken.
7. **Byte-equality "no data loss" assertion** (closes brief §11(b) "no data loss" — gate (b) without this passes vacuously when seq is monotonic but bytes are corrupt):
   - On the daemon side: serialize the current xterm-headless terminal state for each session via the SnapshotV1 encoder (encoder determinism pinned in [Chapter 06](#chapter-06--pty-snapshot--delta) §2; see §4.3 below).
   - On the client side: replay all received frames (the recorded snapshot from step 2 + every delta received in steps 2 and 6) into a fresh xterm-headless `Terminal` instance, then serialize via the same SnapshotV1 encoder.
   - Assert `Buffer.compare(daemon.snap, client.snap) === 0` for every session. This is the same comparator gate (c) uses; gate (b) reuses it as a 30-second variant.

Pass criterion: all assertions hold (sessions intact + PTY children alive + delta continuation + byte-equality). CI: per-PR (subprocess daemon) + nightly (service-installed).

##### 4.3 Ship-gate (c): 1-hour PTY zero-loss soak

Specified in [Chapter 06](#chapter-06--pty-snapshot--delta) §8. **Canonical test name `pty-soak-1h`** at canonical path `packages/daemon/test/integration/pty-soak-1h.spec.ts` (single source of truth — chapter 06 §8 and chapter 11 §6's `pnpm run test:pty-soak` invocation MUST resolve to this file). Electron-side reattach companion: `packages/electron/test/e2e/pty-soak-reconnect.spec.ts`.

**Comparator algorithm**: at the end of the 1-hour run, encode the daemon-side xterm-headless terminal state via SnapshotV1 and the client-side replayed terminal state via SnapshotV1; assert `Buffer.compare === 0`. This requires SnapshotV1 encoder determinism — pinned in [Chapter 06](#chapter-06--pty-snapshot--delta) §2 (palette entries appended in order of first appearance during a stable left-to-right top-to-bottom cell scan; modes_bitmap bit positions enumerated; field ordering fixed). If chapter 06 §2 ever loosens determinism, this gate becomes meaningless — [Chapter 15](#chapter-15--zero-rework-audit) audit MUST flag.

**Workload class enumeration** (the canned 60-minute script `claude-sim --simulate-workload 60m` MUST exercise every class below; missing a class makes the gate pass vacuously on toy workloads):

| Class | Concrete sequences | Why required |
| --- | --- | --- |
| UTF-8 / CJK / mixed-script | 3-byte and 4-byte UTF-8; CJK wide cells; combining marks; RTL bidi | wide-char and grapheme handling are top sources of snapshot drift |
| 256-color + truecolor + SGR | SGR 38;5;n / 38;2;r;g;b; SGR resets; bold/italic/underline | exercises `attrs_palette` ordering determinism |
| Cursor positioning | CUP, CUU, CUD, CUF, CUB; save/restore | exercises cursor field |
| Alt-screen toggles | DECSET 1049 enter / exit (vim simulator phase) | exercises alt-screen + scrollback partition |
| Bursts and idles | 1 MB in 50 ms burst; 30 s idle gap; mixed cadence | exercises delta segmenter (chapter 06 §3) under both pressure and starvation |
| **OSC sequences** | OSC 0/2 (window title), OSC 8 (hyperlink) | xterm-headless tracks title; if SnapshotV1 doesn't encode title the gate's "binary-identical to truth" claim is bounded — coverage of these MUST either round-trip equal or be explicitly listed in chapter 06 §2 as out-of-snapshot non-coverage |
| **DECSTBM scroll regions** | CSI Pt;Pb r (used by less / more / vim) | scroll region state must be in snapshot or the comparator fails after a `less` phase |
| **Mouse mode toggles** | DEC private modes 1000, 1002, 1003, 1006 | `modes_bitmap` claims to track these — chapter 06 §2 enumerates bit positions; soak MUST toggle each |
| **Resize during burst** | SIGWINCH mid-burst + a Resize RPC mid-burst | snapshot-on-resize cadence (chapter 06 §4); real Electron users resize, this is not a synthetic concern |
| Out-of-scope (documented) | Kitty graphics protocol, sixel | `claude` does not currently emit images; explicitly non-covered |

**SendInput p99 sampling** (closes "perf budgets do NOT block PRs" gap from §7): the soak harness samples `SendInput` RTT once per second over the 1-hour window and asserts `p99 < 5 ms`. SendInput typing-latency regressions therefore block ship via gate (c) rather than waiting for the next morning's nightly perf bench. Other §7 budgets (Hello RTT, cold start, snapshot encode, RSS) remain advisory.

**Self-hosted runner constraint**: 1-hour budget; soak runs on a self-hosted runner labeled `self-hosted-soak-linux` (and Windows / macOS equivalents per chapter 11 §6). Sole occupancy required for the run window so background CPU contention doesn't introduce timing flakes.

**CI orchestration**: nightly schedule + opt-in via `[soak]` token in commit message. **Non-blocking for PRs** (regressions caught the next morning); **blocking for release tags** via the explicit release procedure pinned in [Chapter 13](#chapter-13--release-slicing) §5 — at tag time, an on-demand soak run is triggered; the tag is promoted only after the soak run on that exact commit is green. This removes the "same commit never simultaneously green" race noted in R4.

**macOS hang-detection note**: on macOS, no kernel watchdog reaps a hung daemon (per [Chapter 09](#chapter-09--crash-collector) §6 — macOS watchdog deferred to v0.4 hardening). A stalled stream observed during the 1h soak is interpreted as a daemon hang and fails the gate; the operator MUST `ps -p` + `sample` the daemon before the next attempt.

##### 4.4 Ship-gate (d): clean installer round-trip on Win 11 25H2

`test/installer-roundtrip.ps1` runs on a self-hosted Win 11 25H2 VM (snapshotted to a clean state before each run). The VM image is provisioned and maintained per [Chapter 13](#chapter-13--release-slicing) phase 11(d) precondition; **GitHub-hosted `windows-latest` is NOT 25H2** (currently Server 2022) so the VM is a hard prerequisite, not optional. Runner label: `self-hosted-win11-25h2-vm`.

The check is a **file-tree + registry diff** (snapshot before install, snapshot after uninstall, diff against a documented allowlist) — not a fixed list of expected leftover locations. Fixed-list checks pass when residue lands in an unexpected location; diff-based checks fail closed.

```powershell
# pseudo-flow — chapter 10 §5 step 4 promises BOTH REMOVEUSERDATA variants are
# exercised under ship-gate (d); loop over both, restoring the snapshot between
# variants so each begins from a clean baseline.
$variants = @('=0', '=1')
foreach ($removeUserData in $variants) {
Invoke-Snapshot-Restore "win11-25h2-clean"

# 1. Pre-install baseline: full file-tree + registry export
Get-ChildItem -Recurse -Force `
  "$env:ProgramFiles","$env:ProgramData","$env:LOCALAPPDATA","$env:APPDATA","$env:TEMP" `
  | Select-Object FullName | Out-File C:\install\fs-pre.txt
reg export HKLM C:\install\hklm-pre.reg /y
reg export HKCU C:\install\hkcu-pre.reg /y
Get-ScheduledTask | Select-Object TaskName,TaskPath | Out-File C:\install\tasks-pre.txt

# 2. Install
Copy-Item ".\artifacts\ccsm-setup-*.msi" "C:\install\"
Start-Process -Wait msiexec -ArgumentList "/i C:\install\ccsm-setup.msi /qn /l*v C:\install\install.log"

# 3. Verify the service is actually serving (Service Manager 'Running' is necessary but not sufficient)
$svc = Get-Service ccsm-daemon
if ($svc.Status -ne 'Running') { throw "service not running" }
# Read Listener A address from the file the daemon writes (do NOT hardcode — fresh VM has no prior state)
$listenerA = Get-Content "$env:ProgramData\ccsm\listener-a.json" | ConvertFrom-Json
$ok = Invoke-WebRequest -UseBasicParsing $listenerA.healthzUrl
if ($ok.StatusCode -ne 200) { throw "supervisor /healthz not 200" }
# Optional: smoke a Hello RPC against Listener A using a built test client
& C:\install\ccsm-test-client.exe hello

# 4. Launch electron, smoke-create a session, smoke-destroy
& "$env:ProgramFiles\ccsm\ccsm.exe" --test-mode --smoke

# 5. Uninstall — variant-specific REMOVEUSERDATA value drives chapter 10 §5 step 4 matrix
Start-Process -Wait msiexec -ArgumentList "/x C:\install\ccsm-setup.msi REMOVEUSERDATA$removeUserData /qn /l*v C:\install\uninstall.log"

# 6. Post-uninstall snapshot + diff
Get-ChildItem -Recurse -Force `
  "$env:ProgramFiles","$env:ProgramData","$env:LOCALAPPDATA","$env:APPDATA","$env:TEMP" `
  | Select-Object FullName | Out-File C:\install\fs-post.txt
reg export HKLM C:\install\hklm-post.reg /y
reg export HKCU C:\install\hkcu-post.reg /y
Get-ScheduledTask | Select-Object TaskName,TaskPath | Out-File C:\install\tasks-post.txt

# 7. Diff: only items on `test/installer-residue-allowlist.txt` may differ.
#    The allowlist enumerates OS-induced churn during the test window
#    (e.g., Windows Update tracking files, ETW session logs, Defender scan history).
$fsDiff    = Compare-Object (Get-Content C:\install\fs-pre.txt)    (Get-Content C:\install\fs-post.txt)    | Where-Object SideIndicator -eq '=>'
$hklmDiff  = Compare-Object (Get-Content C:\install\hklm-pre.reg)  (Get-Content C:\install\hklm-post.reg)  | Where-Object SideIndicator -eq '=>'
$hkcuDiff  = Compare-Object (Get-Content C:\install\hkcu-pre.reg)  (Get-Content C:\install\hkcu-post.reg)  | Where-Object SideIndicator -eq '=>'
$taskDiff  = Compare-Object (Get-Content C:\install\tasks-pre.txt) (Get-Content C:\install\tasks-post.txt) | Where-Object SideIndicator -eq '=>'
$allowlist = Get-Content "test\installer-residue-allowlist.txt"

$residue = @($fsDiff,$hklmDiff,$hkcuDiff,$taskDiff) | ForEach-Object { $_.InputObject } `
           | Where-Object { $entry = $_; -not ($allowlist | Where-Object { $entry -match $_ }) }

if ($residue.Count -gt 0) {
  throw "Uninstall residue (REMOVEUSERDATA$removeUserData, not on allowlist):`n$($residue -join "`n")"
}
}
```

CI: nightly schedule + on-tag.

**Mac and linux do NOT have a ship-gate (d) equivalent in v0.3.** Brief §11(d) is Windows-specific; mac/linux installers are tested manually before release per brief §11(d) clarification (results posted to release notes). An `installer-roundtrip.sh` script may be drafted in parallel for future use, but it is NOT a v0.3 ship-gate — the ship-gate set is intentionally asymmetric across OSes.

#### 5. Test data: deterministic claude CLI

For PTY tests we cannot use the real `claude` (network, model nondeterminism). We ship a test build `claude-sim` in `packages/daemon/test/fixtures/claude-sim/`:

- Reads a script file (path via `--simulate-workload-script`) of `(delay_ms, hex_bytes)` pairs.
- Writes the bytes to stdout with the specified delays.
- Honors a `--simulate-workload 60m` shortcut that runs a canned 60-minute script (covering every workload class enumerated in §4.3) used by ship-gate (c).
- Produces stable byte-by-byte identical output across runs.

**Source language: Go** (picked over Rust for cross-platform-cross-arch ease — `GOOS`/`GOARCH` matrix is trivial; Rust would need `cross` or per-target runners and adds toolchain cost). Source lives in `packages/daemon/test/fixtures/claude-sim/` (Go module rooted there). **Vendoring policy**: source is committed; binary is **NOT** committed — it is built in CI as a step of the daemon test job (`go build -o claude-sim[.exe] ./...` for each `{linux,darwin,windows} × {amd64,arm64}`) and the resulting binary is placed in `packages/daemon/test/fixtures/claude-sim/bin/<goos>-<goarch>/`. This avoids polluting clones with multi-arch binaries (no need for git-LFS) and avoids the [Chapter 11](#chapter-11--monorepo-layout) §2 `.gitattributes` LFS question entirely.

> Coordination note for [Chapter 11](#chapter-11--monorepo-layout) §2 (owned by F9): chapter 11 §2's directory layout MUST list `packages/daemon/test/fixtures/claude-sim/` as a Go module sub-tree (committed source) with a `.gitignore` entry for `bin/` (build artifacts not committed). chapter 11 §6 CI matrix MUST include the `go build` step before the daemon test job (Go toolchain `1.22+` on all three runner OSes — `setup-go@v5`).

**Script file format** (for authors adding new soak workloads, e.g., an OSC-8 case): the `--simulate-workload-script <path>` file is **JSON Lines** (`.jsonl`); each line is `{"delay_ms": <integer>, "hex": "<lowercase-hex>"}`. Comments allowed via lines starting with `#`. Example:

```jsonl
# OSC 0 set window title to "build"
{"delay_ms": 0, "hex": "1b5d303b6275696c641b5c"}
# 200 ms idle, then SGR red + "ERR" + reset
{"delay_ms": 200, "hex": "1b5b33316d4552521b5b306d"}
```

Workload class coverage MUST be cross-checked against §4.3's table (file-tree review on PRs that touch `claude-sim` fixtures includes a manual class-coverage check; a missing class in the canned 60-minute script is a P0 ship-gate (c) bug).

#### 6. Coverage target

- Unit: 80% line coverage on `@ccsm/daemon/src` (excluding `dist/`, `gen/`, `test/`).
- Integration: not measured by line coverage; measured by RPC coverage — every RPC in [Chapter 04](#chapter-04--proto-and-rpc-surface) MUST have at least one integration test exercising the happy path and at least one exercising an error path. The §3 integration test list above enumerates each (Resize, GetCrashLog, SettingsService error-paths included).
- Electron renderer: 60% line coverage on `src/renderer/`. UI-shell code (windowing, tray) is untested.

**Enforcement**: thresholds **ARE enforced in CI**. The `pnpm --filter @ccsm/daemon run coverage` step fails the PR if line coverage on `@ccsm/daemon/src` falls below 80%; the `pnpm --filter @ccsm/electron run coverage` step fails the PR if line coverage on `src/renderer/` falls below 60%. Vitest config exclusion of `dist/`, `gen/`, `test/` is wired in `packages/daemon/vitest.config.ts` (`coverage.exclude`); [Chapter 11](#chapter-11--monorepo-layout) §6's `daemon-test` and `electron-test` jobs include the coverage step. The repo-root `vitest.config.ts`'s legacy advisory thresholds (60/60/50/60, "NOT enforced in CI yet") are superseded by these per-package enforced thresholds.

#### 7. Performance budgets (regressions = test failures)

| Metric | Budget | Enforced by |
| --- | --- | --- |
| Daemon cold start to Listener A bind | < 500 ms (no sessions) / < 2 s (50 sessions to restore) | `bench/cold-start.spec.ts` |
| `Hello` RPC RTT over Listener A | < 5 ms p99 (loopback) | `bench/hello-rtt.spec.ts` |
| `SendInput` RTT | < 5 ms p99 | `bench/sendinput-rtt.spec.ts` (advisory) **AND** sampled-during-soak in `pty-soak-1h.spec.ts` (blocking via gate (c) — see §4.3) |
| Snapshot encode (80×24 + 10k scrollback) | < 50 ms | `bench/snapshot-encode.spec.ts` |
| Daemon RSS at idle (5 sessions) | < 200 MB | nightly `bench/rss.spec.ts` |

Bench files live in `packages/daemon/test/bench/` (added to [Chapter 11](#chapter-11--monorepo-layout) §2 directory layout).

Benchmarks run nightly; **budgets do NOT block PRs by themselves** (too noisy in CI; manual triage gates ship) **EXCEPT** the `SendInput` p99 budget, which gates ship via gate (c) sampled-during-soak (see §4.3) so typing-latency regressions cannot ship unnoticed. Other budget regressions open an issue tagged `perf-regression` for manual triage before tagging.

#### 8. v0.4 delta

- **Add** integration tests for Listener B JWT path with mock cf-access tokens.
- **Add** web/iOS package test suites (their own runners; do not change daemon tests).
- **Add** ship-gate (e): "v0.4 web client connects through CF Tunnel and survives daemon restart" — additive harness.
- **Unchanged**: Vitest + Playwright choice, the four v0.3 ship-gate harnesses (still gate v0.4 ships too — additivity), test data `claude-sim`, coverage targets, performance budgets.


---

## Chapter 13 — Release Slicing

v0.3 is shipped as a sequence of merges into the working branch with explicit ordering: foundation → wire → daemon internals → cutover → installer → ship-gate verification. This chapter pins the phase ordering, the merge-precedence rules, the P0 milestones each tied to a brief §11 ship-gate, and the seed for the stage-6 task DAG extraction.

#### 1. Phases (high-level ordering)

```
Phase 0    — Repo + tooling foundation
Phase 0.5  — Transport spikes (resolves all MUST-SPIKE items in [03])
Phase 1    — Proto + codegen
Phase 2    — Daemon skeleton + Listener A + Supervisor UDS
Phase 3    — SQLite + migrations + principal model
Phase 4    — Session manager + claude CLI subprocess control
Phase 4.5  — PTY worker spike [child-process-pty-throughput] (F3 picked child_process; this confirms throughput envelope)
Phase 5    — PTY host (xterm-headless + node-pty + snapshot/delta)
Phase 6    — Crash collector
Phase 7    — Settings service
Phase 8a   — Electron: proto-client wiring + transport bridge + descriptor reader (no behavior change; coexists with IPC)
Phase 8b   — Electron: big-bang IPC removal cutover (the cutover PR; behind feature flag per F6 ch 08 rollback story)
Phase 8c   — Electron: cleanup pass (delete dead files; flip feature flag default; wire CI `lint:no-ipc` gate)
Phase 9    — Per-OS service registration + Supervisor lifecycle
Phase 9.5  — Build/notarization spikes ([sea-on-22-three-os], [macos-notarization-sea], [msi-tooling-pick])
Phase 10   — Per-OS installer + signing/notarization
Phase 11   — Ship-gate verification harnesses (a)/(b)/(c)/(d)
Phase 12   — Soak + dogfood + ship
```

Spike phases (0.5, 4.5, 9.5) are explicit pre-phase gates. A spike's failure is a chapter-edit (fallback design lands in the relevant chapter) — NOT a downstream phase redo. Implementation phases assume spike outcomes are frozen.

Phases are NOT serial — they have explicit dependencies that allow parallelism (see §3). A phase is "done" when every PR in it is merged AND all its acceptance criteria are green.

#### 2. Phase contents and acceptance criteria

##### Phase 0 — Foundation
- Set up monorepo layout per [Chapter 11](#chapter-11--monorepo-layout) §2.
- pnpm + Turborepo wired; CI install + cache works.
- `tsconfig.base.json`, ESLint, Prettier, Changesets configured.
- ESLint `no-restricted-imports` enforces inter-package boundaries.
- **Done when**: `pnpm install && pnpm run build && pnpm run lint && pnpm run test` runs in CI in < 10 min on a clean cache; **≥ 80% Turborepo cache hit rate on a no-op rebuild** (measured via `turbo run build --dry=json` task summary; `cached / total >= 0.8`).

##### Phase 0.5 — Transport spikes
- Resolve every MUST-SPIKE item in [Chapter 03](#chapter-03--listeners-and-transport) §1 and [Chapter 14](#chapter-14--risks-and-spikes) (transport-related).
- Output: per-OS transport decision matrix appended to chapter 03 §1.
- **Done when**: spike harnesses under `tools/spike-harness/transport/` green on all 3 OSes; chapter 03 §1 decision matrix committed.

##### Phase 1 — Proto
- `.proto` files per [Chapter 04](#chapter-04--proto-and-rpc-surface).
- `buf.gen.yaml` produces TS code consumed by daemon and electron stubs.
- Lock file: `packages/proto/lock.json` with SHA256 per `.proto` file (committed; CI rejects any `.proto` mutation that does not bump the matching SHA — see [Chapter 11](#chapter-11--monorepo-layout) §6).
- `buf lint` clean; `buf breaking` job is **active from this phase forward** (NOT deferred until v0.3 tag); pre-tag the comparison target is the PR's merge-base SHA on the working branch, post-tag it switches to the v0.3 release tag.
- **Done when**: `pnpm --filter @ccsm/proto run gen && pnpm --filter @ccsm/proto run lint && pnpm --filter @ccsm/proto run lock-check && pnpm --filter @ccsm/proto run breaking` green in CI on all OSes.

##### Phase 2 — Daemon skeleton + Listener A + Supervisor
- Daemon binary boots (no sessions); writes `listener-a.json`; binds Listener A; Supervisor `/healthz` returns 200.
- `Hello` RPC works end-to-end via Connect over Listener A.
- Listener trait + 2-slot array; v0.3 ships no `listener-b.ts`; slot 1 holds the typed `RESERVED_FOR_LISTENER_B` sentinel.
- Peer-cred middleware on Listener A produces `local-user` principal.
- All MUST-SPIKE items in [Chapter 03](#chapter-03--listeners-and-transport) resolved **in phase 0.5**; phase 2 consumes the per-OS transport decision matrix as a frozen input.
- **Done when**: integration test `connect-roundtrip` Hello-only variant green on all OSes.
- **P0 milestone**: this phase unblocks every other daemon-side phase.

##### Phase 3 — SQLite + migrations + principal model
- `001_initial.sql` applied on boot; `principals`, `sessions`, `pty_*`, `crash_log`, `settings`, `cwd_state` tables exist.
- `principalKey` + `assertOwnership` implemented and unit-tested.
- Write coalescer for deltas implemented.
- **Done when**: unit + integration tests for `db/*` and `principal/*` green.

##### Phase 4 — Session manager + claude CLI
- `SessionService.{Create,List,Get,Destroy,WatchSessions}` implemented.
- `claude` CLI subprocess spawn/supervise; respawn on daemon boot per §7 of [Chapter 05](#chapter-05--session-and-principal).
- **Done when**: integration `connect-roundtrip` full variant green.

##### Phase 4.5 — PTY worker spike
- Resolve `[child-process-pty-throughput]` from [Chapter 14](#chapter-14--risks-and-spikes) (F3 picked `child_process` over `worker_threads`; this phase confirms the throughput envelope holds for `node-pty` driving `xterm-headless` under realistic input bursts).
- Output: pinned per-OS throughput baseline (bytes/sec) appended to chapter 06 §4.
- **Done when**: spike harness `tools/spike-harness/pty-throughput/` green on all 3 OSes; chapter 06 §4 baseline committed.

##### Phase 5 — PTY host
- `worker_threads` per session; node-pty + xterm-headless wired.
- `PtyService.{Attach,SendInput,Resize}` implemented.
- Snapshot encoder per [Chapter 06](#chapter-06--pty-snapshot--delta) §2; delta segmenter per §3; cadence per §4; reconnect tree per §5.
- All MUST-SPIKE items in [Chapter 06](#chapter-06--pty-snapshot--delta) resolved **in phase 4.5**; phase 5 consumes the throughput baseline as a frozen input.
- **Done when**: `pty-attach-stream` + `pty-reattach` + `pty-too-far-behind` integration tests green AND a **10-minute soak smoke** (`pty-soak-10m.spec.ts`, scaled-down variant of ship-gate (c)) green on all 3 OSes. The full 1-hour soak ship-gate (c) runs in phase 11.
- **P0 milestone**: phase 5 + phase 11 ship-gate (c) is the dogfood quality bar.

##### Phase 6 — Crash collector
- All capture sources from [Chapter 09](#chapter-09--crash-collector) §1 wired.
- `CrashService.{GetCrashLog,WatchCrashLog}` implemented.
- `crash-raw.ndjson` recovery on boot.
- **Done when**: `crash-stream` integration test green.

##### Phase 7 — Settings service
- `SettingsService.{GetSettings,UpdateSettings}` implemented.
- Retention enforcer wired (consumes `Settings.crash_retention`).
- **Done when**: `settings-roundtrip` integration test green.

##### Phase 8 — Electron migration (split into 8a / 8b / 8c)

The phase 8 cutover is split into three stacked PRs to keep each PR reviewable. The "big-bang" rule from chapter 08 §1 applies to **the shipped app** (no coexisting IPC + Connect code paths in v0.3 release): 8a's parallel paths are pre-cutover scaffolding, fully removed by 8c. Coordinate with [Chapter 08](#chapter-08--electron-client-migration) F6 feature-flag rollback story — 8b ships the new path behind `CCSM_USE_CONNECT=1` (default off); 8c flips the default and removes the flag.

###### Phase 8a — Proto-client wiring + transport bridge + descriptor reader
- Add generated Connect clients (consumed from `@ccsm/proto`, produced in phase 1).
- Add transport bridge module (renderer ↔ main descriptor passing per [Chapter 08](#chapter-08--electron-client-migration) §5 sub-steps a-d).
- Add descriptor reader on renderer side.
- **No behavior change**: existing IPC paths remain wired; new Connect paths exist but are gated by `CCSM_USE_CONNECT` (default off).
- **Done when**: existing Electron smoke tests still green (no regression); new `transport-bridge.spec.ts` unit test green.
- LOC budget: < 1500 (additive).

###### Phase 8b — Big-bang IPC removal cutover
- Replace each `ipcMain.handle` / `ipcRenderer.invoke` call site with the corresponding Connect client call (chapter 08 §5 sub-steps e-h).
- All Electron components ported to React Query + generated Connect clients.
- Feature flag `CCSM_USE_CONNECT` selects between old IPC path and new Connect path (default still off; flag enables the new code).
- **Done when**: full Electron app smoke-launch on each OS with `CCSM_USE_CONNECT=1` shows full UX functional; smoke-launch with flag off (legacy IPC path) still works (rollback proven).
- LOC budget: explicitly unbounded (this is the cutover); requires ≥ 2 reviewers + author sign-off.

###### Phase 8c — Cleanup + lint gate
- Flip `CCSM_USE_CONNECT` default to on; delete the legacy IPC code paths and the flag itself.
- Delete dead files (chapter 08 §5 sub-step i).
- Wire CI `lint:no-ipc` gate (ESLint + grep per [Chapter 12](#chapter-12--testing-strategy) §4.1).
- **Done when**: ship-gate (a) `lint:no-ipc` green AND smoke-launch on each OS shows full UX functional with no `ipcMain.handle` / `contextBridge` calls in the codebase.
- LOC budget: < 1000 (mostly deletions).
- **P0 milestone**: ship-gate (a). M2 fires when 8c lands.

##### Phase 9.5 — Build/notarization spikes
- Resolve `[sea-on-22-three-os]`, `[macos-notarization-sea]`, `[msi-tooling-pick]` from [Chapter 14](#chapter-14--risks-and-spikes).
- Output: per-OS build/sign/notarize recipe appended to chapter 10 §5.
- **Done when**: spike harnesses under `tools/spike-harness/build/` green on all 3 OSes; chapter 10 §5 recipes committed.

##### Phase 9 — OS service registration glue
- Daemon entrypoint detects "running as service" vs "running as cli" (env var or argv flag).
- Service-mode emits `READY=1` (linux), starts `WATCHDOG=1` keepalive (linux), respects platform stop signals.
- **Done when**: a manual `sc create` (win) / `launchctl bootstrap` (mac) / `systemctl start` (linux) end-to-end works locally.

##### Phase 10 — Installer
- WiX MSI / pkg / deb + rpm builds per [Chapter 10](#chapter-10--build-package-installer) §5.
- Code signing + notarization in CI (uses encrypted secrets).
- **Done when**: `package` CI job green on all 3 OSes; install + uninstall manual smoke clean.
- Depends on: phase 9 (service glue) AND phase 0 (CI matrix).

##### Phase 11 — Ship-gate verification harnesses
- (a) `lint:no-ipc`: implemented in phase 8c; here we just ensure it stays green.
- (b) `sigkill-reattach.spec.ts` per [Chapter 12](#chapter-12--testing-strategy) §4.2.
- (c) `pty-soak-1h` per [Chapter 12](#chapter-12--testing-strategy) §4.3.
- (d) `installer-roundtrip.ps1` per [Chapter 12](#chapter-12--testing-strategy) §4.4.
- **Procedure for "all four green on the same commit"**: gates (c) and (d) are nightly / scheduled, not per-PR. Tagging a release candidate uses `tools/release-candidate.sh <SHA>` which: (1) verifies (a)+(b) already green on the SHA via `gh run list --commit=<SHA>`; (2) dispatches `workflow_dispatch` runs for soak (c) and installer (d) pinned to `<SHA>`; (3) polls until both finish; (4) emits a summary report and, if all four green, prints the suggested `git tag` command. No tag is applied automatically.
- **Done when**: all four green on the candidate release tag, witnessed by `tools/release-candidate.sh` report.

##### Phase 12 — Soak + dogfood + ship
- Engineer eats own dogfood for ≥ 1 week of real `claude` CLI usage.
- Daily crash log review; bug fixes flow as additive PRs (NO architectural changes — those are zero-rework violations and bounce back to spec).
- **"No architectural regression PRs" measurement**: in the 7-day window, a PR is an "architectural regression" iff it carries the `architecture-regression` GitHub label OR it modifies any file under the v0.3 forever-stable list (chapter 15 §3 forbidden-patterns: `packages/proto/**/*.proto` semantic edits, `packages/daemon/src/listener/**`, `packages/daemon/src/principal/**`, `packages/daemon/src/db/migrations/001_initial.sql`). The `tools/dogfood-window-check.sh <since-SHA>` script greps merged PRs in the window via `gh pr list --state=merged --search="merged:>=<date>"`, asserts label absence, and asserts no diff touches the forbidden file list. Any hit fails phase 12.
- Ship.

#### 3. Dependency DAG (seed for stage 6)

Edges = "must merge before". Most phases parallelize after phase 2.

```
0 ──► 0.5 ──► 1 ──┬──► 2 ──► 3 ──► 4 ──► 4.5 ──► 5
                  │                                │
                  │                                ├──► 6 (uses crash hooks from session manager)
                  │                                └──► 7
                  │
                  │                  2 ──► 9 ──► 9.5 ──► 10
                  │
                  └──► 8a ──► 8b ──► 8c
                       (8a needs 1 for proto stubs; can start in parallel
                        with 4-7. 8b cannot merge until 4,5,6,7 are merged
                        on the daemon side; 8c stacks on 8b.)

{4, 5, 8c} ──► 11(b)
5            ──► 11(c)
8c           ──► 11(a)
10           ──► 11(d)
9            ──► 11(b) (service-installed nightly variant)
11(a,b,c,d)  ──► 12
```

Specifically:
- Phase 0.5 (transport spikes) gates phase 1 codegen choices and phase 2 listener wiring.
- Phase 1 unblocks phase 2 (server stubs) and phase 8a (client stubs) simultaneously.
- Phase 2 unblocks phase 3 (DB depends on daemon process boot) AND phase 9 (service registration does not need internals 3-8).
- Phase 3 unblocks phases 4 and 6 and 7.
- Phase 4 unblocks phase 4.5 (PTY spike needs the session subprocess shape).
- Phase 4.5 unblocks phase 5.
- **Daemon-side merge ordering** (P0): phase 4 → 5 → 6 → 7 land **sequentially** in the working branch (each builds on the previous; sequential ordering avoids rebase churn for phase 8b).
- **Phase 8 stacking** (P0): 8a may start in parallel with 4-7 (additive only); 8b must rebase on a working branch that contains merged 4, 5, 6, 7; 8c stacks on 8b. Phase 8 is **the last** big block to land before phase 11.
- Phase 9.5 (build/notarization spikes) gates phase 10.
- Phase 10 (installer) needs phase 9 (service registration glue) but does NOT need internals (4-8); the installer just installs whatever `ccsm-daemon` binary is built.
- **Phase 11(b) deps** (P0 pin): 11(b) depends on phases **4, 5, 8c, 9** — Electron present (8c, post-cutover) + daemon process (4) + PTY for "reattach" (5) + service registration for service-installed nightly variant (9). NOT 6 or 7.
- Phase 11(a) ← 8c. Phase 11(c) ← 5. Phase 11(d) ← 10.

#### 4. Branching and merge discipline

- Trunk-based: all PRs into the working branch (`spec/2026-05-03-v03-daemon-split` for spec; for impl, the v0.3 release branch named separately by stage 6).
- Each phase opens with a parent tracking issue; child PRs reference it.
- Each PR: one phase OR one self-contained chunk inside a phase.
- Phase 8b (big-bang IPC removal cutover) is the only large PR by design (LOC budget unbounded; ≥ 2 reviewers + author sign-off required); 8a and 8c follow the < 600 LOC target. Everything else is < 600 LOC diff target.
- All PRs require: green CI on all OSes; one human review; no `--no-verify`.

#### 5. P0 milestones (gate the v0.3 ship)

In the order they fall:

1. **M0 (Phase 2 done)**: daemon talks to a Connect client over Listener A. Unblocks all parallel work.
2. **M1 (Phase 5 done)**: PTY attach/reattach works in integration tests. Unblocks dogfood feasibility check.
3. **M2 (Phase 8c merged)**: ship-gate (a) green; Electron is no longer touching `ipcMain`; legacy IPC code paths and `CCSM_USE_CONNECT` flag deleted. Unblocks phase 11(b) running against a real Electron.
4. **M3 (Phase 10 done)**: installable on all 3 OSes. Unblocks phase 11(d) and engineer dogfood at scale.
5. **M4 (all of Phase 11 green)**: ship-gate (a)+(b)+(c)+(d) all green on the same commit. Tag candidate.
6. **M5 (Phase 12)**: ≥ 7 days of dogfood with no architectural regression PRs (measured per phase 12 done-criteria via `tools/dogfood-window-check.sh`). Tag v0.3 release.

#### 6. v0.4 delta

- **Add** v0.4 phases stacked on top: Listener B + JWT, cloudflared lifecycle, web package, iOS package, web/iOS ship-gates.
- **Unchanged**: every v0.3 phase's outputs, the v0.3 ship-gate harnesses (still gate v0.4 ship), trunk-based branching discipline, the merge-precedence rules.


---

## Chapter 14 — Risks and Spikes

This chapter consolidates every MUST-SPIKE item raised in the preceding chapters, plus residual risks that did not warrant a spike but that the implementer must be aware of. Each MUST-SPIKE has a hypothesis, a validation approach, an explicit kill-criterion (what would force the fallback), and the fallback design. No item is left as "TBD" — every entry has a position.

#### 1. MUST-SPIKE register

Format: each row is reproduced from the chapter that introduced it; this chapter is the single index.

##### 1.1 [win-localservice-uds] — Windows LocalService UDS / named pipe reachability
- **From**: [Chapter 02](#chapter-02--process-topology) §2.1
- **Phase**: blocks phase 0 (transport pick); see [Chapter 13](#chapter-13--release-slicing) §Phase 0 / §Phase 0.5.
- **Hypothesis**: a UDS or named pipe created by LocalService in `%ProgramData%\ccsm\` with explicit DACL granting the interactive user `GENERIC_READ|GENERIC_WRITE` is reachable from a per-user Electron process.
- **Validation (repro recipe)**:
  1. Provision Win 11 25H2 build **26100.2314 or later** (firewall behavior settled by this build); use a fresh Hyper-V VM, no domain join, Defender Firewall at default profile.
  2. Build a stripped daemon stub: `node -e "require('net').createServer(s=>s.end('OK')).listen('\\\\.\\pipe\\ccsm-spike-1.1')"` packaged with `tools/spike-harness/wrap-as-localservice.ps1` (see §4 spike harness) which calls `sc create ccsm-spike binPath= "<path>" obj= "NT AUTHORITY\LocalService" type= own start= demand` and `sc sdset ccsm-spike "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"`.
  3. Set the pipe DACL via `tools/spike-harness/set-pipe-dacl.ps1` to SDDL `D:(A;;GA;;;SY)(A;;GRGW;;;IU)`.
  4. Start service (`sc start ccsm-spike`); from a non-admin interactive session run `tools/spike-harness/connect-and-peercred.js \\.\pipe\ccsm-spike-1.1`.
  5. Assert: client receives `OK`; harness's `GetNamedPipeClientProcessId` + `OpenProcessToken` resolves to the interactive user's SID, NOT `S-1-5-19` (LocalService).
- **Kill-criterion**: connect fails (any error) OR peer-cred returns LocalService's SID instead of the caller's OR the harness reports the caller as `SYSTEM`.
- **Fallback**: bind to `127.0.0.1:<ephemeral-port>` and write port to a user-readable file in `%LOCALAPPDATA%\ccsm\port`; combine with peer-cred via `GetExtendedTcpTable` + PID mapping. Loses native peer-cred fidelity (race window between accept and PID lookup); acceptable on a single-user dev machine.

##### 1.2 [macos-uds-cross-user] — macOS UDS cross-user reachability
- **From**: [Chapter 02](#chapter-02--process-topology) §2.2
- **Hypothesis**: `/var/run/ccsm/daemon.sock` with group ACL is reachable from per-user Electron without granting Full Disk Access.
- **Validation**: clean macOS 14+ install, run installer, log in as second user, launch Electron, attempt connect.
- **Kill-criterion**: connect refused with EACCES OR System Integrity Protection blocks the path.
- **Fallback**: per-user UDS at `~/Library/Containers/com.ccsm.electron/Data/ccsm.sock` proxied by a launchd per-user agent. Adds a per-user agent (was not in v0.3 scope); preserves UDS semantics. Escalate to user before adopting.

##### 1.3 [loopback-h2c-on-25h2] — Win 11 25H2 loopback HTTP/2 cleartext
- **From**: [Chapter 03](#chapter-03--listeners-and-transport) §4
- **Hypothesis**: `http2.createServer({ allowHTTP1: false })` on `127.0.0.1` works under Win 11 25H2 with default Defender Firewall.
- **Validation**: 25H2 VM, daemon as LocalService, Electron as user, 1-min smoke (Hello + 100 unary RPCs + a server-stream of 10k events).
- **Kill-criterion**: connection refused OR p99 RTT > 50 ms loopback OR stream truncation.
- **Fallback (primary)**: A4 — h2 over named pipe (separate spike [win-h2-named-pipe]). **Fallback (secondary)**: A3 — h2 over TLS+ALPN with per-install self-signed cert in `%PROGRAMDATA%\ccsm\listener-a.crt`, trusted by Electron explicitly via Connect transport's `tls` option (NOT installed in OS root store).

##### 1.4 [uds-h2c-on-darwin-and-linux] — UDS HTTP/2 with Node 22
- **From**: [Chapter 03](#chapter-03--listeners-and-transport) §4
- **Hypothesis**: Node 22's `http2.connect` can use a UDS via `createConnection: () => net.createConnection(udsPath)`; full Connect-RPC traffic works.
- **Validation**: 1-hour soak running ship-gate (c) workload over UDS.
- **Kill-criterion**: any disconnect / corruption / stream stall not attributable to test setup.
- **Fallback**: A2 — h2c over loopback TCP on the OS where it fails; OS-asymmetric is acceptable (descriptor-mediated).

##### 1.5 [win-h2-named-pipe] — Windows named pipe + h2
- **From**: [Chapter 03](#chapter-03--listeners-and-transport) §4
- **Hypothesis**: Node 22 `http2.createServer` on a `net.Server` bound to a Windows named pipe works for Connect-RPC.
- **Validation**: 25H2 VM, full integration suite over named pipe.
- **Kill-criterion**: stream stalls under load OR API rejects pipe handle.
- **Fallback**: A2 with PID-based peer-cred synthesis (per [Chapter 03](#chapter-03--listeners-and-transport) §5).

##### 1.6 [renderer-h2-uds] — RESOLVED (no spike needed)

<!-- F2: closes R5 P1-14-2 / R0 08-P0.3 / R4 P0 ch 14 — transport bridge spike resolved: bridge ships unconditionally per chapter 08 §4.2; renderer-h2-uds is no longer a MUST-SPIKE. -->

- **From**: [Chapter 08](#chapter-08--electron-client-migration) §4
- **Status**: **RESOLVED — no spike needed**. Decision (locked across chapters 08 + 14 + 15): the Electron renderer transport bridge ships unconditionally in v0.3 on every OS. Chromium fetch cannot use UDS / named pipe; the bridge speaks loopback TCP to the renderer and forwards Connect to whatever Listener A transport the daemon picked. See [Chapter 08](#chapter-08--electron-client-migration) §4.2 for the full bridge spec. The "ship vs. spike" indecision that spanned chapter 08 §4 + chapter 14 §1.6 + chapter 15 §4 item 9 is now a single locked decision; reviewers do not need to audit a spike outcome here.
- **v0.4**: web client uses `connect-web` directly; iOS client uses `connect-swift` directly. Neither goes through the bridge — [Chapter 15](#chapter-15--zero-rework-audit) §3 forbidden-pattern forbids modifying the bridge for web/iOS reasons.

##### 1.7 [child-process-pty-throughput] — PTY child-process keeps up
- **From**: [Chapter 06](#chapter-06--pty-snapshot--delta) §1 (renamed from `[worker-thread-pty-throughput]` after F3 picked the per-session `child_process` boundary; F10 phase 4.5 references this id).
- **Phase**: blocks phase 5 (PTY); see [Chapter 13](#chapter-13--release-slicing) §Phase 4.5.
- **Hypothesis**: a Node 22 `child_process` per session running `node-pty` + `xterm-headless` and an IPC channel back to the daemon ingests claude's burstiest output (≥ 2 MB initial code-block dump) without dropping or coalescing-with-loss when received in the daemon main process.
- **Validation (repro recipe)**:
  1. Workload classes (reuse [Chapter 06](#chapter-06--pty-snapshot--delta) §8 enumeration verbatim — do NOT invent new classes here): (W1) ASCII-heavy code dump 50 MB / 30s, (W2) heavy SGR colour churn 20 MB / 30s, (W3) alt-screen TUI (htop-replay corpus) 10 MB / 60s, (W4) DECSTBM scroll-region churn 10 MB / 30s, (W5) mixed UTF-8/CJK + combiners 5 MB / 30s, (W6) resize-during-burst (SIGWINCH every 500ms during W1).
  2. Use `tools/spike-harness/pty-emitter.js` to drive each workload through `node-pty` spawn of `bash -c 'cat <fixture>'` (mac/linux) or `cmd /c type <fixture>` (Windows).
  3. Use `tools/spike-harness/delta-collector.js` on the daemon side to capture every delta frame; assert (a) `seq` is contiguous (no gaps), (b) the concatenation of delta byte-payloads equals the SHA256 of the input fixture, (c) the child's xterm-headless `Terminal` final state SnapshotV1 byte-equals a reference snapshot generated by re-feeding the fixture into a fresh xterm-headless instance.
  4. Run each workload 3× back-to-back in the same child process (exercise reuse + GC); the kill criterion applies across all 18 runs.
- **Kill-criterion**: any byte loss (SHA mismatch in (b)) OR any `seq` gap OR snapshot byte-mismatch in (c) OR the child process RSS grows monotonically across the 3 reuses (>20% per cycle).
- **Fallback (real design rework, no escalation needed for go/no-go)**: tighten the segmentation cadence (16 ms / 16 KiB → 8 ms / 8 KiB) and apply zstd compression to delta payloads on the IPC channel (snapshots are already zstd-compressed per §2). If still failing, switch the IPC transport between child and daemon from `process.send` (V8-serialized) to a UDS / named-pipe with framed binary protocol; this is an additive optimization (no proto change). Rework cost: ~2 days; ship-gate (c) unaffected.

##### 1.8 [snapshot-roundtrip-fidelity] — SnapshotV1 encode → decode → encode is byte-identical
- **From**: [Chapter 06](#chapter-06--pty-snapshot--delta) §2
- **Phase**: blocks phase 5 (PTY); see [Chapter 13](#chapter-13--release-slicing) §Phase 4.5.
- **Hypothesis**: SnapshotV1 encoded from xterm-headless state X, decoded into a fresh xterm-headless instance Y, re-encoded, produces byte-identical SnapshotV1.
- **Validation (repro recipe)**:
  1. Corpus sources (combine; no random uint8 alphabet — that produces ~0% useful sequences):
     - (C1) the xterm.js upstream test fixture corpus at `xterm/test/data/*.in.txt` (covers SGR / cursor / DECSTBM / charset / mouse).
     - (C2) hand-crafted grammar at `tools/spike-harness/vt-grammar.js`: weighted generator producing valid CSI / OSC / DCS sequences with parameter ranges sampled from the `xterm-parser-spec` table; 1000 sequences each of lengths 16, 256, 4096 bytes.
     - (C3) replay corpus from [Chapter 06](#chapter-06--pty-snapshot--delta) §8 workload classes (W1–W6 above).
  2. For each input s in C1 ∪ C2 ∪ C3: build xterm-headless `Terminal` X, feed s, encode → snap1; decode snap1 into fresh `Terminal` Y, encode Y → snap2; assert `Buffer.compare(snap1, snap2) === 0`.
  3. Use `tools/spike-harness/snapshot-roundtrip.spec.ts` as the property runner (fast-check or custom).
- **Kill-criterion**: any byte difference attributable to encoding loss on any input from C1 ∪ C2 ∪ C3.
- **Fallback (real design rework)**: lower SnapshotV1 contract to "rendered text + cursor position + per-cell foreground/background/bold/italic/underline match"; drop the (a) palette ordering invariant and (b) `modes_bitmap` fidelity from the contract; add `Snapshot.fidelity_class` enum (`STRICT_BYTE` vs `RENDERED_EQUIVALENT`) to the proto; daemon advertises the fidelity it shipped via `Hello.snapshot_fidelity`. Ship-gate (c) downgrades to `RENDERED_EQUIVALENT` mode (acceptable: dogfood metric (c) is "session feels intact after re-attach", not strict bytewise replay). Rework cost: ~3 days; [Chapter 15](#chapter-15--zero-rework-audit) §3 forbidden-pattern "SnapshotV1 binary layout locked" remains intact because the on-wire layout is unchanged — only the semantic contract weakens.

##### 1.9 [better-sqlite3-in-sea] — better-sqlite3 inside Node 22 sea
- **From**: [Chapter 07](#chapter-07--data-and-state) §1, [Chapter 10](#chapter-10--build-package-installer) §1
- **Hypothesis**: better-sqlite3 (`.node` binary) can be embedded in a Node 22 sea blob and loaded.
- **Validation**: build sea per OS, run `new Database(":memory:")` smoke.
- **Kill-criterion**: load throws OR sea blob does not include the .node file (likely; sea cannot embed natives).
- **Fallback (default expected)**: ship `better-sqlite3.node` alongside the sea executable in `native/`; `require()` via absolute path computed from `process.execPath` (per [Chapter 10](#chapter-10--build-package-installer) §2).

##### 1.10 [sea-on-22-three-os] — Node 22 sea works on win/mac/linux
- **From**: [Chapter 10](#chapter-10--build-package-installer) §1
- **Phase**: blocks phase 10 (build); see [Chapter 13](#chapter-13--release-slicing) §Phase 9.5.
- **Hypothesis**: `node --experimental-sea-config` + `postject` produces a working single binary on Win 11 25H2, macOS 14 (arm64+x64), Ubuntu 22.04.
- **Validation (repro recipe)** — runs in phase 0 BEFORE phase 1 proto exists, so the hello-world is proto-free:
  1. Source: `tools/spike-harness/sea-hello/` containing a single `index.js`: `require('net').createServer(s=>s.end('OK\n')).listen(0,()=>{const a=process.argv[1];require('fs').writeFileSync(a,JSON.stringify({port:server.address().port}));})`. The harness binds an ephemeral TCP port (no Listener-A code, no proto, no peer-cred — those depend on phase 1+) and writes the port to a path passed as argv.
  2. `sea-config.json`: `{ "main": "index.js", "output": "sea-prep.blob", "disableExperimentalSEAWarning": true }`.
  3. Build per OS: `node --experimental-sea-config sea-config.json` → `npx postject <node-binary-copy> NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 [--macho-segment-name NODE_SEA on macOS]` → strip + sign (codesign mac, signtool win, no-op linux).
  4. Smoke: run binary with `<tmp>/port.json` argv; `curl http://127.0.0.1:<port>/` returns `OK`; binary exits cleanly when sent SIGTERM (loopback connect succeeds → script's `server.close()` fires).
  5. Targets: Win 11 25H2 build 26100.2314+ (x64), macOS 14.5 (arm64 AND x64 separate builds), Ubuntu 22.04 LTS (x64). Each target runs the smoke 3× (cold + 2 warm).
- **Kill-criterion**: build fails OR binary exits non-zero OR loopback smoke fails OR runtime crash on any target.
- **Fallback**: switch to `pkg` (Vercel; maintenance mode); second fallback is a plain `node + bundle.js + node_modules/` zip with launcher script (loses single-file but ships); pin source-build CI budget bump to **<+5 min** per OS for the zip variant. See [Chapter 10](#chapter-10--build-package-installer) §1 cross-link to fallback options.

##### 1.11 [node-pty-22] — node-pty on Node 22 ABI
- **From**: [Chapter 10](#chapter-10--build-package-installer) §2
- **Hypothesis**: node-pty builds against Node 22 ABI on all six matrix combos.
- **Validation**: prebuildify in CI; smoke-spawn `bash` / `cmd.exe` and read 1 KB.
- **Kill-criterion**: build fails OR PTY behaves incorrectly on any target.
- **Fallback**: pin to known-good Node 22 LTS minor; if a target is broken, ship a `child_process` fallback for that OS only with a feature flag — would weaken ship-gate (c) on that OS — escalate before adopting.

##### 1.12 [better-sqlite3-22-arm64] — better-sqlite3 prebuilds on darwin-arm64 / linux-arm64
- **From**: [Chapter 10](#chapter-10--build-package-installer) §2
- **Hypothesis**: prebuilds exist on Node 22 ABI for darwin-arm64 and linux-arm64.
- **Validation**: install in CI matrix, open `:memory:`, run a CREATE+INSERT+SELECT.
- **Kill-criterion**: prebuilds missing AND source build fails in CI.
- **Fallback**: build from source in CI per target; bumps build time; acceptable.

##### 1.13 [macos-notarization-sea] — macOS notarization of a sea binary
- **From**: [Chapter 10](#chapter-10--build-package-installer) §3
- **Phase**: blocks phase 10 (build/notarization); see [Chapter 13](#chapter-13--release-slicing) §Phase 9.5 — and ops prereq blocks phase 0.
- **Hypothesis**: a Node sea binary passes Apple notarization with hardened runtime + JIT entitlement.
- **Ops prereq (must be in place by phase 0, NOT phase 10)**: Apple Developer ID Application certificate provisioned in the project Apple Developer team; certificate + private key installed in the macOS notarization runner's keychain (CI self-hosted mac runner OR a designated maintainer's machine); `notarytool` API key (or app-specific password) stored in `~/.zsh-secrets/ccsm-notarytool.env` (operator-managed, NOT in repo). Pin the prereq owner in [Chapter 11](#chapter-11--monorepo-layout) §6 (CI matrix); spike cannot start until prereq closed.
- **Validation (repro recipe)**:
  1. Build the §1.10 hello-world sea on macOS 14.5 arm64.
  2. Sign: `codesign --sign "Developer ID Application: <team-name> (<team-id>)" --options runtime --entitlements tools/spike-harness/entitlements-jit.plist --timestamp <binary>`. Entitlements file MUST grant `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory` (Node JIT).
  3. Zip: `ditto -c -k --keepParent <binary> hello-sea.zip`.
  4. Submit: `xcrun notarytool submit hello-sea.zip --keychain-profile ccsm-notarytool --wait`.
  5. On success: `xcrun stapler staple <binary>`; assert `xcrun stapler validate <binary>` returns `The validate action worked!`; assert `spctl --assess --type execute -vv <binary>` returns `accepted, source=Notarized Developer ID`.
- **Kill-criterion**: notarization rejected (any reason; capture and pin the rejection log path) OR stapler / spctl fails post-staple.
- **Fallback**: revert to a notarized .app bundle wrapping a non-sea `node + bundle.js + node_modules/`; loses single-file shape on macOS only. See [Chapter 10](#chapter-10--build-package-installer) §1 / §3 cross-link for the bundle variant.

##### 1.14 [msi-service-install-25h2] — WiX 4 service install on 25H2
- **From**: [Chapter 10](#chapter-10--build-package-installer) §5.1
- **Hypothesis**: WiX 4 `<ServiceInstall>` for a sea binary works on Win 11 25H2 with proper SDDL.
- **Validation**: build MSI, install on clean 25H2 VM, verify `Get-Service ccsm-daemon` shows Running.
- **Kill-criterion**: service install fails OR ACL on binary blocks LocalService.
- **Fallback**: PowerShell `New-Service` from a custom action with SDDL programmatically applied via `sc.exe sdset`.

##### 1.15 [watchdog-darwin-approach] — REMOVED from MUST-SPIKE register

<!-- F11: closes R4 P0 ch 14 — accepted-non-feature, not a spike. Coordination note for F6 (chapter 09 owner): please add to chapter 09 §6 a sentence "macOS hang detection (active liveness probe) is deferred to v0.4 hardening; v0.3 ships with launchd `KeepAlive=Crashed` only, which catches process exits but not hangs." -->

- **Status**: **DEFERRED to v0.4 hardening; not a v0.3 must-spike.** The original framing combined two mechanisms (launchd `KeepAlive=Crashed` + periodic in-daemon self-check) with a fallback of "live without watchdog on macOS in v0.3" — i.e. the spike outcome did not gate ship. v0.3 ships on macOS with launchd `KeepAlive=Crashed` only (catches process exits, not hangs). A hung daemon on macOS in v0.3 leaves the user in the "daemon unreachable" UX path ([Chapter 08](#chapter-08--electron-client-migration) §6 modal: "ccsm daemon is not running. Try restarting the service."). v0.4 hardening will introduce an active liveness probe (Supervisor `/healthz` poll + restart) — that work will get its own spike entry in the v0.4 register (see §4 below).
- **Cross-chapter**: [Chapter 09](#chapter-09--crash-collector) §6 documents the v0.3 macOS posture; [Chapter 13](#chapter-13--release-slicing) does NOT have a phase blocking on this spike anymore.

##### 1.16 [msi-tooling-pick] — WiX 4 vs electron-builder MSI builder
- **From**: [Chapter 10](#chapter-10--build-package-installer) §5.1 (cross-ref F9 R5 P1-10-1).
- **Phase**: blocks phase 10 (Win installer); see [Chapter 13](#chapter-13--release-slicing) §Phase 9.5.
- **Hypothesis**: WiX 4 (standalone, invoked from Node via `@wixtoolset/wix` or `wix.exe`) produces a smaller, more controllable MSI than `electron-builder`'s built-in MSI target for our daemon-only (non-Electron-bundled) install scenario; both can express `<ServiceInstall>` with custom SDDL.
- **Validation (repro recipe)**:
  1. Build the §1.10 sea hello-world; produce two MSIs from the same payload — one via `wix build installer.wxs` (with `<ServiceInstall>` + `<util:PermissionEx>`), one via `electron-builder --win msi` driven by a minimal `electron-builder.yml` that points at the sea binary.
  2. Install each on a fresh Win 11 25H2 26100.2314+ VM (clean snapshot per run); verify `Get-Service ccsm-daemon` shows `Running`; verify `(Get-Acl <binary>).Sddl` matches the expected SDDL.
  3. Compare: MSI size, install time, uninstall residue (file/registry diff via `tools/spike-harness/install-residue-diff.ps1`), ability to express custom SDDL on the binary directly (not via post-install `sc sdset`).
- **Kill-criterion**: WiX 4 build fails on CI runner OR cannot express the SDDL declaratively OR uninstall leaves residue beyond the documented allowlist; in that case the pick is `electron-builder`. If both fail (cannot express SDDL declaratively), fall back to MSI + post-install custom action via `sc.exe sdset` (covered in §1.14).
- **Fallback**: pick `electron-builder --win msi` and apply SDDL via the post-install custom action mechanism specified in §1.14.

#### 1.A Per-OS transport decision matrix (filled after spikes 1.1–1.5 land)

The transport spikes (§1.1, §1.3, §1.4, §1.5) are independent in framing but compose into one shippable per-OS pick. After all four resolve, this table gets filled in (one row per OS) before phase 1 starts; reviewers cross-check that the row is filled and self-consistent.

| OS | Listener-A transport pick | Descriptor `transport` value | Installer steps required (delta vs default) | Provisioning owner |
| --- | --- | --- | --- | --- |
| Windows 11 25H2 (x64) | A4 (named pipe) if §1.5 passes, else A1 (UDS) if §1.1 passes, else A3 (h2 over TLS+ALPN on loopback TCP) if §1.3 fallback fires, else A2 (h2c loopback) — pin order **A4 → A1 → A2 → A3** per [Chapter 03](#chapter-03--listeners-and-transport) §4 | `KIND_NAMED_PIPE` / `KIND_UDS` / `KIND_TCP_LOOPBACK_H2_TLS` / `KIND_TCP_LOOPBACK_H2C` (closed-set, locked by F2) | A3 only: WiX `<Component>` ships per-install self-signed cert + `installer-cert-gen.ps1` writes `%PROGRAMDATA%\ccsm\listener-a.crt`; Electron Connect transport's `tls` option pins fingerprint (NOT installed in OS root store) | Installer custom action |
| macOS 14+ (arm64 + x64) | A1 (UDS at SIP-safe path `/var/run/com.ccsm.daemon/daemon.sock`) if §1.4 passes, else A2 (h2c loopback) — A3 not used on macOS in v0.3 | `KIND_UDS` / `KIND_TCP_LOOPBACK_H2C` | A1 only: pkg postinstall script `mkdir -p /var/run/com.ccsm.daemon` (recreated on boot via launchd `RuntimeDirectory` analog, see [Chapter 02](#chapter-02--process-topology) §2.2) | pkg postinstall |
| Linux (Ubuntu 22.04+ x64) | A1 (UDS at `/run/ccsm/daemon.sock`) if §1.4 passes, else A2 (h2c loopback) | `KIND_UDS` / `KIND_TCP_LOOPBACK_H2C` | A1 only: systemd unit `RuntimeDirectory=ccsm` + `RuntimeDirectoryMode=0750` (covered by F5 [Chapter 07](#chapter-07--data-and-state)) | systemd unit (in deb/rpm) |

If a row's spike outcome forces A3 (TLS) on Windows, the descriptor schema additions are the cert path and the SHA256 fingerprint (additive `cert_path` + `cert_sha256` fields on the descriptor; the `transport == "KIND_TCP_LOOPBACK_H2_TLS"` value gates whether they are read). All values are part of the closed-set `transport` enum locked by F2; no new enum values are added later.

#### 1.B Spike harness — `tools/spike-harness/`

All spike repro recipes above reference scripts under a single `tools/spike-harness/` directory pinned in this spec. The harness is a v0.3 build artifact (lives in the monorepo at `tools/spike-harness/`, NOT in `packages/`); its contents are forever-stable in the sense that v0.4 spikes can extend (additive scripts) but MUST NOT remove or change the contract of an existing script. Required contents:

- `wrap-as-localservice.ps1` — wraps any `.exe` as a Windows service running under `NT AUTHORITY\LocalService` with caller-supplied SDDL. Used by §1.1.
- `set-pipe-dacl.ps1` — applies an SDDL string to a named-pipe handle. Used by §1.1.
- `connect-and-peercred.js` — connects to a UDS or named pipe, prints the resolved peer SID/UID. Used by §1.1, §1.4, §1.5.
- `pty-emitter.js` — drives the W1–W6 workload classes from [Chapter 06](#chapter-06--pty-snapshot--delta) §8 through `node-pty`. Used by §1.7.
- `delta-collector.js` — daemon-side collector asserting `seq` contiguity + SHA-equal payload concatenation. Used by §1.7.
- `vt-grammar.js` — weighted CSI/OSC/DCS sequence generator. Used by §1.8.
- `snapshot-roundtrip.spec.ts` — property runner for the SnapshotV1 round-trip. Used by §1.8.
- `sea-hello/` — proto-free hello-world for the sea / notarization spikes. Used by §1.10, §1.13.
- `entitlements-jit.plist` — macOS hardened-runtime entitlements with JIT allowance. Used by §1.13.
- `install-residue-diff.ps1` — pre/post install file-tree + registry diff with allowlist. Used by §1.16 (and [Chapter 12](#chapter-12--testing-strategy) ship-gate (d)).
- `rtt-histogram.js` — HTTP/2 unary p50/p95/p99 RTT histogram (loopback or UDS). Used by §1.3, §1.4, §1.5.
- `stream-truncation-detector.js` — server-stream consumer that asserts no truncation under a configurable rate. Used by §1.3, §1.4, §1.5.

Cross-link: [Chapter 11](#chapter-11--monorepo-layout) §2 / §6 references `tools/spike-harness/` as a pinned source path; [Chapter 12](#chapter-12--testing-strategy) §3 reuses `install-residue-diff.ps1` for ship-gate (d).

#### 2. Residual risks (no spike, but flagged)

| Risk | Mitigation |
| --- | --- |
| Connect-es / Connect-node version churn between v0.3 freeze and v0.4 | pin exact versions in `pnpm-lock.yaml`; vendor type definitions if needed |
| xterm-headless API changes mid-v0.3 | pin minor; track upstream; SnapshotV1 codec is independent of xterm internals where it matters (we read its public state API) |
| `claude` CLI argv / stdio contract changes (out of our control) | session record stores `claude_args_json`; on contract change, daemon migration step rewrites recorded args additively |
| Win 11 25H2 fast-ring updates regress firewall behavior | nightly installer-roundtrip catches; rollback is uninstall + downgrade VM image |
| User runs Electron + daemon mismatched versions during update | `Hello.proto_min_version` enforces explicit error with update prompt (per [Chapter 08](#chapter-08--electron-client-migration) §6) |
| Disk full → SQLite write fails → session state corruption | write coalescer wraps in try/catch; failure → crash_log entry (best-effort) + session state degraded; reads continue from last good row |

#### 3. Spike outputs feed the spec

Spike outcomes that change a chapter's design MUST be reflected by a chapter edit before the impl PR for that area lands. Reviewers (stage 2 of the spec pipeline) MUST cross-check that every MUST-SPIKE in this chapter is either (a) explicitly marked unresolved (acceptable for spike-pending phases) or (b) reflected as a definitive choice in the corresponding chapter section.

#### 4. v0.4 delta

- **Add** new MUST-SPIKE register entries for v0.4 items (cloudflared lifecycle, JWT validator perf, web Connect transport over CF Tunnel, iOS connect-swift TLS pinning, etc.) — additive list extension.
- **Unchanged**: every v0.3 spike outcome, the residual risk list (still applies), the cross-check discipline.


---

## Chapter 15 — Zero-Rework Audit

This is the gate. For every locked decision in `00-brief.md` and every concrete design choice in chapters 02-14, this chapter answers the question:

> When v0.4 lands web client + iOS client + Cloudflare Tunnel + cloudflared sidecar + CF Access JWT validation on Listener B, what code/proto/schema/installer changes are required?

Acceptable answers: **none** / **purely additive** (specify what is added). Unacceptable: **rename X** / **change message Y shape** / **move file Z** / **split function into two**. Any unacceptable answer below is a hard block on v0.3 ship; the corresponding chapter MUST be re-designed before merge. Reviewers SHOULD treat this chapter as the single document they audit against.

#### 1. Audit table — locked decisions from `00-brief.md`

| # | Locked decision (brief) | v0.4 delta | Verdict |
| --- | --- | --- | --- |
| §1 | Listener trait + 2-slot array; Listener B reserved as stub slot | Fill slot 1 by removing `throw` from `makeListenerB` and uncommenting one line in startup. NEW module `jwt-validator.ts` ADDED to authChain. Listener trait, array shape, slot-0 (Listener A) untouched. | **additive** |
| §2 | Listener A protocol = HTTP/2; transport pick is MUST-SPIKE per OS | Same HTTP/2 stack on Listener B (loopback TCP for cloudflared consumer); descriptor file gains `listener-b.json`. Listener A descriptor and transport: unchanged. | **additive** |
| §3 | Electron migration is big-bang; `lint:no-ipc` gate enforced | Web/iOS are net-new packages, not migrations. `lint:no-ipc` gate continues to run in v0.4 unchanged. | **none** |
| §4 | PTY xterm-headless emits snapshot AND delta; delta schema locked | New web/iOS clients call same `PtyService.Attach`; daemon broadcasts to N subscribers (already supported). Snapshot/delta wire formats forever-stable; SnapshotV1 ships zstd-compressed in v0.3 (codec is part of v1, see [Chapter 06](#chapter-06--pty-snapshot--delta) §2); v0.4 may add new codec values inside the `codec` byte without bumping `schema_version`. `AckPty` RPC ([Chapter 04](#chapter-04--proto-and-rpc-surface) §4) ships in v0.3 so high-latency v0.4 clients get reliable ack-driven flow control with no proto change. | **additive** |
| §5 | Session bound to `Principal` (`owner_id`) from day one; v0.3 only `local-user` from peer-cred | New `cf-access:<sub>` principal kind ADDED as new oneof variant + new middleware on Listener B. `principalKey` format unchanged. `Session.owner_id` column unchanged. `assertOwnership` unchanged (still string compare). | **additive** |
| §6 | Proto scope: forever-stable existing messages; only additive in v0.4 | New RPCs / messages ADDED in new files OR appended to existing services with new field numbers. `buf breaking` gate enforces. | **additive** |
| §7 | Daemon = system service per OS; survives logout (LaunchDaemon, not LaunchAgent) | LaunchDaemon choice already supports v0.4 web/iOS reaching daemon while user logged out. No service shape change. cloudflared subprocess ADDED to daemon supervision. | **additive** |
| §8 | Monorepo `packages/{daemon, electron, proto}`; pnpm + Turborepo | ADD `packages/web`, `packages/ios`, optionally `packages/cloudflared-config`. Existing packages unchanged. Workspace tool unchanged. | **additive** |
| §9 | Node 22 sea single binary per OS; native deps via `native/` sidecar | sea pipeline unchanged; `native/` may grow if v0.4 needs new natives (currently doesn't — JWT validation is pure JS via `jose`). cloudflared is **NOT** bundled in v0.3 installer dir; v0.4 daemon downloads cloudflared at runtime into the per-OS state directory and supervises it (see [Chapter 02](#chapter-02--process-topology) §7 v0.4 delta). The Node 22 sea pipeline is therefore untouched. | **none** |
<!-- F8: closes R5 P0-15-1 — disambiguates the prior "none-or-additive" cell to a single verdict by locking the cloudflared-downloaded-at-runtime decision (not bundled by installer). -->

<!-- F1: closes R0 15-P0.1 / R0 15-P0.2 — audit verdicts revised; v0.3 ships scoping baseline so v0.4 add is row-additive, not column-additive. -->
| §10 | Crash collector local-only; SQLite log table; `GetCrashLog` RPC | `CrashEntry.owner_id` field, `crash_log.owner_id NOT NULL` column with `'daemon-self'` sentinel, and `OwnerFilter` enum all SHIPPED in v0.3 ([Chapter 04](#chapter-04--proto-and-rpc-surface) §5, [Chapter 07](#chapter-07--data-and-state) §3, [Chapter 09](#chapter-09--crash-collector) §1). v0.4 ADDS only `crash_log.uploaded_at` column + `CrashService.UploadCrashLog` RPC + upload UI; populates the existing `owner_id` with cf-access principalKeys. No backfill, no semantic flip. | **additive** |
| §11(a) | Ship-gate: zero IPC residue grep | v0.4 still gates on the same grep. | **none** |
| §11(b) | Ship-gate: daemon survives Electron SIGKILL | Same harness; v0.4 also runs analogous "daemon survives web client tab close" harness as ADDITIVE. | **additive** |
| §11(c) | Ship-gate: 1-hour PTY zero-loss | Same harness; v0.4 may add a CF Tunnel variant additively. | **additive** |
| §11(d) | Ship-gate: clean Win 11 25H2 installer round-trip | Same harness; cloudflared install/uninstall added to checklist additively. | **additive** |

**No unacceptable verdicts.** All locked decisions admit purely additive v0.4 deltas.

#### 2. Audit table — derived design choices (chapters 02-14)

| Source | Design choice | v0.4 delta | Verdict |
| --- | --- | --- | --- |
| [Chapter 02 §2.1](#chapter-02--process-topology) | Win Service runs as LocalService, not LOCAL_SYSTEM | unchanged; v0.4 web/iOS reach via cloudflared bound to loopback (no new privilege need) | **none** |
| [Chapter 02 §2.2](#chapter-02--process-topology) | macOS picks LaunchDaemon over LaunchAgent | unchanged | **none** |
| [Chapter 02 §3](#chapter-02--process-topology) | Startup order step 5 binds Listener A and instantiates listener slot array | step 5 ADDS slot-1 instantiation (one-line addition); ordering unchanged | **additive** |
| [Chapter 02 §4](#chapter-02--process-topology) | Electron quit does NOT terminate sessions | unchanged; same contract for web tab close | **none** |
| [Chapter 03 §1](#chapter-03--listeners-and-transport) | Fixed-length 2-slot listener array | filled, not reshaped | **additive** |
| [Chapter 03 §2](#chapter-03--listeners-and-transport) | Listener A authChain `[peerCred, jwtBypassMarker]` | Listener B authChain `[jwtValidator]` (different listener; A unchanged) | **additive** |
| [Chapter 03 §3](#chapter-03--listeners-and-transport) | `listener-a.json` descriptor file with `version: 1` | new fields (if needed) added; existing fields unchanged | **additive** |
| [Chapter 03 §4](#chapter-03--listeners-and-transport) | Per-OS transport pick (h2c-uds / h2c-loopback / etc.) | Listener B picks loopback TCP independently; A unchanged | **additive** |
| [Chapter 03 §6](#chapter-03--listeners-and-transport) | v0.3 ships NO `listener-b.ts` file; slot 1 holds the typed `RESERVED_FOR_LISTENER_B` sentinel | v0.4 adds a brand-new `listener-b.ts` file (purely additive new file) plus a one-line edit at the startup site (sentinel write becomes `makeListenerB(env)`) plus a new `jwt-validator.ts` module | **additive** |
| [Chapter 03 §7](#chapter-03--listeners-and-transport) | Supervisor UDS: `/healthz`, `hello`, `shutdown` HTTP | unchanged | **none** |
| [Chapter 04 §2](#chapter-04--proto-and-rpc-surface) | `Principal` oneof; `LocalUser` shape | ADD `CfAccess` variant; `LocalUser` unchanged | **additive** |
| [Chapter 04 §2](#chapter-04--proto-and-rpc-surface) | `RequestMeta`, `ErrorDetail`, `SessionState` enum | unchanged forever | **none** |
| [Chapter 04 §3-6](#chapter-04--proto-and-rpc-surface) | every RPC and message | new RPCs / fields ADDED; existing untouched | **additive** |
| [Chapter 04 §8](#chapter-04--proto-and-rpc-surface) | additivity contract enforced via `buf breaking` | enforced in v0.4 too | **none** |
| [Chapter 05 §1](#chapter-05--session-and-principal) | `principalKey` format `kind:identifier` | new `cf-access:<sub>` keys; format unchanged | **additive** |
| [Chapter 05 §4](#chapter-05--session-and-principal) | `assertOwnership` early return | gains optional admin clause; existing logic unchanged | **additive** |
| [Chapter 05 §5](#chapter-05--session-and-principal) | Crash log + Settings principal-scoped from v0.3 day one (`crash_log.owner_id NOT NULL` with `'daemon-self'` sentinel; `settings(scope, key, value)` with `scope='global'`; `OwnerFilter` / `SettingsScope` / `WatchScope` enums on the wire) | v0.4 inserts `crash_log` rows with attributable principalKeys, `settings` rows with `scope='principal:<principalKey>'`, and starts honoring `OWNER_FILTER_ALL` / `WATCH_SCOPE_ALL` for admin principals. No column add, no table add (the `principal_aliases` table also already ships empty in v0.3). | **additive** |
| [Chapter 05 §5](#chapter-05--session-and-principal) | `claude_binary_path` and other code-execution-controlling keys EXCLUDED from `Settings` proto wire (config-file-only) | v0.4 keeps the same exclusion; if per-user override is ever needed it ships as a separate admin-only `AdminSettingsService` (additive new RPC, not a new field on `Settings`) | **additive / none** |
| [Chapter 05 §7](#chapter-05--session-and-principal) | Restored sessions trust recorded `owner_id` | unchanged | **none** |
<!-- F3: closes R0 15-P1.1 / R0 15-P1.2 / R0 06-P0.1 / R0 06-P0.2 — audit rows revised for the F3-locked PTY child-process boundary and SnapshotV1 zstd-compressed-from-day-one position. -->
| [Chapter 06 §1](#chapter-06--pty-snapshot--delta) | One **child process** per session (`child_process.fork`), NOT a `worker_threads` Worker; main thread coalesces SQLite | unchanged. v0.4 multi-principal can drop privileges per child (additive uid switch at fork time); the process boundary is forever-stable so the v0.4 helper-process model is a no-op extension, not a reshape. | **none** |
| [Chapter 06 §2](#chapter-06--pty-snapshot--delta) | SnapshotV1 binary format with outer `magic="CSS1"`, `codec` byte (1=zstd default, 2=gzip), `schema_version=1` | new codec values added inside `codec` byte (open enum) without bumping `schema_version`; new schemas use `schema_version=2+`; v1 retained forever | **additive** |
| [Chapter 06 §3](#chapter-06--pty-snapshot--delta) | Delta payload = raw VT bytes; segment at 16ms/16KiB | unchanged | **none** |
| [Chapter 06 §4](#chapter-06--pty-snapshot--delta) | Snapshot cadence parameters K/M/B | unchanged; tunable per-session by future per-principal config (additive) | **additive** |
| [Chapter 06 §5](#chapter-06--pty-snapshot--delta) | Reconnect decision tree | unchanged | **none** |
| [Chapter 06 §6](#chapter-06--pty-snapshot--delta) | Multi-attach broadcast | already supports N subscribers; v0.4 web/iOS use unchanged | **none** |
| [Chapter 07 §1](#chapter-07--data-and-state) | better-sqlite3, WAL, NORMAL synchronous | unchanged | **none** |
| [Chapter 07 §2](#chapter-07--data-and-state) | Per-OS state directory paths | unchanged | **none** |
| [Chapter 07 §3](#chapter-07--data-and-state) | All v0.3 tables and columns — including `crash_log.owner_id NOT NULL DEFAULT 'daemon-self'`, `settings(scope, key, value)` composite PK, `principal_aliases` table | new tables and new columns ADDED via new migration files; v0.3 columns retained. v0.4 multi-principal lands as **row inserts** into existing tables, NOT as column or table additions. | **additive** |
| [Chapter 07 §4](#chapter-07--data-and-state) | Migration files immutable post-ship; SHA256 in `locked.ts` | enforced in v0.4 too | **none** |
| [Chapter 07 §6](#chapter-07--data-and-state) | No automated backup in v0.3 | v0.4 adds optional automated backup as additive feature | **additive** |
| [Chapter 08 §3](#chapter-08--electron-client-migration) | IPC → Connect 1:1 mapping table | new RPCs added in v0.4 are wired via new mapping rows (additive); existing mappings unchanged | **additive** |
| [Chapter 08 §4](#chapter-08--electron-client-migration) | Descriptor injected via `additionalArguments`; no `contextBridge` for callable APIs | unchanged; same `lint:no-ipc` gate | **none** |
| [Chapter 08 §6](#chapter-08--electron-client-migration) | Renderer error contract (UNAVAILABLE, FailedPrecondition, etc.) | unchanged | **none** |
| [Chapter 09 §1](#chapter-09--crash-collector) | Capture sources list + `source` open string set + `owner_id` attribution rules (sources are an open set; v0.4 may add freely; `daemon-self` sentinel forever-stable) | new sources added freely; existing unchanged | **additive** |
| [Chapter 09 §2](#chapter-09--crash-collector) | `crash-raw.ndjson` recovery on boot | unchanged | **none** |
| [Chapter 09 §3](#chapter-09--crash-collector) | Rotation caps (10000 / 90 days) | unchanged; user override remains | **none** |
| [Chapter 09 §6](#chapter-09--crash-collector) | Linux watchdog via systemd; mac/win deferred | mac/win watchdog ADDED in v0.4 as hardening | **additive** |
| [Chapter 10 §1](#chapter-10--build-package-installer) | Node 22 sea + esbuild bundle | unchanged | **none** |
| [Chapter 10 §2](#chapter-10--build-package-installer) | Native modules in sibling `native/` dir | unchanged; `native/` may gain more files | **additive** |
| [Chapter 10 §5](#chapter-10--build-package-installer) | Per-OS installer (MSI/pkg/deb/rpm) responsibilities | install/uninstall steps gain optional cloudflared registration | **additive** |
| [Chapter 10 §6](#chapter-10--build-package-installer) | CI build matrix | new jobs for web/iOS ADDED; existing unchanged | **additive** |
| [Chapter 11 §1](#chapter-11--monorepo-layout) | pnpm workspaces + Turborepo | unchanged | **none** |
| [Chapter 11 §2](#chapter-11--monorepo-layout) | `packages/{proto,daemon,electron}` directory layout | ADD `packages/{web,ios}`; existing dirs unchanged | **additive** |
| [Chapter 11 §3](#chapter-11--monorepo-layout) | Workspace dep graph | new leaves ADDED depending on `@ccsm/proto`; existing edges unchanged | **additive** |
| [Chapter 11 §4](#chapter-11--monorepo-layout) | `buf.gen.yaml` outputs TS in v0.3 | ADD go/swift outputs in v0.4 | **additive** |
| [Chapter 11 §5](#chapter-11--monorepo-layout) | Per-package responsibility matrix; ESLint forbidden-imports | applies to v0.4 packages too; rules ADD entries for web/ios; existing rules unchanged | **additive** |
| [Chapter 12 §1-3](#chapter-12--testing-strategy) | Vitest + Playwright; per-package test layout | unchanged; v0.4 packages get their own equivalents | **additive** |
| [Chapter 12 §4](#chapter-12--testing-strategy) | Four ship-gate harnesses | unchanged; v0.4 ADDS ship-gate (e) for tunnel | **additive** |
| [Chapter 12 §5](#chapter-12--testing-strategy) | `claude-sim` test build | unchanged | **none** |
| [Chapter 13 §1-2](#chapter-13--release-slicing) | Phase ordering 0-12 | v0.4 phases stack on top; v0.3 phases unchanged | **additive** |
| [Chapter 13 §3](#chapter-13--release-slicing) | Dependency DAG | extended additively for v0.4 phases | **additive** |
| [Chapter 13 §4](#chapter-13--release-slicing) | Trunk-based + per-PR conventions | unchanged | **none** |
| [Chapter 14 §1](#chapter-14--risks-and-spikes) | MUST-SPIKE register | v0.4 ADDS new entries; existing entries' outcomes baked into v0.3 chapters | **additive** |
<!-- F2: closes R0 03-P0.1 / R0 03-P0.3 / R0 08-P0.3 / R0 15-P1.3 / R5 P0-03-2 / R5 P0-08-1 — three audit rows for listener slot 1 reservation, descriptor boot_id semantics, and renderer transport bridge decision. -->
| [Chapter 03 §1](#chapter-03--listeners-and-transport) | Listener slot 1 reservation pattern (typed `RESERVED_FOR_LISTENER_B` sentinel + ESLint rule + startup assert) | v0.4 instantiates slot 1 with JWT middleware: brand-new `listener-b.ts` module is added (purely additive new file); ESLint rule whitelists that one file as the only writer of `listeners[1]`; the startup-site sentinel write becomes a `makeListenerB(env)` call. Sentinel symbol stays exported (still referenced by tests); slot-1-reservation lint rule stays in force as the v0.4 backstop. | **additive** |
| [Chapter 03 §3](#chapter-03--listeners-and-transport) / [Chapter 07 §2.1](#chapter-07--data-and-state) | Descriptor file `boot_id` semantics (per-boot UUIDv4; atomic write; descriptor-driven verification — file is the witness, `HelloResponse` does NOT echo `boot_id`; orphan files between boots are normal) | v0.4 web/iOS clients DO NOT read `listener-a.json` — they reach Listener B via cloudflared with a separate descriptor file (`listener-b.json`, additive new file). Only Electron uses `listener-a.json` and the `boot_id` mechanism. Schema additions go in NEW top-level fields. A future proto v2 minor MAY add `HelloResponse.boot_id` as additive field 6 for in-band cross-check; v0.3 ships descriptor-only. | **additive** |
| [Chapter 08 §4.2](#chapter-08--electron-client-migration) / [Chapter 14 §1.6](#chapter-14--risks-and-spikes) | Renderer transport bridge in Electron main (ships unconditionally in v0.3) | unchanged (Electron-only); v0.4 web/iOS use connect-web/connect-swift directly without a bridge. Bridge code is forever Electron-internal; chapter 15 §3 forbidden-pattern (item 15 below) forbids modifying it for web/iOS reasons. | **none** |
| [Chapter 03 §7](#chapter-03--listeners-and-transport) | Supervisor UDS-only on every OS (`\\.\pipe\ccsm-supervisor` on Windows; `/var/run/com.ccsm.daemon/supervisor.sock` on macOS; `/run/ccsm/supervisor.sock` on Linux); peer-cred uid/SID is the sole authn | v0.4 cf-access principals MUST NOT reach Supervisor; equivalent functionality for remote callers MUST be a NEW Connect RPC on Listener B with explicit principal authorization. Supervisor surface stays UDS-only forever. | **none** |
| [Chapter 03 §1a](#chapter-03--listeners-and-transport) | `BindDescriptor.kind` and `listener-a.json.transport` unified vocabulary (closed 4-value enum) | v0.4 transport variants ship under NEW descriptor file (`listener-b.json`) with their own enum domain; never as new values in the v0.3 enum. | **additive** |
<!-- F8: closes R5 P1-15-2 — fills the §2 audit-coverage gaps the R5 reviewer enumerated (chapter 02 §1, §5, §6 + chapter 11 §7). Verdicts derived from the chapters' own v0.4 delta sections; the rows are added so the audit table is exhaustive over the chapters' shipped section list. -->
| [Chapter 02 §1](#chapter-02--process-topology) | Process inventory (daemon + Electron renderer/main + claude CLI per session; supervisor UDS endpoint) | v0.4 ADDS new session producers (web client tabs, iOS app instances) that all attach to the same daemon-side `Session` rows over Listener B. Daemon process inventory is unchanged (cloudflared subprocess is supervised additively per §7); claude-CLI-per-session model is unchanged. | **additive** |
| [Chapter 02 §5](#chapter-02--process-topology) | Install / uninstall responsibility table (per-OS service install, state-dir provision, native-deps placement) | v0.4 install steps gain optional cloudflared registration row (also covered by [Chapter 10](#chapter-10--build-package-installer) §5 audit row above). v0.3 rows unchanged; cloudflared lifecycle is additive runtime-download (chapter 02 §7), not an installer-time row. | **additive** |
| [Chapter 02 §6](#chapter-02--process-topology) | Process boundary contract — Electron MUST tolerate UNAVAILABLE / `daemon.starting` ErrorDetail; daemon NEVER terminates sessions on Electron quit | v0.4 web/iOS observe the same contract verbatim; UNAVAILABLE handling and the no-terminate-on-client-disconnect invariant are forever-stable across all client kinds (Electron, web, iOS). | **none** |
| [Chapter 11 §7](#chapter-11--monorepo-layout) | Versioning via Changesets; one tag per release | v0.4 web/ios packages get their own Changesets entries; the single-tag-per-release shape is unchanged (web/iOS ride the same daemon tag via additive Changesets rows, not separate tag namespaces). | **none** |
| [Chapter 04 §3-6](#chapter-04--proto-and-rpc-surface) (post-F1/F3/F6) | Final v0.3 RPC surface — `SessionService.{Watch,Rename,GetTitle,ListProject,ListImportable,Import}`, `PtyService.{Attach,SendInput,Resize,AckPty,CheckClaudeAvailable}`, `CrashService.{Get,Watch,GetRaw}`, `SettingsService.{Get,Update}` (+`OwnerFilter`/`SettingsScope`/`WatchScope` enums), `NotifyService.{Watch,MarkUserInput,SetActiveSid,SetFocused}` | v0.4 ADDS new RPCs / new methods on existing services / new enum values (subject to items 19-24 of §3); existing RPCs and their request/response shapes are forever-stable. The full surface above is the v0.4 inheritance baseline; any rename or removal is an UNACCEPTABLE pattern. | **additive** |
| [Chapter 06 §3](#chapter-06--pty-snapshot--delta) | Per-session delta segmentation cadence (16ms / 16KiB) | v0.4 inherits the same per-session cadence; per-subscriber tuning is forbidden (§3 item 26 below). | **none** |
| [Chapter 12 §7](#chapter-12--testing-strategy) | Listener-A perf budget (SendInput p99, snapshot encode p99, etc.) | v0.4 Listener-A budget is forever-stable; Listener-B sets its own budget rows additively (§3 item 27 below); v0.4 MUST NOT mutate Listener-A rows. | **none** |
<!-- F8: closes dispatch-plan F8 "post-sibling-fixer revalidation" — audit rows for structural sections that landed in chapters 04 / 06 / 10 / 13 / 14 between F1-F3 commit and F8 run (per on-disk re-read). -->
| [Chapter 04 §6.1](#chapter-04--proto-and-rpc-surface) | NotifyService (`WatchNotifyEvents` stream + `MarkUserInput` / `SetActiveSid` / `SetFocused` setters) — daemon owns decider state | v0.4 web/iOS attach to the same NotifyService stream over Listener B; the decider state lives in the daemon so multi-client semantics fall out for free. New event kinds added as enum values on `NotifyEvent.kind` (subject to forbidden-pattern items 19/24). | **none** |
| [Chapter 04 §6.2](#chapter-04--proto-and-rpc-surface) | DraftService (`GetDraft` / `UpdateDraft`) for cross-restart draft persistence | v0.4 web/iOS get the same draft persistence behavior automatically; drafts are server-side, identified by `(owner_id, session_id)`. v0.4 multi-principal lands as row inserts via existing `owner_id` shape (covered by F1's principal-scoping baseline). | **additive** |
| [Chapter 06 §10](#chapter-06--pty-snapshot--delta) | Ship-gate (b)/(c) test inventory — explicit list of `pty/*.spec.ts` files mapped to gate verifiability | v0.4 inherits the same test inventory; new gates (e.g. CF-Tunnel variant) ADD new spec files; existing entries are forever-stable so v0.3-shipped invariants are continuously asserted. | **none** |
| [Chapter 10 §8](#chapter-10--build-package-installer) | Update flow — service-running binary swap (stop with timeout + SIGKILL fallback → replace → restart → rollback on `/healthz` failure) | v0.4 update flow is identical for the daemon binary; cloudflared has its own runtime-download lifecycle (chapter 02 §7 v0.4 delta) and does NOT participate in the v0.3 update flow. | **none** |
| [Chapter 13 §5](#chapter-13--release-slicing) | P0 milestones gate the v0.3 ship | v0.4 stacks its own P0 milestone list on top; v0.3 entries are forever-stable as the ship-quality reference. | **additive** |
| [Chapter 13 §6](#chapter-13--release-slicing) | v0.4 delta section content | self-referential; v0.4 phase ordering described inline as the additive extension of v0.3 phases 0-12. | **additive** |
| [Chapter 14 §1.A](#chapter-14--risks-and-spikes) | Per-OS transport decision matrix (filled after spikes 1.1–1.5 land) | v0.4 ADDS Listener-B rows to the matrix; v0.3 Listener-A rows are forever-stable (cross-references forbidden-pattern item 17 — the transport enum is closed). | **additive** |
| [Chapter 14 §1.B](#chapter-14--risks-and-spikes) | Spike harness (`tools/spike-harness/`) reusable shape | v0.4 spikes use the same harness shape; harness directory and naming conventions are forever-stable. | **none** |

**No unacceptable verdicts.**

#### 3. Forbidden patterns (mechanical reviewer checklist)

When auditing a v0.4 PR, the reviewer MUST reject any of:

1. Removing or renaming any `.proto` field, message, enum value, RPC, or service from [Chapter 04](#chapter-04--proto-and-rpc-surface). _Mechanism: `buf breaking` against the merge-base SHA pre-tag and against the v0.3 release tag post-tag ([Chapter 11](#chapter-11--monorepo-layout) §6 / [Chapter 04](#chapter-04--proto-and-rpc-surface) §8); reserved slots use the protobuf `reserved <number>;` keyword (item 19 below) so accidental re-use of a tag fails `protoc` parse before CI._
2. Reusing a `.proto` field number. _Mechanism: same as item 1 — `buf breaking` + `reserved` keyword ([Chapter 04](#chapter-04--proto-and-rpc-surface) §2 / §8)._
3. Changing the meaning of an existing `.proto` field. _Mechanism: **human review with reference test as smoke check** — semantic intent is not mechanically detectable; `proto/error-detail-roundtrip.spec.ts` and `proto/open-string-tolerance.spec.ts` ([Chapter 12](#chapter-12--testing-strategy)) catch wire-shape regressions but cannot catch a code-side reinterpretation. Reviewers MUST audit any `.proto` comment delta in the same PR as a proto field touch._
4. Modifying any v0.3 SQL migration file (`001_initial.sql`); CI SHA256 lock check enforces. _Mechanism: `db/migration-lock.spec.ts` ([Chapter 12](#chapter-12--testing-strategy)) + a CI step that fetches the v0.3 release tag and asserts the SHA256 of every shipped migration file matches `packages/daemon/src/db/locked.ts` ([Chapter 07](#chapter-07--data-and-state) §4); F5 wires the lock script._
5. Changing the SnapshotV1 binary layout fields/order; the format is `schema_version == 1` and frozen. _Mechanism: `pty/snapshot-codec.spec.ts` + a checked-in golden binary at `packages/daemon/test/fixtures/snapshot-v1-golden.bin`; encoder MUST round-trip the golden byte-for-byte for both `codec=1` (zstd) and `codec=2` (gzip) — [Chapter 06](#chapter-06--pty-snapshot--delta) §2._
6. Reshaping the Listener trait or the listener slot array length / index meanings. _Mechanism: `daemon/listeners/array-shape.spec.ts` asserts `listeners.length === 2`, `listeners[0]` is the Listener-A instance, `listeners[1]` is the typed `RESERVED_FOR_LISTENER_B` sentinel ([Chapter 03](#chapter-03--listeners-and-transport) §1); a TypeScript `as const`-tuple type on the array prevents `.push()` / `.pop()` at compile time; ESLint rule `ccsm/no-listener-slot-mutation` (item 18 below) is the runtime backstop._
7. Renaming `principalKey` format, repurposing existing `kind` values, OR changing the parse rule that the **first** colon (`:`) in `principalKey` is the `kind:value` separator (everything after the first `:` is the opaque `value` field — `value` MAY itself contain colons, e.g. cf-access `sub` claims). [Chapter 05](#chapter-05--session-and-principal) §1 fixes the colon split as `principalKey.indexOf(':')` not split-then-take[0/1]; v0.4 cf-access principals (`cf-access:auth0|abc:def`) MUST round-trip through the same parser without quoting.
8. Changing `listener-a.json` v1 field meanings (additions only). _Mechanism: JSON Schema `listener-a.schema.json` shipped alongside the descriptor writer; `daemon/descriptor/schema.spec.ts` asserts every emitted descriptor validates against the v1 schema; v0.4 schema additions ship as a sibling `listener-a.schema.v2.json` ([Chapter 03](#chapter-03--listeners-and-transport) §3)._
9. Changing the Supervisor HTTP endpoint URLs or response shapes. _Mechanism: `supervisor/contract.spec.ts` table-tests the four endpoints (`/healthz`, `/hello`, `/shutdown`, peer-cred path) against checked-in golden response bodies; [Chapter 03](#chapter-03--listeners-and-transport) §7 + [Chapter 02](#chapter-02--process-topology) §2 fix the URL strings as `as const`._
10. Reshuffling `packages/` directories; only additions allowed. _Mechanism: **human review with reference test as smoke check** — `tools/packages-shape.spec.ts` enumerates `packages/*/package.json` and asserts the v0.3 set (`proto`, `daemon`, `electron`) is a subset of the actual set; rename or removal trips the test, but the test cannot detect intent (e.g. a rename followed by re-add would still pass the subset check)._
11. Bypassing the `lint:no-ipc` gate. _Mechanism: `tools/lint-no-ipc.sh` ([Chapter 12](#chapter-12--testing-strategy) §4) + ESLint `no-restricted-imports` rule on `electron`'s `ipcMain` / `ipcRenderer` / `contextBridge` named imports ([Chapter 11](#chapter-11--monorepo-layout) §5 — F3-added) — the ESLint rule is the AST-aware backstop the grep cannot match against aliased imports; CI runs both._
12. Changing per-OS state directory paths. _Mechanism: **human review with reference test as smoke check** — `daemon/state-dir/paths.spec.ts` asserts the per-OS path constants in `packages/daemon/src/state-dir/paths.ts` match the [Chapter 07](#chapter-07--data-and-state) §2 table verbatim; the test catches accidental drift but a deliberate rename will update both source and test in one PR — reviewer MUST flag any `state-dir/paths.ts` touch._
<!-- F1: closes R0 15-P0.3 — items 13/14 lock the behavioral-additivity invariants F1 enforces in chapters 04/05/07/09. -->
13. v0.4 adding a mandatory non-NULL column to a v0.3 table (any new column added in v0.4 MUST be NULL-tolerant or have a literal default that v0.3 rows already satisfy). The intended seam is row-additive — new rows with new `scope` / `owner_id` values, not new columns on existing tables. The v0.3 baseline already ships `crash_log.owner_id NOT NULL DEFAULT 'daemon-self'`, `settings(scope, key, value)` composite PK, and the empty `principal_aliases` table precisely so v0.4 needs zero non-NULL column additions on principal-scoping state.
14. v0.4 reshaping the request semantics of `WatchSessions`, `GetCrashLog`, `WatchCrashLog`, `GetSettings`, or `UpdateSettings`. The `WatchScope`, `OwnerFilter`, and `SettingsScope` enums ([Chapter 04](#chapter-04--proto-and-rpc-surface) §3 / §5 / §6) are the only knobs v0.4 may touch; flipping defaults, adding behavior to existing enum values, or reading scope from any source other than the request enum is a hard block. v0.4 multi-principal enforcement happens by daemon-side branch on the existing enum value, not by a request-shape change. All three enums (`OwnerFilter`, `SettingsScope`, `WatchScope`) reject the broad/aggregate value (`ALL`/`PRINCIPAL`) in v0.3 with `PermissionDenied`; v0.4 admin clause is purely additive.
<!-- F2: closes R0 03-P0.1 / R0 03-P0.3 / R0 08-P0.3 / R2 P0-02-2 / R2 P0-03-3 / R5 P0-03-2 — items 15-18 lock the listener+descriptor+transport-bridge boundary. -->
15. Modifying `packages/electron/src/main/transport-bridge.ts` for web/iOS reasons. The bridge is forever Electron-internal; v0.4 web client uses `connect-web` directly and v0.4 iOS uses `connect-swift` directly — neither traverses the bridge. Bug fixes that affect the renderer↔bridge↔daemon path are allowed; cross-client refactors are not.
16. Adding a loopback-TCP fallback for the Supervisor channel (Supervisor is UDS-only on every OS — Windows named pipe, mac/linux UDS — forever). Supervisor endpoints (`/healthz`, `/hello`, `/shutdown`) MUST NOT be exposed via Listener B or any future remote listener; equivalent functionality for remote callers MUST be a NEW Connect RPC on the data-plane listener with explicit principal authorization.
17. Adding a new value to the `BindDescriptor.kind` / `listener-a.json.transport` 4-value enum (`KIND_UDS` / `KIND_NAMED_PIPE` / `KIND_TCP_LOOPBACK_H2C` / `KIND_TCP_LOOPBACK_H2_TLS`). Any v0.4+ transport variant ships under a NEW descriptor file (e.g., `listener-b.json` for Listener B's transport) with its own enum domain.
18. Writing to `listeners[1]` from any source file other than `packages/daemon/src/listeners/listener-b.ts`. Enforced by the ESLint rule `ccsm/no-listener-slot-mutation` ([Chapter 11](#chapter-11--monorepo-layout) §5) and by the startup runtime assert ([Chapter 03](#chapter-03--listeners-and-transport) §1). Bypassing the rule via `// eslint-disable` or via a `Reflect.set(listeners, 1, ...)` indirection is also forbidden (the assert catches indirection at boot).
<!-- F3: closes R0 03-P0.2 / R0 04-P0.1 / R0 04-P0.4 / R0 06-P0.1 / R0 06-P0.2 / R0 06-P0.3 / R4 P0 ch 04 + ch 12 — items 19-23 lock proto-schema mutation, the PTY child-process boundary, the SnapshotV1 codec wrapper, the AckPty contract, and the buf-breaking + lock.json gate. -->
19. v0.4 (or any v0.3.x patch) MUST NOT remove or renumber any field, message, enum value, RPC, or service present in the v0.3 `.proto` set; only add new fields with new tag numbers, new RPCs as appended methods, new oneof variants on existing oneofs (subject to item 20). Comment-only "reserved-for-future" slots are forbidden in `.proto` files — every reserved slot MUST use the protobuf `reserved <number>;` keyword ([Chapter 04](#chapter-04--proto-and-rpc-surface) §2 / §8). CI rejects PRs whose `.proto` diff fails `buf breaking` against the merge-base SHA pre-tag or the v0.3 release tag post-tag.
20. v0.4 (or v0.3.x) MUST NOT add a new value to the `Principal.kind` oneof at any field number other than the explicitly `reserved` slot (currently `reserved 2;` for `cf_access`). Removing the `reserved 2;` line and adding `CfAccess cf_access = 2;` in the same patch is the ONLY sanctioned move; any other oneof-field add MUST use a fresh tag number ≥ 3.
21. v0.4 (or v0.3.x) MUST NOT bump SnapshotV1 `schema_version` to add compression; compression already ships in v1 via the `codec` byte (1=zstd, 2=gzip) — [Chapter 06](#chapter-06--pty-snapshot--delta) §2. New codec values are added inside the open enum on the `codec` byte; `schema_version=2` is reserved for genuine inner-layout changes only.
22. v0.4 (or v0.3.x) MUST NOT remove `PtyService.AckPty` or the `AttachRequest.requires_ack` field; both ship in v0.3 specifically so high-latency v0.4 transports (CF Tunnel, mobile) get ack-driven flow control without a proto reshape. Daemon implementations MAY no-op the ack on loopback, but the wire surface is forever-stable.
23. v0.4 (or v0.3.x) MUST NOT touch a `.proto` file without bumping the matching SHA256 entry in `packages/proto/lock.json` in the same PR. CI's `proto-lock-check` step rejects mismatches mechanically ([Chapter 11](#chapter-11--monorepo-layout) §6); the bump is regenerated via `pnpm --filter @ccsm/proto run lock`.
24. v0.4 (or v0.3.x) MUST NOT branch daemon behavior on `HelloRequest.client_kind` or `HelloResponse.listener_id` string values. Both are open string sets ([Chapter 04](#chapter-04--proto-and-rpc-surface) §3 / §7); they are observability-only on both sides. v0.4 features that need behavior selection per client kind ship as separate RPCs or as request-level fields, never as a switch on `client_kind`.
25. v0.4 (or v0.3.x) MUST NOT pivot the PTY per-session boundary back into a `worker_threads` Worker. The pty-host runs as a `child_process.fork`-spawned process ([Chapter 06](#chapter-06--pty-snapshot--delta) §1); the boundary is forever-stable so v0.4 per-principal helper-process drops privileges with `setuid` at fork time additively. Any v0.4 PR that re-introduces `new Worker(...)` for a pty-host is rejected; the change-set would also re-open the daemon-process address-space-corruption vector that v0.3 deliberately closed.
<!-- F8: closes R0 15-P1.4 partial + dispatch-plan F8 residual list — items 26-27 close the segmentation-cadence and Listener-B-perf-budget gaps the dispatch plan lists explicitly. Items 7 / 16 / 17 / 24 / 5 / 6 / 12 already in place above (added by F1-F3) cover the rest of the dispatch-plan F8 forbidden-pattern bullet. -->
26. Per-subscriber delta segmentation. The 16ms / 16KiB segmentation cadence ([Chapter 06](#chapter-06--pty-snapshot--delta) §3) is a **per-session** property of the pty-host's emitter; v0.4 MUST NOT introduce per-subscriber segmentation knobs (e.g. "web client gets 32ms / 64KiB chunks; iOS gets 8ms / 8KiB"). The forever-stable shape is one cadence per session, broadcast to N subscribers as identical byte ranges; v0.4 client-side coalescing for high-latency transports happens in the client renderer, never on the daemon emitter. _Mechanism: `pty/segmentation-cadence.spec.ts` ([Chapter 12](#chapter-12--testing-strategy)) asserts the cadence constants live in one source file (`packages/daemon/src/pty/segmentation.ts`) with no per-subscriber parameter; the AttachRequest proto has no segmentation override field._
27. Re-tuning the Listener-A perf budget for v0.4 reasons. The performance budgets pinned for Listener A ([Chapter 12](#chapter-12--testing-strategy) §7 — `SendInput` p99, snapshot encode p99, etc.) are **forever-stable for Listener A only**. v0.4 Listener B (cf-access via cloudflared) sets its own budget under its own descriptor file (`listener-b.json`) and its own ship-gate variant; v0.4 MUST NOT widen, narrow, or otherwise mutate Listener-A's budget to "make room" for Listener B. _Mechanism: **human review with reference test as smoke check** — [Chapter 12](#chapter-12--testing-strategy) §7 budget table is a checked-in markdown table; `tools/perf-budgets-locked.spec.ts` parses it and asserts the Listener-A row is byte-identical to the v0.3 release-tag content. Listener-B budget rows are appended (not in-place edits) when v0.4 ships._
28. Ship-gate (c) test file path is `packages/daemon/test/integration/pty-soak-1h.spec.ts`; [Chapter 12](#chapter-12--testing-strategy) §4.3 is the single source of truth; renaming requires R4 sign-off.
29. v0.3 `tools/.no-ipc-allowlist` contents (descriptor preload only) are forever-stable; v0.4 additions require R4 sign-off and a chapter-15 audit row.

If a v0.4 PR needs to do any of the above, the v0.3 design picked the wrong shape and we go back to spec — **inside v0.3, before v0.3 ships**. Per brief: "these mean the v0.3 design picked the wrong shape and MUST be reworked inside v0.3."

#### 4. Sub-decisions made by author (review-attention items)

The brief locked the high-altitude shape; the following sub-decisions were made by this author and SHOULD receive specific reviewer scrutiny:

1. **Child processes (NOT worker_threads) for PTY hosts** ([Chapter 06](#chapter-06--pty-snapshot--delta) §1) — **DECIDED** (F3): one `child_process.fork`-spawned pty-host per session. Brief did not mandate; F3 chose the process boundary so a memory-corruption bug in `node-pty` / native deps cannot take down the daemon, and so v0.4 per-principal helper-process gets uid drop additively (no boundary reshape). Risk: IPC overhead vs zero-copy `postMessage`; F3's spike `[child-process-pty-throughput]` (replacing the prior `[worker-thread-pty-throughput]`) validates throughput is acceptable for ship-gate (c)'s 250 MB / 60 min budget. Reviewer audit complete; this is now a forever-stable boundary v0.4 must not flatten back into the daemon process. <!-- F3: closes R0 04-P0.4 / R0 06-P0.1 / R0 15-P1.1 -->
2. **SnapshotV1 custom binary format with zstd from day one** ([Chapter 06](#chapter-06--pty-snapshot--delta) §2) — **DECIDED** (F3): outer wrapper carries `codec` byte (`1` = zstd default; `2` = gzip for browser-native `DecompressionStream`); inner layout is the byte-for-byte custom binary previously specified. Brief said "schema for delta is locked" but did not lock the snapshot format. F3 ships compression in v0.3 so v0.4 NEVER needs a `schema_version=2` bump just to add compression. Risk: dual-codec test surface; covered by `pty/snapshot-codec.spec.ts` round-trip cases for both codecs. Reviewer should confirm the byte-equality test plan (spike `[snapshot-roundtrip-fidelity]`) covers compressed encode/decode round-trip. <!-- F3: closes R0 06-P0.2 / R0 15-P1.2 -->
3. **Connection descriptor JSON file** ([Chapter 03](#chapter-03--listeners-and-transport) §3) as the Electron-daemon rendezvous. Brief did not specify. Risk: file race on first launch. Mitigation: descriptor written before Supervisor `/healthz` returns 200; Electron polls until both succeed.
4. **Single-PR big-bang Electron migration** ([Chapter 08](#chapter-08--electron-client-migration) §1). Brief said "big-bang"; author interpreted as a single PR. Reviewer should confirm — alternative is "big-bang on a feature branch with multiple internal PRs that merge to trunk together"; either reading is consistent with the brief.
5. **Custom WiX project vs electron-builder MSI** ([Chapter 10](#chapter-10--build-package-installer) §5.1). Marked MUST-SPIKE; not yet decided. Reviewer should confirm the spike order (do this early — it gates phase 10).
6. **macOS LaunchDaemon dedicated `_ccsm` user** ([Chapter 02](#chapter-02--process-topology) §2.2). Brief said "not SYSTEM unless absolutely required" for Windows; author extrapolated to dedicated user on mac/linux. Reviewer should confirm.
7. **`crash-raw.ndjson` recovery file** ([Chapter 09](#chapter-09--crash-collector) §2). Brief said SQLite-only storage; author added the raw file as a fatal-event safety net. Reviewer should confirm the file's existence is acceptable (it IS additive — v0.4 can ignore or extend).
8. **Linux daemon NOT XDG-respecting** ([Chapter 07](#chapter-07--data-and-state) §2). Author chose `/var/lib/ccsm/` (FHS) over XDG. Reviewer should confirm — brief said "system-level (not `--user`)" which justifies but does not mandate FHS.
9. **Electron renderer transport bridge in main process** ([Chapter 14 §1.6](#chapter-14--risks-and-spikes)) — **DECIDED** (F2): bridge ships unconditionally in v0.3 on every OS. See [Chapter 08](#chapter-08--electron-client-migration) §4.2 for the locked spec; [Chapter 14](#chapter-14--risks-and-spikes) §1.6 marks the spike as resolved. Reviewer audit complete; this is now an additive Electron-internal module v0.4 must not touch (forbidden-pattern 15 above). <!-- F2: closes R0 08-P0.3 / R5 P1-14-2 -->
10. **Phase-10 installer per-OS technology choices** (WiX MSI, pkg, deb+rpm — [Chapter 10 §5](#chapter-10--build-package-installer)). Brief didn't lock; author chose enterprise-friendly defaults. Reviewer should confirm.

#### 5. Closing rule

If at any point during stage 2 review a chapter's v0.4 delta lands in the "unacceptable" column, the chapter is sent back to author (stage 3 fixer) and the spec MUST NOT proceed to stage 5 merge. The four ship-gates from brief §11 are the ship-quality bar; this audit chapter is the design-quality bar. Both must be green.


---

## Changelog

- **2026-05-03** — Spec produced by the spec-pipeline skill: 16-chapter parallel author stage, 4 reviewer angles (R0 zero-rework, R1 feature-preservation, R2 security, R4 ship-gate-verifiability), 2 review rounds, with a strictness gradient applied (R0/R1/R4 must-fix-all, R2 real-exploitable only). Stage 5 merge consolidated the 15 design chapters (02-15 plus the overview) into this single document; the original chapter directory was deleted in the same commit (history retained in git).
