# R3 review — 06-pty-snapshot-delta

## P0-R3-06-01 — No backpressure / cap on `SendInput` to a hung claude CLI

R3 angle 5: claude CLI hangs / never reads input. The flow is `SendInput RPC → daemon → node-pty master.write(bytes)`. Node `net.Socket.write` (and the underlying PTY master) buffer to memory unbounded by default. If the user pastes a 100MB file (or claude is unresponsive while the user types steadily for hours), the daemon's RSS grows without limit until OOM kill.

The chapter pins delta segmentation (16ms / 16KiB) and snapshot cadence in detail but says NOTHING about the input direction. Spec MUST pick one of:

1. Cap pending input bytes per session (e.g., 1 MiB); above cap, return `RESOURCE_EXHAUSTED` from `SendInput` and let Electron surface a "session unresponsive" banner.
2. Block the unary RPC handler on `master.write` callback (await drain); high-water mark on the PTY master's writable buffer (Node `Writable` exposes `.writableHighWaterMark`).
3. Drop-with-warning policy with a counter exposed via metrics.

Without this, ship-gate (b) "daemon survives" can fail simply by running `cat large.bin | claude` while claude is in a tight loop — the daemon dies of OOM, not the test scenario. Also pairs with R3 angle 17 (need a metric for input-buffer depth).

Add to §1 or §3: "PTY input back-pressure: per-session pending-write byte cap = 1 MiB; SendInput RPC returns `RESOURCE_EXHAUSTED` when exceeded; daemon emits crash_log entry with source `pty_input_overflow`."

## P1-R3-06-02 — Snapshot write failure (disk full) handling unspecified

§4 says "On snapshot, the daemon writes a `pty_snapshot` row". §1 architecture diagram shows snapshots → SQLite. If SQLite write fails (disk full, IO error), the chapter does not say what happens to:

- The in-memory delta accumulator (does it keep growing because the snapshot didn't truncate? — yes, by §4 the prune is gated on a successful snapshot).
- The Attach stream subscribers (do they keep getting deltas? probably yes, but they'll never get a snapshot rotation).
- The session state (does it transition to CRASHED, or quietly degrade?).

R3 angle 6: disk full while writing snapshot must be a graceful degradation, not a daemon crash. Spec MUST say: "Snapshot write failure → emit `crash_log` entry with source `pty_snapshot_write` (NEW source — add to chapter 09 §1); session continues to stream deltas; in-memory delta ring is capped at N=4096 (per §1) so memory does not grow unbounded; on next attempt the snapshot is retried; if 3 consecutive snapshot writes fail the session transitions to a new `DEGRADED` state (which may require adding to SessionState enum chapter 04 §2 — and that is forever-stable, so ADD NOW, not in v0.4)."

Without this the disk-full scenario takes down ship-gate (c).

## P1-R3-06-03 — Multi-attach broadcast back-pressure underspecified

§6: "if one subscriber is slow, its stream falls behind; if it falls outside the retention window, the daemon closes its stream with `PreconditionFailed`". Two sub-issues:

1. The chapter does not say WHAT counts as "slow" mechanically. HTTP/2 flow-control window? Connect-node default writable HWM? Specify a per-subscriber buffer cap (e.g., 4096 deltas queued or 4 MiB) so behavior is reproducible across transports/OSes.
2. "Fall outside retention window" is checked on attach, not on every delta. A mid-stream subscriber can fall behind during the stream's lifetime — does the daemon detect this and close, or only on next attach? Be explicit.

## P1-R3-06-04 — Worker-thread crash recovery does not detail in-flight delta loss

§1 says "A worker crash takes down only one session; `worker.on('exit')` triggers a `crash_log` entry + session state → `CRASHED`." But the worker holds the in-memory state since the last snapshot — on crash, those bytes may not have hit SQLite (the main-thread coalescer's 16ms tick may have un-flushed batches). The chapter does NOT specify:

- Whether the recovered session (after worker crash + claude CLI still alive) replays a fresh snapshot from scratch (lossy) or attempts to reconstruct from SQLite-persisted deltas alone (also lossy if pre-snapshot deltas were lost).
- What the client sees (the existing Attach stream gets terminated; client reattaches; gets old snapshot + missing-deltas-window).

Pair with R3 angle 1 (daemon crash mid-PTY-write — same root cause, same gap). Spec should say: "Worker crash → daemon kills the `claude` CLI subprocess for that session, marks state CRASHED, persists. User must explicitly recreate session." OR specify a recovery path. Currently ambiguous — implementer will guess wrong.

## P1-R3-06-05 — Ship-gate (c) byte-equality is server-side only

§8 step 6: "Compare against the client-side xterm-headless Terminal state (after replaying every applied frame from boot)." Step 7: "Assert SnapshotV1 byte-equality."

The harness compares the daemon-side state to the client-side state. But the comparator is the SnapshotV1 codec — chapter 14 spike [snapshot-roundtrip-fidelity] is NOT YET RESOLVED. If the spike fails (encode/decode/encode is NOT byte-identical), this entire ship-gate is invalid. The chapter acknowledges this by listing the spike, but the test plan has no fallback — if the spike fails, what does ship-gate (c) test?

Recommend §8 add a backstop assertion that does NOT depend on the codec: a deterministic checksum of (cells × attrs × cursor × scrollback) computed by walking xterm-headless's public API on both sides. Two independent comparators (binary equality + cell-walk checksum) catch codec bugs that binary equality alone misses by definition.

## P2-R3-06-06 — In-memory delta ring (N=4096) interacts unspecified with SQLite delta retention (DELTA_RETENTION_SEQS=4096)

§1 mentions "in-memory ring of last N deltas (N = 4096)"; §4 mentions "DELTA_RETENTION_SEQS = 4096". These look identical and may be intended to be the same value, but the chapter does not say so. If they diverge in implementation (one tuned, the other not), reattach behavior changes. Spec should say "the in-memory ring and the on-disk retention window are the same N — use one constant".
