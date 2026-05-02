# R3 review — 12-testing-strategy

## P1-R3-12-01 — Ship-gate (b) harness asserts no `claude` zombies but does not assert `claude` PIDs unchanged

§4.2 step 4: "verify `claude` PIDs still alive (`tasklist` / `ps`)." Good — covers R3 ship-gate (b) sub-criterion (iii) "PTY children still alive". But:

- Does not verify the PID is the SAME PID as before the SIGKILL (if the daemon respawned claude, that's a regression — the brief contract says PTY children must survive, not be replaced).
- Does not verify the PID's parent is still the daemon (orphaned-to-init means session ownership tracking broke).

Add: "for each session, capture `claude` PID before SIGKILL; assert same PID after; assert PPID == daemon PID."

## P1-R3-12-02 — Ship-gate (c) has no negative-path / disk-full / hang variants

§4.3 specifies the 1-hour clean run. Per R3-06-01 (input backpressure) and R3-07-03 (disk-full SQLite), the chapter-12 harness should include:

- `pty-soak-hang`: claude CLI deliberately stops reading stdin; test pipes 100MB to SendInput; assert daemon does not OOM (RSS stays < 500MB) and SendInput returns RESOURCE_EXHAUSTED past the cap.
- `pty-soak-disk-full`: bind-mount a small (100MB) tmpfs over state dir partway through; assert daemon emits `crash_log` entry, session degrades gracefully, daemon process survives.

Without these the failure modes that would actually take down a customer in production are untested.

## P2-R3-12-03 — Integration test list missing reconnect-after-daemon-restart

§3 lists `pty-reattach.spec.ts` (electron-disconnect / reattach) and `pty-too-far-behind.spec.ts`. Missing: a daemon-restart-mid-stream test (kill daemon mid-Attach; verify systemd/launchd respawns; verify Electron auto-reconnects per chapter 08 §6 contract; verify session resumes; verify last-applied-seq honored across daemon restart). This is R3 angle 14.

The pty-soak harness §4.3 implicitly tests it (Electron sigkilled at t=10/25/40m), but DAEMON sigkill is not exercised — only Electron sigkill. Different code paths.

## P2-R3-12-04 — No test for stale connection-descriptor file (R3-03-02)

If the descriptor file persists from a previous boot but the daemon hasn't yet rewritten it, Electron would attempt to connect to a stale address. No integration test exercises this. Add to `peer-cred-rejection.spec.ts` or similar: "tamper with descriptor to point to non-listening port; assert Electron retries gracefully and connects after daemon writes the real descriptor."

## P2-R3-12-05 — Performance budgets do not include observability metrics

§7 lists 5 budgets (cold-start, RTT, snapshot encode, RSS). Missing for R3:
- WAL file size after 1-hour soak (regression: WAL keeps growing).
- Time to import `crash-raw.ndjson` on boot (regression: pathological history slows boot).
- Crash-collector overhead (deltas/sec drop when many crashes are firing).

Add as nightly only (NOT PR-blocking).

## NO FINDING — ship-gate (a) static gate

`lint:no-ipc` script is concise and verifiable.

## NO FINDING — ship-gate (d) installer round-trip

§4.4 covers brief §11(d) properly. Negative paths added in R3-10-05 above.

## NO FINDING — `claude-sim` deterministic fixture

§5 design is correct for R3 — deterministic fixtures are the only way reattach byte-equality can be asserted.
