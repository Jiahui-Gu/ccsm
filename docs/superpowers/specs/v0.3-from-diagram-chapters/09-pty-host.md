# 09 — PTY host (inside daemon)

## Scope

The PTY host module owns spawning, supervising, reading from, writing to, resizing, and reaping PTY child processes. It lives inside the daemon and is consumed by the session manager (see [08](./08-session-model.md)).

**Why in daemon:** final-architecture §2 principle 1 — backend owns state. Principle 9 — daemon's lifecycle is independent of client; PTY children must outlive Electron exits. PTY-in-Electron would die when Electron dies.

## Module layout

```
daemon/src/pty/
  host.ts            # PtyHost class: spawn / kill / write / resize / on-exit
  child.ts           # one PTY child wrapper (node-pty handle + state)
  reaper.ts          # SIGCHLD / waitpid loop on POSIX; JobObject lifetime on Windows
  signals.ts         # signal name → numeric mapping per OS
  __tests__/
```

## Dependencies

### node-pty

- Pin to a version that ships **Windows prebuilds** (resolves task #78 KEEP from reconciliation).
- ABI must match Node 22 (the daemon's bundled Node version per packaging — see [13](./13-packaging-and-release.md)).
- Accessed via the daemon's bundled Node, not Electron's. node-pty inside daemon is plain Node 22 ABI; no Electron rebuild required.

### `ccsm_native`

Native addon (existing v0.3 frag-3.5.1 work; #79 KEEP from reconciliation). Provides:

- POSIX `setpgid` / `PDEATHSIG` setup for PTY children (so they die with the daemon).
- Windows `JobObject` creation + child assignment (so children die with the daemon).
- `SO_PEERCRED` / `LOCAL_PEERCRED` (POSIX) and named-pipe `GetNamedPipeClientProcessId` + SID lookup (Windows) — shared with peer-cred check (see [03](./03-listener-A-peer-cred.md)).

The native addon is loaded at daemon boot; failure to load → daemon exits non-zero.

## Spawn contract

```
PtyHost.spawn(opts: {
  shell: string;       // resolved absolute path
  args: string[];
  cwd: string;
  env: Record<string,string>;
  cols: number;
  rows: number;
  encoding?: 'utf-8' | null;  // null = raw bytes pass-through
}): PtyChild
```

Behavior:

- Child is created via node-pty with the OS-appropriate `setpgid` / JobObject hook executed in `beforeExec` / `pty_fork` callback equivalent.
- On POSIX: `setpgid(pid, pid)` so child becomes its own process-group leader; `prctl(PR_SET_PDEATHSIG, SIGTERM)` (Linux) or kqueue NOTE_EXIT (macOS) sets up parent-death cleanup.
- On Windows: child is assigned to a JobObject created at daemon boot; the job has `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so when daemon exits Windows reaps the child.

`encoding` defaults to `null` (raw bytes). Session manager forwards bytes verbatim to subscribers; **decoding is the client's job** to avoid mid-codepoint splits at the daemon.

## Read path

- node-pty's `onData` fires per OS-buffer chunk.
- PtyHost forwards `(child, bytes)` to the owning session via callback registered at spawn.
- No buffering / merging at PtyHost layer; session ring buffer (see [08](./08-session-model.md)) is the only buffer.

## Write path

- `PtyChild.write(bytes)` → node-pty `write`. Bytes are passed through; PtyHost does not interpret.
- Multi-client input: serialized by Node event loop (see [08 §LWW](./08-session-model.md)).

## Resize

- `PtyChild.resize(cols, rows)` → node-pty `resize`. Triggers SIGWINCH in child.

## Kill / signals

- `PtyChild.kill(signal)` where `signal` ∈ `SIGTERM | SIGKILL | SIGINT | SIGHUP` (matches `PtySignal` enum in proto, see [06](./06-proto-schema.md)).
- POSIX: `kill(-pgid, signal)` (negative PID → kill the entire process group, not just the leader). This catches the common case where the shell forked something.
- Windows: signal-name maps to JobObject termination or `GenerateConsoleCtrlEvent` for SIGINT-equivalent; SIGKILL = `TerminateJobObject`.

## Exit + reap

### POSIX (`reaper.ts`)

- Daemon installs a single SIGCHLD handler (waitpid-WNOHANG loop on signal).
- Per-PID waitpid result is matched against the registry → notifies the owning session with `{ exitCode, signal }`.
- Avoid the libuv default reaping race: PtyHost owns the SIGCHLD handler, not node-pty's per-child handler (which can lose signals under burst).

### Windows

- JobObject completion port surfaces child exit via `IO_COMPLETION_PORT`; ccsm_native exposes it as a JS event.
- Same notification path to session.

## PTY child orphan prevention

If the daemon dies abnormally (SIGKILL, panic, pull-the-plug): PTY children MUST die too.

- POSIX: PR_SET_PDEATHSIG (Linux) sends SIGTERM to child when its parent process group disappears. macOS: kqueue + a parent-watcher in ccsm_native that kills children on parent EOF.
- Windows: JobObject's `KILL_ON_JOB_CLOSE` does this automatically when the daemon's process handle (which holds the job) closes.

This is verified by IT: `kill -9 daemon_pid` → list PTY children of daemon-shell → assert all gone within 2s. See [15 §IT-4](./15-testing-strategy.md).

## Heartbeat / liveness

PtyHost emits an internal liveness tick to session manager every 30 s. Session manager turns it into the `PtyHeartbeat` proto message on subscriber streams (see [08](./08-session-model.md)). The tick is also used to detect PTY children that have entered weird states (e.g. paused via SIGSTOP) — though in v0.3 we do not act on this beyond logging.

## Concurrency caps

- Max concurrent PTY children: 32 per daemon (matches dogfood "5-session RAM" upper bound × ~6 safety margin).
- Exceeding cap: `PtyService.Spawn` returns `ResourceExhausted`.

## Integration points

- `daemon/src/index.ts` instantiates `PtyHost` after native addon load.
- `daemon/src/connect/handlers/pty.ts` calls into `PtyHost` and into `SessionManager`.
- `daemon/src/sessions/manager.ts` passes the session-output callback to PtyHost on spawn.

## Cross-refs

- [03 — Listener A peer-cred (shares `ccsm_native`)](./03-listener-A-peer-cred.md)
- [06 — Proto (PtyService methods + PtySignal enum)](./06-proto-schema.md)
- [07 — Connect server (PtyHost is a wired dependency)](./07-connect-server.md)
- [08 — Session model (read path / write path / fan-out)](./08-session-model.md)
- [13 — Packaging (node-pty Win prebuild + native ABI)](./13-packaging-and-release.md)
- [15 — Testing (orphan-prevention IT)](./15-testing-strategy.md)
