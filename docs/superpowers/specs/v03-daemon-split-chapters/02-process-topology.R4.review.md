# 02 — Process Topology — R4 (Testability + Ship-Gate Coverage)

## P1 — Startup ordering invariant (state 5 before Listener A accepts) has no test

§3 step 5: "The daemon MUST be in state (5) before accepting any Listener A connect. If a client connects mid-startup (Supervisor `/healthz` 503), the daemon refuses with `UNAVAILABLE`."

Chapter 12 has no test asserting:
- During boot phase (between step 1 and step 5), Listener A is NOT accepting
- Supervisor `/healthz` returns 503 during that window
- Connect attempt during that window returns `UNAVAILABLE`

This is a tight race window but a real one (cold boot of a busy system, 50 sessions to restore in step 4). A regression where Listener A binds before step 5 would let half-initialized requests in, producing data corruption. Add `daemon-startup-ordering.spec.ts` using a hookable test daemon that pauses at each step.

## P1 — Shutdown contract "≤5s budget" for in-flight unary RPCs, "≤3s SIGKILL" for claude is untested

§4 specifies precise timing budgets. Chapter 12 has no `daemon-shutdown.spec.ts` exercising:
- Long-running unary RPC in flight when stop signal arrives → daemon waits up to 5s, then aborts
- Claude CLI subprocess receives SIGTERM, then SIGKILL after 3s
- WAL checkpoint completes
- Exit code 0

Without tests, these are aspirational numbers. Add the test.

## P1 — `shutdown` RPC admin-only check is untested

§4: "`shutdown` RPC on Supervisor UDS: only callable by an admin (peer-cred uid == root/SYSTEM/Administrators) — Electron is NOT admin."

No test in chapter 12 for "non-admin caller gets 403 / Forbidden on POST /shutdown." This is a privilege-escalation-shaped surface. Add `supervisor/admin-only.spec.ts`.

## P2 — Per-OS service shape decisions: no automated check that the install actually applies them

E.g., §2.3 specifies `Type=notify`, `Restart=on-failure`, `RestartSec=5s`, `WatchdogSec=30s`. The .deb postinst writes the unit file. There's no test parsing the installed unit file and asserting these directives are present. Add `installer-roundtrip.sh` (linux): after install, `systemctl show ccsm-daemon -p Type,Restart,RestartSec,WatchdogSec` and assert.

## Summary

P0: 0 / P1: 3 / P2: 1
Most-severe: **Boot-phase ordering invariant (Listener A binds only after step 5) has no test; race-window regressions would corrupt half-initialized state silently.**
