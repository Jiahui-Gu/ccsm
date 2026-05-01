# Review of chapter 06: Streaming and multi-client coherence

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P0-1 (BLOCKER): Snapshot-on-reconnect cost is unbounded; could ship 10+ MB on every flaky-network reconnect
**Where**: chapter 06 §5 ("Snapshot generation: existing `pty.snapshotSemaphore` ... Snapshot RPC `GetPtySnapshot(sessionId)` returns `{ snapshot: bytes, seq: uint64, bootNonce: uint64 }`.") and §6 ("force re-snapshot. Stream first event is a `PtySnapshot` event (the full serialized buffer), seq is the daemon's current seq.").
**Issue**: `xterm-headless` serialize-buffer with 10k lines scrollback (chapter 07 §3 + chapter 10 R5 confirm 10k default) at 200-cols-wide can produce a serialized state of **5-15 MB** uncompressed (each cell carries character + style attributes; `xterm-addon-serialize` output for a fully-populated 10k×200 grid is typically 8-12 MB). Per chapter 07 §3 (web client): "If reconnect succeeds after >30 minutes... Force re-snapshot" — over a flaky cellular tether, this means downloading a multi-MB serialized buffer over a possibly-slow link, possibly multiple times if reconnect itself flakes.

Multi-client amplifier: each web client tab-refresh triggers a snapshot fetch; tab-switching back and forth in the SPA on the session list can fan-out N snapshot RPCs in seconds.

The replay budget cap (§6: "256 KiB of replay before declaring `gap: true` and forcing a fresh snapshot") makes the snapshot path the **common** reconnect path, not the exception. Any drop > a few seconds at typical throughput exceeds 256 KiB.

Spec does not mention:
- Compression on the snapshot wire (Connect/HTTP/2 supports `gzip`/`identity` content-encoding; not stated for `bytes` payloads).
- Delta sync (snapshot once, then deltas — what xterm.js's serialize addon supports natively).
- Cap on snapshot size at the daemon (refuse to ship >X MB; truncate scrollback first).
**Why P0**: This is the dominant bandwidth + latency cost for the web client and it's invisible in the design. A user on cellular re-opening their session sees a multi-second white screen on every reconnect — directly contradicts success criterion 2 ("sees live PTY output... no daemon restart required" implies "feels responsive").
**Suggested fix**:
1. Mandate `Content-Encoding: gzip` on snapshot RPC responses in §5 (Connect supports it; one config line).
2. Cap snapshot size: if serialized buffer >2 MB, return only the visible viewport + last 1k lines of scrollback. Document the truncation.
3. Add a perf note: "Snapshot wire size target: ≤500 KB gzipped p95, ≤2 MB hard cap. Measured in M4 dogfood gate."
4. Consider lowering scrollback default from 10k to 5k lines for new sessions (configurable, but default smaller).

### P0-2 (BLOCKER): Multi-client fanout has no per-session subscriber cap; reconnect storm unbounded
**Where**: chapter 06 §5 ("Each subscriber (Electron, web, future client) on `streamPty(sessionId, fromSeq)` receives...") and §7 ("Per-subscriber 1 MiB watermark").
**Issue**: The per-subscriber 1 MiB cap protects daemon memory **per subscriber** but does nothing about **subscriber count**. A misbehaving web client (e.g. SPA bug that opens then immediately reopens streams) can rack up N subscribers per session × M sessions, each with their own buffer. The fanout-registry needs an explicit cap.

Reconnect storm scenario: Cloudflare edge has a 10s blip → all of the user's open tabs (laptop browser, phone browser, second laptop) reconnect simultaneously → daemon serves N snapshot RPCs concurrently (each is multi-MB per P0-1) → Connect-Node's `Http2Server` thread (single-threaded Node) is pegged on serialize+gzip → control socket may also hang (shared event loop) → supervisor `/healthz` poll times out → Electron supervisor decides daemon is dead and respawns it → boot_nonce changes → all clients now must re-snapshot from a cold daemon. Cascading.

Spec mentions §7 "drop-slowest" handling per-subscriber but not the **collective** load.
**Why P0**: A single user with 3 devices and a flaky network can DoS their own daemon. Multi-client coherence is the headline feature; this is the path to it failing under realistic conditions.
**Suggested fix**:
1. Add per-session subscriber cap (e.g. `MAX_SUBSCRIBERS_PER_SESSION = 8`) in §5; reject new subscribes with `resource_exhausted`.
2. Add total-subscribers cap across daemon (e.g. 64).
3. Snapshot RPC concurrency limit: serialize at most 2 snapshots in flight daemon-wide (queue the rest); deduplicate identical-session-snapshot requests within 1s window.
4. Document the cascading-respawn risk in chapter 07 §1 and add a §1.5 "supervisor `/healthz` MUST have a longer timeout than worst-case snapshot serialize time".

### P1-1 (must-fix): Heartbeat strategy multiplies costs across N streams, no aggregation
**Where**: chapter 06 §4 ("per-stream `setInterval(emitHeartbeatIfIdle, 30_000)`") and §8 ("Same 120s client-side timeout").
**Issue**: With ~11 server-streams (chapter 03 §1) per session × M sessions × K clients, `setInterval` count grows quickly. 5 sessions × 2 clients × 11 streams = 110 active timers, each ticking every 30s. Node's timer wheel handles this, but every tick:
- Checks "elapsed since last event"
- If idle, allocates a new `PtyEvent` / `SessionEvent` proto, encodes, writes to socket
- Touches the per-stream state in fanout-registry

Plus the **client-side** 120s liveness timer × the same fan-out factor. On the web client this means 110 setIntervals running in a possibly-throttled tab.

Cloudflare bandwidth angle: 110 streams × heartbeat every 90s × ~50 bytes proto-encoded = ~3 KB/min just from heartbeats. Trivial in absolute terms but it's continuous traffic that prevents Cloudflare from idle-killing the underlying HTTP/2 connection (which is the **point**) — but ALSO contributes to the "always streaming" pattern that triggers the bandwidth concern in chapter 05 R4-1.
**Why P1**: Performance is OK at the small N stated; the design doesn't say what happens at 10+ sessions or what the actual cap is.
**Suggested fix**:
1. **Aggregate** heartbeats: one daemon-wide "I'm alive" timer that emits a single `Heartbeat` per active client connection (not per stream). Use HTTP/2 connection multiplexing — one timer fires, K streams emit (or zero if any other event already passed within the window).
2. Document the heartbeat cap: "Heartbeats use ≤500 bytes/min/active-client. Idle sessions consume zero."
3. Client-side liveness check should also collapse to per-connection, not per-stream.

### P1-2 (must-fix): PTY input batching window of 5ms is too aggressive for paste; can flood under burst
**Where**: chapter 06 §3 ("Batching at the renderer: xterm.js fires `onData` per keystroke. The bridge wrapper batches with a 5ms coalescing window... so paste-of-large-text becomes 1-3 RPCs instead of N.").
**Issue**: 5ms window is **too short** for paste batching. A 50 KB paste fires `onData` events typically over 20-100 ms (event loop scheduling). With a 5 ms window, the batches will be ~5-10 RPCs not "1-3". Each RPC pays JWT verify + interceptor stack + protobuf encode/decode. For paste of `npm install` output (10s of KB), this is dozens of unary RPCs.

Conversely 5ms is **too long** for typing — at 90 wpm = 130ms between keystrokes, every keystroke is its own batch (so the batch does nothing for typing).

Backpressure mention: "if the daemon is slow to ack, the bridge queues (max 256 KiB; reject further with a UI banner)." But what does "reject further" mean? Drop the input? Block the user's typing? Spec doesn't say.
**Why P1**: Mis-tuned batching directly impacts user-perceived input latency AND bandwidth. The 5ms claim doesn't match how `onData` actually fires.
**Suggested fix**:
1. Replace 5ms fixed window with: "coalesce until the input buffer is idle for ≥1 frame (16ms) OR the buffer reaches 4 KB, whichever comes first". This actually batches paste while not slowing typing.
2. On 256 KiB queue full: hold further input AND show an explicit "input throttled" indicator (not silent drop). Define the behavior.
3. Add a perf measurement: "Paste latency for 50 KB target: ≤200 ms first byte to PTY echo; measured in M3 dogfood".

### P2-1 (nice-to-have): `oneof` event encoding adds per-message tag overhead at high event rates
**Where**: chapter 06 §2 (PtyEvent oneof).
**Issue**: Every `PtyEvent` carries: `seq` (varint, 1-9 bytes), `boot_nonce` (varint, 1-9 bytes), oneof tag (1 byte) + payload. For a hot PTY emitting many small chunks (e.g. interactive shell output during compile), the per-message proto framing is ~5-15 bytes overhead vs the chunk itself. Compared to v0.3's binary trailer (~5 bytes), this is comparable, BUT no measurement.
**Why P2**: Likely fine; flag for measurement.
**Suggested fix**: Measure in M2 contract test: average bytes-overhead-per-PTY-byte for a representative compile-output workload; document in §2.

## Cross-file findings

**X-R4-E**: Snapshot truncation policy + scrollback default crosses chapters 06 §5/§6, 07 §3, and 10 R5. Single fixer.

**X-R4-F**: Heartbeat aggregation crosses chapters 05 §8 (idle timeout dodge) and 06 §4/§8. Single fixer.
