# R3 review — 02-process-topology

## P1-R3-02-01 — Service registration failure path is unspecified

§5 (install table) says installer "Verifies Supervisor `/healthz` returns 200 within 10s before declaring success" but does NOT specify what happens when `/healthz` does NOT return 200 in 10s. The R3 failure mode "service registers OK but fails to start (port collision, permission denied, binary missing)" is the most common installer failure on Windows; the spec must say:

- Installer re-reads `crash-raw.ndjson` (chapter 09 §2) to surface the actual error to the user (e.g. "Listener A bind failed: EADDRINUSE on 127.0.0.1:54871" — listener_bind source from chapter 09 §1).
- Installer either rolls back (recommended for MSI: `<RollbackRollbackBoundary>`) or leaves the service registered-but-not-running with a clear error dialog. Pick one.
- Without this, ship-gate (d) only verifies happy-path uninstall residue; partially-failed installs leave a broken service silently registered. Suggest adding a §5 sub-step "On `/healthz` timeout: read `state/crash-raw.ndjson`, surface most-recent fatal entry, exit installer with non-zero".

## P1-R3-02-02 — Recovery actions on Win do not capture crash log post-restart

§2.1 specifies "First failure → restart after 5s; second failure → restart after 30s; subsequent → run no command (let crash log capture)". But the daemon process that just crashed cannot capture its own terminal state — the next process invocation has to read `crash-raw.ndjson` (chapter 09 §2) and import. §2.1 should explicitly cross-reference chapter 09 §2 so the implementer wires the boot-time scan; otherwise SCM restart cycles silently lose context.

## P1-R3-02-03 — Daemon stdout/stderr destination unspecified per OS

The chapter pins service registration but says nothing about where daemon stdout/stderr go. This is the entire log story on linux (systemd journal captures stdout) — without a sentence saying "daemon writes structured logs to stdout; systemd journal captures on linux; Win Service captures to Event Log via stdout redirect; launchd `StandardOutPath` writes to a file" the operator has no first-line debugging surface. See R3-09 P0 (logging gap) — this chapter is where the per-OS plumbing should land.

## P2-R3-02-04 — Watchdog miss on linux loses last-known state

§2.3 sets `WatchdogSec=30s` (good). When the main thread hangs, systemd sends SIGABRT and the daemon dies. There is no opportunity to flush in-flight delta batches before death. Suggest §3 step 5 mention installing a SIGABRT handler that attempts a synchronous `crash-raw.ndjson` write of the watchdog-miss event (chapter 09 §1 already lists `watchdog_miss` source — clarify it must be writable from a signal handler context).

## P2-R3-02-05 — Listener bind failure surfacing on boot

§3 step 5 says "bind Listener A; ... Supervisor `/healthz` returns 200". If Listener A bind fails (port collision after a crash, named pipe path leftover, UDS path leftover from previous unclean shutdown), the daemon will crash_log → exit. But step 5 does not specify cleanup of stale UDS paths / pipe paths from prior unclean shutdowns. Add: "step 5 first `unlink(udsPath)` if it exists and the daemon owns the parent dir; equivalent for named pipes (Win pipes are auto-cleaned, OK)". Without this, repeated unclean shutdowns leave the daemon unable to bind on linux/mac.

## Multi-Electron-clients (R3 angle 8)

§6 contract handles "fresh Electron reconnects" but does not explicitly address "two Electron windows from the same user open simultaneously". Chapter 06 §6 multi-attach broadcast covers PTY; SessionService.WatchSessions filtering by `principalKey` (chapter 05 §5) means both windows see the same events. Adequate. NO FINDING.

## Daemon restart mid-session (R3 angle 14)

§6 contract: Electron tolerates UNAVAILABLE + reconnect. Combined with chapter 08 §6 (auto-reattach with last-applied seq) this is specified end-to-end. NO FINDING.
