# Fragment: §3.5.1 PTY hardening (orphan reap + bridge timeout)

**Owner**: worker dispatched per Task #940
**Target spec section**: insert after §3.5 in main spec
**P0 items addressed**: #2 (PTY orphan reap), #3 (bridge call timeout)

## What to write here
Replace this section with the actual `### 3.5.1 PTY child lifecycle hardening`
markdown. Cover:
1. **Orphan reaping on daemon crash**:
   - Win: JobObject with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; child ptys
     auto-killed when daemon process handle closes. Spec the N-API path or
     existing npm package used.
   - Unix: process group leader; daemon SIGKILL sends to whole group on exit;
     also handle SIGCHLD to reap zombies.
   - Behavior on graceful shutdown vs crash: graceful = SIGTERM with grace
     period, then SIGKILL; crash = OS-driven cleanup via JobObject/pgroup.
2. **Bridge call timeout**:
   - Connect client (Electron side) wraps every RPC with default 5 s deadline,
     configurable per-call. On timeout: client surfaces `BridgeTimeoutError`,
     does NOT auto-retry (caller decides).
   - Stream RPCs (PTY output stream): timeout applies to first byte / heartbeat
     interval, not whole stream. Spec the heartbeat interval (e.g. 30 s).
   - Daemon side: per-RPC timeout enforced by handler; runaway handler killed.

Cite findings from `~/spike-reports/v03-review-reliability.md` and
`~/spike-reports/v03-review-resource.md`.

## Plan delta
- Task 11 (PTY service) gains: JobObject/pgroup wiring (+3h), reaping tests
  (+2h). New estimate: NN h.
- Task 5 or 7 (RPC adapter / bridge client) gains: timeout middleware (+2h),
  heartbeat for stream RPCs (+2h).
- New test cases: kill-daemon-and-check-no-orphan-pty (Win+Unix); RPC
  timeout regression.
