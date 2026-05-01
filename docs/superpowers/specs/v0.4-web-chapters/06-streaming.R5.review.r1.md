# Review of chapter 06: Streaming and multi-client coherence

Reviewer: R5 (Testability)
Round: 1

## Findings

### P0-1 (BLOCKER): PTY buffer + seq replay determinism for hermetic test is not specified
**Where**: chapter 06 §5 + §6 + chapter 08 §3 / §6
**Issue**: the headline correctness property of v0.4 is "client reconnects with `fromSeq`, daemon replays exactly the messages between `fromSeq` and `currentSeq`, OR force-snapshots if gap/boot-nonce-mismatch". Verifying this hermetically requires:
- Deterministic seq emission (PTY output bytes from `node-pty` must produce a known seq trail) — currently undefined; bytes from real `node-pty` are non-deterministic across runs (timing of `data` events).
- Injectable `boot_nonce` (so a test can simulate "daemon restart" without actually restarting the process).
- Injectable fanout-buffer size (256 KiB cap from §6 + 1 MiB drop-slowest from §7) to test the "gap" path quickly without writing 256 KiB.
- A way to "freeze" the snapshot semaphore to assert "client got snapshot, not replay" deterministically.
None of these injection seams are specified.
**Why this is P0**: chapter 08 §5 lists `web-reconnect` as one Playwright case but if the underlying daemon code is non-deterministic, that case will be flaky. Flaky e2e on the headline feature → either gets quarantined (violates `feedback_no_skipped_e2e`) or burns reviewer cycles indefinitely. Reverse-verify (`feedback_bug_fix_test_workflow`) becomes meaningless if the test is flake-prone.
**Suggested fix**: chapter 06 adds a "Testability" §9 specifying: (a) a `FakePty` that emits deterministic byte sequences keyed by test scenario, (b) `bootNonce` exposed via `__setBootNonceForTest()` in test mode, (c) fanout-buffer size injectable via `CCSM_TEST_FANOUT_BUFFER_BYTES` env var, (d) snapshot-vs-replay decision is logged with a specific tag the test can assert on instead of trying to detect from output shape.

### P1-1 (must-fix): Heartbeat interval (60-90s) is too slow to be testable in a normal e2e run
**Where**: chapter 06 §4
**Issue**: heartbeat fires when "elapsed since last event > 60s" and CF idle is 100s. A test asserting "stream stays alive across 100s idle" runs for 100+ seconds, blowing the e2e budget (chapter 08 §9 says web-e2e total is ~5 minutes for 6 cases — one 100s case eats 1/3 of that). Need an injectable interval (e.g. `CCSM_TEST_HEARTBEAT_INTERVAL_MS=300`).
**Why P1**: without injection, either the test is skipped (violates no-skip rule) or the test budget bloats. Per `feedback_e2e_prefer_harness`, this should be a fast harness case.
**Suggested fix**: chapter 06 §4 adds "test-mode interval override via env var; default 30/60/90s, test-mode 30/60/90 ms." Chapter 08 §5 adds `web-heartbeat-survives-idle` case.

### P1-2 (must-fix): Backpressure / drop-slowest test path missing
**Where**: chapter 06 §7 + chapter 10 R5 / R10
**Issue**: drop-slowest fires at 1 MiB per-subscriber. Hermetic test needs (a) a slow consumer (test fixture that never reads the stream), (b) producer that emits >1 MiB worth of events fast, (c) assertion that the daemon dropped events and emitted `gap=true`. Not in chapter 08. Critical for the "backgrounded browser tab" story (chapter 07 §3).
**Why P1**: the property "slow client doesn't OOM the daemon" is the v0.3 carryover that v0.4 implicitly stresses with web clients (laptop closing lid, etc.). If it regresses post-v0.3, no test catches it until prod.
**Suggested fix**: chapter 08 §3 adds contract test "drop-slowest fires under slow consumer, gap signaled, recovery via snapshot." Use injectable buffer-size from P0-1 fix to make it run in <1s.

### P1-3 (must-fix): Multi-client coherence single test case is too thin
**Where**: chapter 06 §5 + chapter 08 §6
**Issue**: chapter 08 §6 specifies ONE multi-client case (Electron + web, simple echo). Real coherence bugs surface in: (a) interleaved input from two clients during the same shell prompt (does the byte order match daemon's PTY queue? does the snapshot reflect both?), (b) one client disconnecting while the other is mid-stream (does fanout cleanup correctly?), (c) one client far behind in seq while the other is live (does drop-slowest hit one and not the other?). One smoke case won't catch any of these.
**Why P1**: this IS the headline differentiator vs raw CLI. Per chapter 00 success criteria #3, multi-client coherence is a release gate. One case for a release gate is undertest.
**Suggested fix**: chapter 08 §6 expands to 3-4 cases minimum: simple-mirror (current), interleaved-input, disconnect-while-other-active, slow-client-doesnt-affect-fast-client.

### P1-4 (must-fix): Fanout subscriber tracking has no leak test
**Where**: chapter 06 §5 + chapter 07 §6 — "Removes A from fanout"
**Issue**: per-session fanout registry tracks subscribers. Disconnect cleanup is implicit ("HTTP/2 RST or stream end"). Subscriber leak (e.g. RST not detected on unusual disconnect path → dead subscriber stays in fanout, drop-slowest never frees it) is exactly the kind of memory leak that takes weeks to surface. Author flags R5 (xterm-headless memory) as a top risk; subscriber leak is a related but distinct mechanism with no test.
**Why P1**: per chapter 10 R5, memory growth in long-running daemon is a top risk. Subscriber leak compounds it. Testable: contract test connects N clients, disconnects them all in various ways, asserts fanout subscriber count returns to 0.
**Suggested fix**: chapter 08 §3 adds "fanout-subscriber-cleanup" contract test with explicit disconnect modes: clean close, RST, idle-timeout, mid-stream-exception.

### P2-1 (nice-to-have): Input batching ordering across multi-client not asserted
**Where**: chapter 06 §3 + chapter 07 §6
**Issue**: §3 says "daemon serializes inputs into the per-session PTY input queue in arrival order"; §07.6 says characters interleave. This IS the documented behavior but no test asserts it (e.g. fire 100 alternating bytes from A and B, snapshot the PTY queue, verify FIFO arrival).
**Why P2**: documented as expected behavior; regression would manifest as user-reported "weird typing" rather than data loss.
**Suggested fix**: contract test in chapter 08 §3.

## Cross-file findings

- **Hermetic test seams** (P0-1) needed in chapter 06 §9 (new) drives test entries in chapter 08 §3, §5, §6 — single fixer should add the §9 then update chapter 08 references.
- **Heartbeat injectable interval** (P1-1) cross-refs chapter 06 §4 + chapter 08 §5.
- **Multi-client expanded cases** (P1-3) chapter 06 §5 → chapter 08 §6.
