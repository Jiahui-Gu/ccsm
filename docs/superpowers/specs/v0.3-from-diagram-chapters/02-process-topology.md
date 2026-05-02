# 02 — Process topology

> Authority: [final-architecture §2.9](../2026-05-02-final-architecture.md#2-locked-principles), §1 diagram.

## Process inventory in v0.3

```
ccsm-daemon                         (binary; long-lived; OS-detached from Electron)
├── (worker thread / native module: ccsm_native — see ch.09)
└── claude-cli child(ren)           (one per active session, spawned via node-pty)

ccsm-electron                       (GUI; user-launched; may exit independently of daemon)
└── (renderer processes per Electron norms)
```

`cloudflared` is **not** in v0.3's process tree. It enters in v0.4 as a child of `ccsm-daemon`.

## Lifecycle rules (v0.3)

L1. **Daemon start.** First-time start: `ccsm-electron` launches `ccsm-daemon` via OS-detach (`detached: true`, `stdio: 'ignore'`, `unref()` on POSIX; `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` on Windows). Subsequent starts: Electron probes Listener A; if alive, attach; if dead, spawn. **Why:** §2.9 ("daemon is not a child of any client. Closing the desktop client does not stop the daemon"). The OS supervisor ([NG4](./01-goals-and-non-goals.md#non-goals-must-not-ship-in-v03)) that would normally do this is deferred; Electron-as-bootstrap is the v0.3 stopgap that **does not require code change** at v0.4 — v0.4 simply adds an alternative bootstrap (the OS service) without removing the Electron path.

L2. **Daemon stop.** Daemon stops only on:
   - Explicit `daemon.shutdown` over the supervisor control plane.
   - SIGTERM/SIGINT (POSIX) or `CTRL_BREAK_EVENT` (Windows) — clean.
   - `SIGKILL` / process-killed — crash collector on next start logs the unclean exit.
   Electron exit MUST NOT stop the daemon (verified by an integration test in [15-testing-strategy](./15-testing-strategy.md)).

L3. **In-process supervisor's role.** Crash-loop counter + `.bak` rollback on repeated startup failure (existing v0.2 logic, retained). **It does not "keep the daemon alive"** — that is the OS's job (deferred to v0.4 OS supervisor; in v0.3 it's the user re-launching Electron). **Why:** §2.9 ("the in-process supervisor degrades to a crash-loop counter + `.bak` rollback").

L4. **PTY child lifetime.** A `claude-cli` child lives as long as its session row in SQLite says it should. Daemon crash kills the child (process group); on respawn, daemon marks the session as `interrupted` and surfaces it to clients on next snapshot fetch. **Why:** §2.7 (backend-authoritative — sessions exist server-side, but PTY processes are not preserved across daemon restarts in v0.3; that is a separate later feature).

L5. **Single-instance invariant.** A second `ccsm-daemon` invocation MUST detect Listener A bound and exit non-zero. UDS file lock + abstract-socket on Linux; named-pipe creation race on Windows. **Why:** Listener-keyed trust ([principle 3](../2026-05-02-final-architecture.md#2-locked-principles)) is meaningless if two daemons can both bind.

## Filesystem layout (per OS)

| Resource | macOS | Linux | Windows |
|---|---|---|---|
| Daemon binary | `/Applications/ccsm.app/Contents/Resources/ccsm-daemon` (or user dir) | `~/.local/bin/ccsm-daemon` | `%LOCALAPPDATA%\ccsm\ccsm-daemon.exe` |
| Listener A | `$XDG_RUNTIME_DIR/ccsm/sock` (fallback `~/.ccsm/run/sock`) | same | `\\.\pipe\ccsm-<sid>` |
| `dataRoot` (SQLite, logs, crash dumps) | `~/Library/Application Support/ccsm/` | `${XDG_DATA_HOME:-~/.local/share}/ccsm/` | `%LOCALAPPDATA%\ccsm\data\` |
| `PORT_TUNNEL` discovery file | `${dataRoot}/runtime/port-tunnel` | same | same |
| PID file | `${dataRoot}/runtime/daemon.pid` | same | same |

`dataRoot` is configurable via `--data-root` flag and `CCSM_DATA_ROOT` env (Electron passes the same value to ensure consistent client/daemon view). **Why:** dev-mode and dogfood need to coexist with prod install.

## §2.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。daemon 进程独立 (L1/L2)、in-process supervisor 仅 crash-loop+rollback (L3)、单实例不变量 (L5)、文件布局 (`dataRoot`, `port-tunnel`, `daemon.pid`) 都直接源自 final-architecture §2.9 + §1 diagram, v0.4 全部沿用。v0.4 加 OS-level supervisor 时, 它是 daemon 的**外部 launcher**, 不替换 in-process supervisor 的 crash-loop 职责; cloudflared 进 v0.4 时是 daemon 的**新增子进程**, 不改 v0.3 daemon 自身的 lifecycle 代码。

## Cross-refs

- [01-goals-and-non-goals](./01-goals-and-non-goals.md) — G5 (lifecycle), NG4 (no OS supervisor in v0.3).
- [03-listener-A-peer-cred](./03-listener-A-peer-cred.md) — uses Listener A path from this chapter.
- [04-listener-B-jwt](./04-listener-B-jwt.md) — uses `PORT_TUNNEL` discovery file.
- [11-crash-and-observability](./11-crash-and-observability.md) — uses `dataRoot/runtime/`.
