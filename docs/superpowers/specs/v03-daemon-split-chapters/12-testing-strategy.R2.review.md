# R2 (Security) review — 12-testing-strategy

## P1

### P1-12-1 — No test plan for any of the security-shaped findings raised against ch 02–10

§2 unit + §3 integration enumerate functional tests. **None** of the following appear:
- DNS-rebinding test against the loopback-TCP transport / renderer-main bridge (ch 03 P0-03-1, ch 08 P0-08-1).
- Peer-cred PID-recycle race test (ch 03 P0-03-2).
- `Settings.claude_binary_path` admin-gate test (ch 04 P0-04-3).
- `CreateSession.env` allowlist test (ch 04 P0-04-1).
- PTY OSC 52 / OSC 8 filter tests (ch 04 P0-04-4, ch 06 P1-06-1).
- Crash-log PII scrubber tests (ch 09 P0-09-1).
- Listener-descriptor staleness / `boot_id` mismatch test (ch 03 P0-03-4, ch 08 P0-08-2).
- Cross-user (Linux ccsm-group) isolation tests (ch 05 P0-05-2, ch 07 P0-07-2).
- `lint:no-ipc` grep coverage of `webContents.send` / `MessagePortMain` etc. (ch 08 P1-08-2).
- Installer signature-verification test before service registration (ch 10 P0-10-2).

Spec must enumerate at least one regression test per security control it claims. Without that, the controls are aspirational.

### P1-12-2 — `claude-sim` deterministic test fixture excludes adversarial workloads

§5: deterministic byte stream of "UTF-8/CJK/256-color/alt-screen/bursts mix". Spec should add an adversarial workload variant emitting OSC 52 / OSC 8 / DCS / APC / overlength CSI / malformed UTF-8 — to exercise the filter policy and the parser robustness end-to-end.

## P2

### P2-12-1 — Coverage targets are line-coverage; no security-control coverage

§6 sets 80% line coverage on daemon. No mandate that every "MUST reject" branch is covered. Add a "every authorization branch must have a deny-path test" rule.

### P2-12-2 — Performance budgets do not include "memory under malicious input"

§7. A 100 MB OSC 52 sequence injected by SendInput should not OOM the daemon. Add a fuzz-input memory-cap test.

### P2-12-3 — Ship-gate (b) tests SIGKILL of Electron, not SIGKILL of daemon

§4.2 only kills Electron. Symmetric test (kill daemon, watch Electron + claude subprocesses + reattach behaviour) should be included; not security-strict but covers crash-recovery surface where many security controls live.

No P0 findings beyond "no test plan exists for security controls" which is rolled into P1-12-1.
