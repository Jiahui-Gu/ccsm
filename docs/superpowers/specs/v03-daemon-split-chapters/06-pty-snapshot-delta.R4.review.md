# 06 — PTY: Snapshot + Delta — R4 (Testability + Ship-Gate Coverage)

Angle: this chapter is the source of truth for ship-gate (c). R4 audited it for: (a) snapshot/delta encoding determinism (so byte-equality is a sound test); (b) workload-class enumeration (so soak tests right cases); (c) decoder spec; (d) testability of multi-attach and restart paths.

## P0 — SnapshotV1 encoding is not specified to be deterministic

§2 defines SnapshotV1 with `attrs_palette[attrs_palette_len]` as a dedup table. The chapter never says HOW palette entries are ordered. If the encoder iterates a JS `Map` keyed by attr-tuple and inserts on first-seen, ordering depends on cell traversal order — which IS deterministic (left-to-right top-to-bottom by §2's ordering of "scrollback first (oldest→newest), then viewport (top→bottom)"). But that pin is implicit, not stated. Two daemons given the same xterm-headless state MUST produce the same byte string, otherwise ship-gate (c)'s `Buffer.compare` test is unsound.

State explicitly: "Palette entries are appended in the order their owning cell is first encountered during the canonical line scan (scrollback oldest→newest first, then viewport top→bottom; within a line, left→right). Two encoders with equal Terminal state MUST produce byte-equal SnapshotV1 output."

Same concern for `modes_bitmap[8]`: bit positions are claimed "FOREVER-STABLE; new modes use new bits" — but the actual bit→mode mapping is **never enumerated**. Spec MUST list "bit 0 = app-cursor (DECCKM); bit 1 = app-keypad (DECPAM); ..." otherwise two implementers produce two encoders.

P0 because the entire ship-gate (c) verification depends on byte determinism, and the spec leaves enough ambiguity that two correct implementations could byte-disagree.

## P0 — There is no SnapshotV1 decoder spec; reconstruction on attach is unspecified

§2 specifies the encoder. §5 describes the reconnect tree:

> if since_seq == 0: snapshot := load latest pty_snapshot for session; emit PtyFrame.snapshot(snapshot); resume_seq := snapshot.base_seq + 1

The CLIENT receives `PtySnapshot.screen_state` as opaque bytes per chapter 04. The client renders the terminal — how? Either:
- Client decodes SnapshotV1 → reconstructs an xterm-headless `Terminal` cell-by-cell → drives the visible xterm.js Terminal from it (requires a decoder, not specified), OR
- Client treats SnapshotV1 bytes as opaque and replays only the deltas (which means the client never displays anything until first delta after connect — visible blank screen on attach).

Neither interpretation is stated. Chapter 06 says "xterm-headless on the client side replays raw VT correctly by definition (it's the same state machine as on the daemon side)" (§3) — this implies the client uses xterm.js, not xterm-headless, and the snapshot must somehow restore xterm.js state. xterm.js does not have a "load from cell array" API; it only has `write(bytes)`.

Two real possibilities:
1. Snapshot also includes (or alternatively IS) the raw VT bytes that produced the daemon-side state ("just send a stream of resets + cursor positions + characters that paints the same screen"). That is `xterm-headless`'s `SerializeAddon` shape — which §2 explicitly rejected.
2. Custom format requires custom decoder + custom xterm.js code path (not "write bytes" — direct buffer mutation). That is significant engineering not mentioned.

Pin which approach. P0 because the client-side implementation is undefined, which means ship-gate (b) "terminals reconnect" cannot be implemented as written.

## P0 — Daemon restart replay (§7) is the most ship-gate-critical path and has no test in chapter 12

§7: "On daemon restart, the pty-host worker for a recovered session starts with the most recent snapshot from SQLite, then writes the post-snapshot deltas back into xterm-headless to bring its in-memory state current."

Chapter 12 §3 lists `pty-attach-stream`, `pty-reattach`, `pty-too-far-behind` integration tests — all client-side reconnect. None tests "daemon restart picks up where it left off." This is the most ship-gate-(b)-critical scenario after Electron-kill — what if the OS reboots? What if the daemon crashes and the service manager restarts it? Add `pty-daemon-restart-replay.spec.ts`: create session, drive workload, kill daemon process (not Electron), restart daemon, attach, assert state continues. Without this test, the §7 flow is unverified.

P0 because brief §11(b)'s "no data loss" applies to daemon restart too (the brief example is Electron kill, but the underlying property is "PTY survives any non-OS-shutdown event"); the gate (b) harness only tests Electron kill, leaving daemon-restart-replay completely untested.

## P1 — Multi-attach broadcast (§6) has no integration test

§6 says daemon broadcasts deltas to N concurrent subscribers. Chapter 12 has no `pty-multi-attach.spec.ts`. The slow-subscriber kick-out (`PreconditionFailed("subscriber too slow; reattach")`) is also never exercised. Both will be needed in v0.4 web/iOS — and §6 v0.4 delta says "No daemon change" — yet without v0.3 tests we can't claim multi-attach works at v0.3 freeze. Add the test.

## P1 — Snapshot cadence parameters are tunable but never tested at extremes

§4: K_TIME=30s, M_DELTAS=256, B_BYTES=1MiB, DELTA_RETENTION_SEQS=4096. No test verifies "the cadence triggers when ANY of these fires" — could regress to "only K_TIME" unnoticed. Add `pty/snapshot-cadence.spec.ts` driving each trigger independently.

The `pty-too-far-behind.spec.ts` test (chapter 12 §3) implicitly exercises retention but doesn't specify the boundary case `seq == oldest_retained - 1` vs `seq == oldest_retained`. Add boundary tests.

## P1 — `pty-soak-1h` lacks intermediate failure surfacing

§8 step 4 SIGKILLs Electron at t=10m, t=25m, t=40m. If the FIRST kill at t=10m corrupts state, the test runs for 50 more minutes and reports failure at minute 60. CI feedback time for a pty bug is 60+ minutes. Add intermediate snapshot-equality checks at each reattach point (after t=10m+ε kill, at t=25m+ε, at t=40m+ε) so failures fire fast.

## P1 — `claude-sim` workload (§8 step 2) is incomplete and not byte-deterministic-by-spec

§8 step 2 lists workload phases. Chapter 12 §5 says claude-sim "Produces stable byte-by-byte identical output across runs." Across runs of the same script — fine. But the soak workload says "60-minute script (UTF-8/CJK/256-color/alt-screen/bursts mix)" — there is no scripted file, no expected SHA256 of the script's emitted bytes. If a contributor edits the workload to add a phase, gate (c) silently changes its semantics. Pin: the soak script lives in `packages/daemon/test/fixtures/claude-sim/soak-60m.script`, its SHA256 is committed to `pty-soak.spec.ts` as a constant, and CI verifies the script file's SHA at test start. Workload changes become explicit code review items.

## P1 — Worker thread crash handling: "session state → CRASHED" is not testable as written

§1: "A worker crash takes down only one session; `worker.on('exit')` triggers a `crash_log` entry + session state → CRASHED."

How do tests crash a worker? `worker_threads` only exits cleanly via `process.exit` from inside or `worker.terminate()` from outside; "crash" usually means uncaught exception inside the worker. Chapter 12 §2 lists `crash/capture.spec.ts` with "every source's mock fires once" — but worker_exit needs an actual crash, not a mock. Add a test fixture: a special "crash on this command" message handled by the worker code, used only in tests, that throws unhandled. Pin in chapter 06 §1 so the production worker code has the test-only branch.

## P1 — Daemon restart `crash_log` entry on respawn failure (§7) is asserted nowhere

§7 says: "Updates state to RUNNING (or CRASHED if claude CLI fails to spawn) and writes a crash_log entry on failure."

Chapter 12 doesn't list a `daemon-restart-claude-spawn-fail.spec.ts`. Trivial test: configure session with `claude_args = ["/nonexistent/binary"]`, kill+restart daemon, assert session state == CRASHED + crash_log row exists.

## P2 — `since_seq == 0` reconnect: spec ambiguity

§5: "0 means 'send fresh snapshot then deltas from snapshot's seq'." — but seq 0 is also the starting state. If a fresh client attaches BEFORE any delta has been emitted (session just spawned, claude hasn't output yet), there is no `pty_snapshot` row. Daemon decision tree branch: "snapshot := load latest pty_snapshot for session" → returns nothing. Spec doesn't say what happens. Pin: daemon emits an empty SnapshotV1 (correct geometry, empty cells) on first attach when no snapshot exists.

## Summary

P0 count: 3 (encoder non-determinism unspecified; no decoder spec; daemon-restart-replay untested)
P1 count: 6
P2 count: 1

Most-severe one-liner: **The 1-hour soak gate compares two SnapshotV1 byte strings, but the encoder isn't specified to be deterministic, no decoder is specified at all, and the daemon-restart path that the gate's whole premise rides on isn't tested.**
