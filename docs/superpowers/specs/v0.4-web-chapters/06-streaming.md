# 06 — Streaming and multi-client coherence

## Context block

ccsm has 11 server-streaming surfaces (chapter 03 §1 inventory): PTY output, PTY exit, session state changes, session title updates, session cwd-redirected, session-activate, notify flash, updater status, updater downloaded, window-maximized-changed, window-before/after-show. The PTY stream is the most demanding (binary bytes, high throughput, multi-client coherence required); the rest are low-volume control streams. v0.4 carries v0.3's headless-buffer + seq-replay design forward (it was already lifted into the daemon; v0.4 just reframes it on top of Connect). The novel work is **(a)** mapping streams onto Connect server-streaming over HTTP/2, **(b)** keeping streams alive through Cloudflare's 100s idle timeout, and **(c)** ensuring desktop + web clients on the same session see a coherent view.

## TOC

- 1. Stream model: Connect server-streaming over HTTP/2
- 2. PTY chunk message shape (binary bytes, no JSON re-encoding)
- 3. PTY input model (unary message-per-keystroke-batch, not bidi stream)
- 4. Heartbeat (90s) for Cloudflare 100s idle dodge
- 5. Multi-client coherence (xterm-headless authoritative buffer)
- 6. Reconnect + seq replay (`fromSeq`)
- 7. Backpressure / drop-slowest (carryover from v0.3)
- 8. Non-PTY streams (session state, notify flash, etc.)

## 1. Stream model: Connect server-streaming over HTTP/2

**Decision (lock):** every server-stream RPC is declared in `proto/` as `rpc Foo(FooRequest) returns (stream FooEvent);`. Connect over HTTP/2 carries it natively — one HTTP/2 stream per RPC call, server pushes message frames, client reads them as an async iterable.

**Why server-streaming (not bidi):** Connect-Web is half-duplex (chapter 02 §1). Bidi requires server-side to support upgrade negotiation that browsers can't initiate. PTY input over a separate unary RPC (§3) avoids the bidi requirement entirely.

**Stream lifecycle:**
- Client opens stream via `client.streamPty({ sessionId, fromSeq?: 0 })`.
- Server pushes `PtyEvent` messages until either: (a) client closes (e.g. user navigates away), (b) session exits (server pushes one final `PtyEvent { kind: EXIT }` then closes), or (c) network drops (HTTP/2 stream RST).
- Client iterates: `for await (const evt of stream) { ... }`. Iterator throws on network drop; UI catches and triggers reconnect (§6).

**Why one stream per (sessionId, client):** simplest mental model. Multi-session subscriptions are N parallel streams, not one fat stream with discriminators. HTTP/2 multiplexes them on the same connection at zero per-stream cost.

**Why not Connect's `BidiStream` for input+output:** would force the daemon to keep a "client connection" object per session per client and route incoming PTY-input back to the right session. Unary input + server-streaming output is cleaner and scales identically (HTTP/2 handles N concurrent streams).

## 2. PTY chunk message shape

`pty.proto`:
```proto
message PtyEvent {
  uint64 seq = 1;                // monotonic per-session, set by daemon
  uint64 boot_nonce = 2;         // daemon-process boot identity (chapter 07 §1)
  oneof payload {
    PtyChunk chunk = 10;          // most common: terminal output bytes
    PtyExit exit = 11;            // session exit
    PtyResize resize_ack = 12;    // ack of remote resize
    PtyHeartbeat heartbeat = 13;  // 90s keepalive (§4)
  }
}

message PtyChunk {
  bytes data = 1;                // raw terminal bytes (UTF-8 OR binary)
}

message PtyExit {
  optional int32 code = 1;
  optional int32 signal = 2;
}
```

**Why `bytes` (not `string`) for `data`:** Protobuf `string` requires valid UTF-8. Terminal bytes from `node-pty` may contain partial UTF-8 sequences across chunk boundaries. `bytes` accepts any sequence; client reassembles UTF-8 in xterm.js as today.

**Why no JSON re-encoding:** v0.3 §3.4.1.c carved out a binary-trailer envelope to avoid `JSON.stringify(buffer)`. Protobuf `bytes` is binary natively — wire size = chunk size + ~5 bytes proto framing. ~30% reduction vs base64-in-JSON, ~5-30 ms saved per 64 KiB chunk per v0.3 measurement.

**Why include `seq` and `boot_nonce` in every event:** seq for replay (§6); boot_nonce so the client detects "daemon restarted; my seq cursor is stale" and re-snapshots instead of asking for a seq the new daemon doesn't have.

**Why `oneof` rather than separate stream RPCs:** keeps PTY events on one stream (one HTTP/2 stream, one client iterator). Adding new event kinds (e.g. v0.5 `OscClipboard` for OSC52 clipboard pass-through) is a `oneof` extension — additive, non-breaking.

## 3. PTY input model: unary message-per-keystroke-batch

PTY input is **NOT** a stream. Each input goes via:
```proto
rpc SendPtyInput(SendPtyInputRequest) returns (SendPtyInputResponse);

message SendPtyInputRequest {
  string session_id = 1;
  bytes data = 2;
}
message SendPtyInputResponse {}
```

**Why unary:**
- Connect-Web doesn't support client-streaming.
- Per-keystroke unary RPCs over HTTP/2 are cheap (multiplexed on the existing connection, no new TCP/TLS handshake).
- Daemon serializes inputs into the per-session PTY input queue in arrival order; clients can't reorder.

**Batching at the renderer:** xterm.js fires `onData` per keystroke. The bridge wrapper batches with a 5ms coalescing window (`requestAnimationFrame`-aligned) so paste-of-large-text becomes 1-3 RPCs instead of N. This is an optimization layered over the bridge; daemon sees a few-byte chunk per RPC either way.

**Why 5ms coalesce, not 16ms (one frame):** typing latency below 16ms is invisible; above is felt. 5ms gives paste batching without adding noticeable per-keystroke delay.

**Backpressure on input:** if the daemon is slow to ack, the bridge queues (max 256 KiB; reject further with a UI banner). Realistically input throughput is human-scale and never hits this.

## 4. Heartbeat (90s) for Cloudflare 100s idle dodge

**Problem:** Cloudflare Tunnel kills HTTP/2 streams after 100s of no traffic in either direction. A user who opens a session, walks away for 2 minutes, comes back and types — without heartbeat, the stream is dead and they'd see no output.

**Decision (lock):** the daemon emits a `PtyHeartbeat` event on every active PTY stream at most every **90 seconds** of idle (no other event sent). 90s = comfortable margin under 100s.

```proto
message PtyHeartbeat {
  // empty — presence is the signal. seq + boot_nonce on PtyEvent
  // wrapper carry the freshness info needed for liveness checks.
}
```

**Implementation:** per-stream `setInterval(emitHeartbeatIfIdle, 30_000)` — the timer ticks frequently to give jitter resistance, but only emits when "elapsed since last event" > 60s (so the actual cadence is 60-90s). Easier to reason about than tracking exact 90s windows.

**Heartbeat on non-PTY streams:** same rule — every server-stream RPC emits a stream-specific `Heartbeat` `oneof` member every 60-90s. Cheap (~50 bytes/min/stream).

**Client-side liveness check:** if no event (including heartbeat) received for 120s, client treats stream as dead and triggers reconnect. The 120s timeout = 90s heartbeat + 30s grace for network jitter.

**Why server-driven heartbeat (not client ping):** Connect-Web has no client-streaming, so client can't push periodic pings on the same RPC. Server-driven is the only path on Connect-Web.

**Why not an HTTP/2 PING frame:** Connect doesn't expose PING frame access; HTTP/2 PINGs are at the transport layer and don't reset the application's idle timer for this purpose. App-level heartbeat is the documented Cloudflare workaround.

## 5. Multi-client coherence (xterm-headless authoritative buffer)

**v0.3 already implemented this:** the daemon runs `xterm-headless` per session, maintains the authoritative terminal buffer, and serializes it on snapshot. PRs L4 PR-A..E (commits 49353a9, 9971733, 64b5248) landed it. v0.4 reuses unchanged.

**Coherence guarantees:**
1. **Buffer state** is the daemon's `xterm-headless` instance. PTY bytes from `node-pty` are written into it; xterm-headless processes ANSI escapes and updates its grid.
2. **Each subscriber** (Electron, web, future client) on `streamPty(sessionId, fromSeq)` receives:
   - First message: a synthetic snapshot event (the serialized headless buffer up to `currentSeq`), if `fromSeq <= currentSeq - bufferDepth` or `fromSeq == 0`.
   - Subsequent messages: live `PtyChunk` events with `seq > snapshotSeq`.
3. **Inputs** from any client go through `SendPtyInput` → daemon's per-session PTY input queue → `node-pty` write. Single source of truth; no input merge conflict possible (a stream of bytes has total order in arrival).
4. **Outputs** from `node-pty` are fanned out: written to xterm-headless (updates buffer) AND emitted on every active subscriber's stream with the same `seq`. Both clients see identical bytes in identical order.

**Snapshot generation:** existing `pty.snapshotSemaphore` (v0.3 `daemon/src/pty/snapshot-semaphore.ts`) ensures only one serialize-buffer call runs at a time per session. Snapshot RPC `GetPtySnapshot(sessionId)` returns `{ snapshot: bytes, seq: uint64, bootNonce: uint64 }`. Clients call it on initial attach if they have no prior seq.

**Why xterm-headless is authoritative (not raw byte log):** ANSI sequences are stateful (cursor position, color, mode bits). Two clients joining at different points see different "current state" if they each interpret raw bytes from a fixed point. The daemon-side headless terminal interprets once; clients receive either a serialized state OR live deltas from that state, never both diverging.

**Concurrent inputs from desktop + web:** the daemon's PTY input queue is FIFO in receipt order. Two clients typing simultaneously interleave at character boundaries (just like two people typing on the same shell). This matches user expectations for a "shared session" model.

## 6. Reconnect + seq replay (`fromSeq`)

**Client-side flow on stream loss:**
1. Stream iterator throws (network drop, daemon restart, Cloudflare idle kill not caught by heartbeat).
2. Client retains last-seen `seq` for the session in memory (`lastSeenSeq[sessionId]`).
3. After reconnect-backoff (exp 1s → 5s → 30s → ...), client opens new `streamPty({ sessionId, fromSeq: lastSeenSeq + 1 })`.
4. Daemon checks: do I still have `boot_nonce` matching what client knew? Do I still have `seq >= fromSeq` in my fanout buffer?
   - **Yes + yes:** replay events from `fromSeq` to `currentSeq`, then continue live stream.
   - **No (boot_nonce mismatch — daemon restarted):** force re-snapshot. Stream first event is a `PtySnapshot` event (the full serialized buffer), seq is the daemon's current seq.
   - **Boot_nonce match but `seq < fromSeq` (gap; client missed too much):** force re-snapshot, same as above.
5. Client renders snapshot OR replays events into xterm.js, updates `lastSeenSeq`, resumes normal streaming.

**Replay budget cap (carryover from v0.3 frag-3.4.1.b):** daemon ships at most 256 KiB of replay before declaring `gap: true` and forcing a fresh snapshot. Prevents nodemon-storm reconnect into a hot stream looping drop-and-resubscribe.

**Why seq-based resume works for both clients:** it's a property of the daemon's fanout, not the transport. v0.3 designed it for the local socket; v0.4's Connect transport carries the seq numbers transparently in `PtyEvent.seq`.

## 7. Backpressure / drop-slowest (carryover from v0.3)

v0.3 `daemon/src/pty/drop-slowest.ts` enforces a 1 MiB per-subscriber buffer high-water mark. If a subscriber's outbound queue exceeds 1 MiB, the daemon drops events for that subscriber, marks `gap = true`, and forces re-snapshot on next event.

v0.4 carries this forward unchanged at the daemon. The Connect transport's flow control (HTTP/2 stream window) interacts naturally: if the client doesn't read fast enough, HTTP/2 stops accepting writes from the daemon's stream handler, the buffer fills, drop-slowest fires.

**Why keep drop-slowest at the application layer in addition to HTTP/2 flow control:** HTTP/2 windows are designed for fairness across streams on one connection, not for "one slow client should not balloon daemon memory". Application-layer drop is the safety net.

**Web client implication:** a backgrounded browser tab throttles its event loop. Slow event consumption → drop-slowest fires → snapshot on tab refocus. Acceptable: user comes back, sees current state, no lost work (input queue is server-side; only display state is rebuilt).

## 8. Non-PTY streams

Same model, lower stakes:

| Stream | Volume | Heartbeat needed? |
|---|---|---|
| `streamSessionStateChanges()` | 1-2 events/sec at most (state transitions) | Yes (idle for hours) |
| `streamSessionTitleUpdates()` | <1 event/min | Yes |
| `streamNotifyFlashes()` | 1-10 events/min | Yes |
| `streamUpdaterStatus()` | sparse (download progress when active) | Yes |
| `pty:exit` | One per session lifetime | Carried on the same `streamPty` stream |
| `session:cwdRedirected` | Rare (import edge case) | Folded into `streamSessionStateChanges` as a state-change variant |
| `session:activate` | User clicks notification | Folded into `streamNotifyFlashes` as a click event |
| `window:*` | Electron-only, stays on `ipcRenderer` (chapter 03 §2) | n/a |

**Why fold related streams:** fewer streams = fewer heartbeats + less per-stream overhead. The bridge surface (`onState`, `onTitle`, `onCwdRedirected`, `onActivate`) stays as separate listener-set fan-outs in the bridge file (per v0.3); the wire surface is the smaller folded set.

**Discrimination via `oneof`:** same pattern as PTY events. `SessionEvent { oneof { state_change, title_update, cwd_redirected, ... } }`.

**Heartbeat strategy:** every server-stream RPC has a `Heartbeat` member in its `oneof`. Daemon emits when stream is idle 60-90s. Same 120s client-side timeout.
