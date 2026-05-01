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
- 9. Testability seams (hermetic harness hooks)

## Glossary (terminology key)

- **Client** = an app instance (one Electron process, one browser tab). A client may hold many open streams.
- **Subscriber** = one open server-stream RPC on one session by one client. One client subscribed to N sessions = N subscribers. Per-subscriber memory caps (§7) and the fanout registry (§5) are keyed by subscriber, not client.
- **Connection** = the underlying HTTP/2 connection. One client typically uses one HTTP/2 connection multiplexing many subscribers.

**Field-naming convention (proto ↔ TS):** proto fields use `snake_case` per Buf/Google style; `protoc-gen-es` codegen exposes them in TS as `camelCase` (proto `boot_nonce` → TS `bootNonce`; proto `session_id` → TS `sessionId`). RPC method names are PascalCase in proto and camelCase on the TS client (`rpc StreamPty(...)` → `client.streamPty(...)`).

## 1. Stream model: Connect server-streaming over HTTP/2

**Decision (lock):** every server-stream RPC is declared in `proto/` as `rpc Foo(FooRequest) returns (stream FooEvent);`. Connect over HTTP/2 carries it natively — one HTTP/2 stream per RPC call, server pushes message frames, client reads them as an async iterable.

**Why server-streaming (not bidi):** Connect-Web is half-duplex (chapter 02 §1). Bidi requires server-side to support upgrade negotiation that browsers can't initiate. PTY input over a separate unary RPC (§3) avoids the bidi requirement entirely.

**Stream lifecycle:**
- Client opens stream via `client.streamPty({ sessionId, fromSeq?: 0 })`.
- Server pushes `PtyEvent` messages until either: (a) client closes (e.g. user navigates away), (b) session exits (server pushes one final `PtyEvent { kind: EXIT }` then closes), or (c) network drops (HTTP/2 stream RST).
- Client iterates: `for await (const evt of stream) { ... }`. Iterator throws on network drop; UI catches and triggers reconnect (§6).

**Why one stream per (sessionId, client):** simplest mental model. Multi-session subscriptions are N parallel streams, not one fat stream with discriminators. HTTP/2 multiplexes them on the same connection at zero per-stream cost.

**Why not Connect's `BidiStream` for input+output:** would force the daemon to keep a "client connection" object per session per client and route incoming PTY-input back to the right session. Unary input + server-streaming output is cleaner and scales identically (HTTP/2 handles N concurrent streams).

**Per-session authorization hook (forward-compat for multi-user, chapter 01 N2):** every stream/RPC handler that takes a `session_id` MUST invoke `authorizeSessionAccess(jwtPayload, sessionId)` before delivering any data or accepting any input. v0.4 implementation is `return true` unconditionally (single-user model — only one authorized identity); v0.5+ replaces this hook with per-user/per-session ACL without changing call sites. The hook MUST be in place from M4 ship; chapter 08 contract test asserts the hook is invoked on `streamPty`, `SendPtyInput`, and `GetPtySnapshot`. This forecloses the foreseeable-soon gap where Cloudflare Access policy adds a second email and both users would otherwise see ALL sessions. Cross-ref: chapter 05 §4 (JWT interceptor populates `jwtPayload` in the request context — the hook's input source); chapter 01 N2 (multi-user enablement requires this hook to be made real).

**Per-session subscriber cap (DoS / reconnect-storm guard, see also §7):** the fanout registry enforces `MAX_SUBSCRIBERS_PER_SESSION = 8` and a daemon-wide `MAX_TOTAL_SUBSCRIBERS = 64`. New `streamPty` subscribes beyond either cap are rejected with Connect `resource_exhausted`. This bounds the cost of a misbehaving SPA that opens-then-reopens streams in a loop.

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
    PtyHeartbeat heartbeat = 13;  // 60-90s keepalive (§4)
    PtySnapshot snapshot = 14;    // initial / forced re-snapshot payload (§5, §6)
    PtyGap gap = 15;              // drop-slowest signal (§7) — client must re-snapshot
  }
}

message PtyChunk {
  bytes data = 1;                // raw terminal bytes (UTF-8 OR binary)
}

message PtyExit {
  optional int32 code = 1;
  optional int32 signal = 2;
}

message PtySnapshot {
  bytes data = 1;                // serialized xterm-headless buffer (gzip wire-encoded)
  bool truncated = 2;             // true if scrollback was truncated to fit cap (§5)
  uint32 viewport_cols = 3;
  uint32 viewport_rows = 4;
}

message PtyGap {
  string reason = 1;             // "drop_slowest" | "boot_nonce_mismatch" | "fromSeq_too_old"
}
```

**Why `bytes` (not `string`) for `data`:** Protobuf `string` requires valid UTF-8. Terminal bytes from `node-pty` may contain partial UTF-8 sequences across chunk boundaries. `bytes` accepts any sequence; client reassembles UTF-8 in xterm.js as today.

**Why no JSON re-encoding:** v0.3 §3.4.1.c carved out a binary-trailer envelope to avoid `JSON.stringify(buffer)`. Protobuf `bytes` is binary natively — wire size = chunk size + ~5 bytes proto framing. ~30% reduction vs base64-in-JSON, ~5-30 ms saved per 64 KiB chunk per v0.3 measurement. M2 contract test measures `bytes-overhead-per-PTY-byte` for a representative compile-output workload and records it in the perf baseline (R4 P2-1 follow-up).

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

**Batching at the renderer (v0.4 introduction; required by Connect-Web's unary input model):**

**Provenance:** v0.3 sent each keystroke as a separate IPC envelope (no coalescing — local socket cost was negligible). v0.4 introduces input coalescing because per-keystroke unary RPCs over Cloudflare Tunnel pay a JWT-verify + interceptor + protobuf encode/decode cost per RPC, so paste-of-large-text without batching would saturate the tunnel. This is the smallest behavioral change consistent with the new transport.

**Coalescing rule (lock, replaces the earlier 5ms-fixed-window proposal — R4 P1-2):** xterm.js fires `onData` per keystroke. The bridge wrapper coalesces by:
- Flush when the input buffer has been **idle for ≥ 1 frame (16ms)**, OR
- Flush when the buffer reaches **4 KB**, whichever comes first.

This yields 1-2 RPCs for typical paste of `npm install` output (10s of KB) — far better than the 5-10 RPCs a 5ms window would produce — while keeping typing latency invisible (a single keystroke flushes after one frame of idle, ≤16 ms).

**Why not a fixed 5ms window:** at 5ms, paste fires 5-10 RPCs because `onData` events are spread over 20-100ms by event-loop scheduling, AND every typing keystroke is its own batch (so 5ms does nothing for typing). Idle-detect + size cap is the right shape.

**Daemon-side per-client rate cap:** `SendPtyInput` is rate-limited to 200 RPCs/sec per client (burst 1000); over-cap returns Connect `resource_exhausted`. Per-session PTY input queue is capped at 1 MiB; further input rejected with `resource_exhausted` until drained. (R2 P2-1 defense-in-depth against compromised clients.)

**Backpressure on input:** if the daemon is slow to ack and the bridge's outbound queue exceeds 256 KiB, the bridge **holds further input** and shows an explicit "input throttled — daemon backpressure" banner in the terminal chrome. The bridge does NOT silently drop input. User can dismiss the banner; new input is held (not dropped) until the queue drains. Realistically input throughput is human-scale and never hits this.

**Perf gate (M3 dogfood):** paste-50 KB latency target ≤ 200 ms first-byte-to-PTY-echo measured on a Cloudflare-Tunnel'd web client over typical broadband.

## 4. Heartbeat (60-90s) for Cloudflare 100s idle dodge

**Problem:** Cloudflare Tunnel kills HTTP/2 streams after 100s of no traffic in either direction. A user who opens a session, walks away for 2 minutes, comes back and types — without heartbeat, the stream is dead and they'd see no output.

**Decision (lock):** the daemon emits a `PtyHeartbeat` event on every active PTY stream when it has been idle (no other event sent) for >60s, with a hard ceiling of 90s. 90s = comfortable margin under 100s. Same rule on every server-stream RPC (`oneof` member named `heartbeat`).

```proto
message PtyHeartbeat {
  // empty — presence is the signal. seq + boot_nonce on PtyEvent
  // wrapper carry the freshness info needed for liveness checks.
}
```

**Heartbeat aggregation (R4 P1-1, lock):** heartbeat scheduling is **per-connection, not per-stream**. The daemon runs ONE timer per active HTTP/2 connection (= per client) ticking every 30s. On tick, it walks the connection's open streams; for each stream idle >60s it emits one heartbeat on that stream. K subscribers on one connection share one timer instead of K timers. This collapses the worst-case "5 sessions × 2 clients × 11 streams = 110 timers" down to "≤ K active connections" timers.

Client-side liveness check is symmetric: one timer per HTTP/2 connection walks its streams and resets a per-stream `lastSeenAtMs` on every received message. Heartbeat budget cap: ≤500 bytes/min/active-client. Idle sessions consume zero (no traffic at all once last subscriber detaches).

**Client-side liveness check:** the per-stream `lastSeenAtMs` is **reset on every received message** — chunk, exit, snapshot, gap, resize_ack, OR heartbeat. NOT only on heartbeat (a high-throughput stream doesn't emit heartbeats and must not falsely flag dead). If `now - lastSeenAtMs > 120s`, client treats stream as dead and triggers reconnect (§6). 120s = 90s heartbeat ceiling + 30s grace for network jitter.

**Observability (R3 P1-2 follow-up):** the bridge logs every reconnect with a distinct trace category `stream_liveness_reconnect` carrying `{ sessionId, lastSeenAgeMs, lastEventKind, heartbeatsReceived, heartbeatsExpected }`. Daemon emits `pino.debug({ event: 'heartbeat_emitted', sessionId, connectionId, idleMs })` so dogfood can detect heartbeat storms and silent stream death without inferring from output shape. Per-stream "heartbeats received vs expected" counter is exposed via the daemon `/stats` endpoint (chapter 05).

**Why server-driven heartbeat (not client ping):** Connect-Web has no client-streaming, so client can't push periodic pings on the same RPC. Server-driven is the only path on Connect-Web.

**Why not an HTTP/2 PING frame:** Connect doesn't expose PING frame access; HTTP/2 PINGs are at the transport layer and don't reset the application's idle timer for this purpose. App-level heartbeat is the documented Cloudflare workaround.

**Test-mode interval override (R5 P1-1):** all heartbeat intervals are read from env vars at daemon boot — `CCSM_HEARTBEAT_IDLE_MIN_MS` (default 60_000), `CCSM_HEARTBEAT_IDLE_MAX_MS` (default 90_000), `CCSM_HEARTBEAT_TICK_MS` (default 30_000), and the client-side liveness `CCSM_LIVENESS_TIMEOUT_MS` (default 120_000). E2E harness sets these to 60/90/30/120 *milliseconds* so the "stream-stays-alive-across-idle" case runs in <1s instead of >100s. See §9 and chapter 08 §5 (`web-heartbeat-survives-idle`).

## 5. Multi-client coherence (xterm-headless authoritative buffer)

**v0.3 already implemented this:** the daemon runs `xterm-headless` per session, maintains the authoritative terminal buffer, and serializes it on snapshot. PRs L4 PR-A..E (commits 49353a9, 9971733, 64b5248) landed it. v0.4 reuses unchanged.

**Coherence guarantees:**
1. **Buffer state** is the daemon's `xterm-headless` instance. PTY bytes from `node-pty` are written into it; xterm-headless processes ANSI escapes and updates its grid.
2. **Each subscriber** (Electron, web, future client) on `streamPty(sessionId, fromSeq)` receives:
   - First message: a synthetic `PtySnapshot` event (the serialized headless buffer up to `currentSeq`), if `fromSeq <= currentSeq - replayBufferDepth` or `fromSeq == 0`.
   - Subsequent messages: live `PtyChunk` events with `seq > snapshotSeq`.
3. **Inputs** from any client go through `SendPtyInput` → daemon's per-session PTY input queue → `node-pty` write. Single source of truth; no input merge conflict possible (a stream of bytes has total order in arrival).
4. **Outputs** from `node-pty` are fanned out: written to xterm-headless (updates buffer) AND emitted on every active subscriber's stream with the same `seq`. Both clients see identical bytes in identical order.

**Snapshot generation:** existing `pty.snapshotSemaphore` (v0.3 `daemon/src/pty/snapshot-semaphore.ts`) ensures only one serialize-buffer call runs at a time per session. Snapshot RPC `GetPtySnapshot(sessionId)` returns `{ snapshot: bytes, seq: uint64, bootNonce: uint64, truncated: bool }`. Clients call it on initial attach if they have no prior seq (or receive it inline as the first `PtySnapshot` event when the daemon force-snapshots, §6).

**Snapshot size cap and truncation (R4 P0-1, lock):**
- Snapshot RPC responses MUST be wire-compressed: Connect server sets `Content-Encoding: gzip` for `PtySnapshot` payloads (the `bytes` field is highly compressible — repeated empty cells, small ANSI palette).
- **Hard cap: 2 MiB compressed.** If the serialized buffer exceeds 2 MiB even after gzip, the daemon truncates scrollback (oldest lines first) until under cap, sets `PtySnapshot.truncated = true`, keeps the visible viewport plus the most recent 1k lines minimum.
- **Soft target: ≤ 500 KiB gzipped p95.** Measured in M4 dogfood gate.
- Default scrollback in v0.4 is reduced from 10k to **5k lines** for new sessions (configurable via session settings; existing sessions keep their setting). Smaller default = lower steady-state snapshot cost without losing the "scroll back through last hour" workflow.
- Snapshot RPC concurrency: at most **2 snapshots in flight daemon-wide**; further requests queue. Identical-session snapshot requests within a 1s window are deduplicated (one serialize, fan-out the result). Prevents the cascading-respawn scenario where N reconnecting clients peg the single-threaded Node event loop on serialize+gzip and starve `/healthz` (chapter 07 §1.5 mandates supervisor `/healthz` timeout > worst-case snapshot serialize time).

**Replay buffer (per-session, R3 P0-1, lock):** separate from per-subscriber drop-slowest (§7). The daemon retains a per-session **ring buffer of the most recent 4 MiB of PTY events** (chunks + their seq numbers). Reconnect with `fromSeq` older than the ring tail ⇒ the daemon emits `PtyGap { reason: "fromSeq_too_old" }` followed by a `PtySnapshot` event. Ring depth in seconds is a function of session output rate: ~10s of seconds for a hot stream (compile output), hours for an idle shell. Math: at hot-stream 100 KiB/s the ring covers ~40s; at idle 100 B/s it covers ~12 hours. The 4 MiB number balances against §7's 1 MiB per-subscriber drop-slowest (4× headroom) and chapter 10 R5 daemon memory cap.

The 256 KiB "replay budget" mentioned in §6 is the per-reconnect REPLAY-BURST cap (don't ship more than 256 KiB inline before just sending a snapshot). The 4 MiB ring buffer is the RETENTION cap (don't keep more than 4 MiB of replayable history per session). Both apply.

**Why xterm-headless is authoritative (not raw byte log):** ANSI sequences are stateful (cursor position, color, mode bits). Two clients joining at different points see different "current state" if they each interpret raw bytes from a fixed point. The daemon-side headless terminal interprets once; clients receive either a serialized state OR live deltas from that state, never both diverging.

**Concurrent inputs from desktop + web:** the daemon's PTY input queue is FIFO in receipt order. Two clients typing simultaneously interleave at character boundaries (just like two people typing on the same shell). This matches user expectations for a "shared session" model.

**Lag asymmetry note:** Electron on local socket sees microsecond-latency input; web client over Cloudflare Tunnel sees 10-40ms RTT (chapter 05 §8). When both type "abc" simultaneously, Electron's keystrokes consistently land first in the daemon's PTY queue. This is intrinsic to the transport, not a bug, but the daemon exposes per-client input counters via `/stats` (cross-ref chapter 05 §5 stats endpoint) so user reports of "lost keystrokes" can be diagnosed: `inputs_received[clientId]` vs `inputs_acked[clientId]` per session lets dogfood tell daemon-side drop apart from xterm.js dedup or web-side queue overflow (R3 P1-3).

**R1 framing (concurrent-input behavior is a v0.4 emergent property, not a feature change):** this concurrent-input behavior is observable only because v0.4 adds a second client. It is NOT a feature change to single-client behavior — Electron-only behavior is identical to v0.3. Documented as R14 in chapter 10.

**Snapshot semaphore observability (R3 P2-1):** the daemon emits `pino.debug({ event: 'snapshot_queued', sessionId, queueDepth, waitMs })` on every snapshot request that queues behind the semaphore. Lets dogfood detect snapshot-storm scenarios (N tabs reconnecting) before they manifest as user-visible lag.

## 6. Reconnect + seq replay (`fromSeq`)

**Client-side flow on stream loss:**
1. Stream iterator throws (network drop, daemon restart, Cloudflare idle kill not caught by heartbeat).
2. Client retains last-seen `seq` for the session in memory (`lastSeenSeq[sessionId]`).
3. After reconnect-backoff (exp 1s → 5s → 30s → ...), client opens new `streamPty({ sessionId, fromSeq: lastSeenSeq + 1 })`.
4. Daemon checks: do I still have `boot_nonce` matching what client knew? Do I still have `seq >= fromSeq` in my fanout buffer?
   - **Yes + yes:** replay events from `fromSeq` to `currentSeq`, then continue live stream.
   - **No (boot_nonce mismatch — daemon restarted):** force re-snapshot. Stream first event is a `PtySnapshot` event (the serialized buffer subject to §5 truncation cap), seq is the daemon's current seq.
   - **Boot_nonce match but `seq < fromSeq` in ring (gap; client missed too much):** force re-snapshot, same as above. Daemon emits `PtyGap { reason: "fromSeq_too_old" }` first so the client can show a "session resynced — some history may be missing if `truncated`" indicator.
5. Client renders snapshot OR replays events into xterm.js, updates `lastSeenSeq`, resumes normal streaming.

**Replay budget cap (carryover from v0.3 frag-3.4.1.b):** daemon ships at most 256 KiB of replay before declaring `gap: true` and forcing a fresh snapshot. Prevents nodemon-storm reconnect into a hot stream looping drop-and-resubscribe. (Distinct from the 4 MiB retention ring in §5 — see the "Both apply" note there.)

**`boot_nonce` mismatch logging (R3 P2-2):** on boot_nonce mismatch the daemon emits `pino.info({ event: 'force_snapshot', sessionId, reason: 'boot_nonce_mismatch', clientBootNonce, currentBootNonce })`. From the user side a force-snapshot looks like a brief flicker; the log line gives root cause for debugging.

**Why seq-based resume works for both clients:** it's a property of the daemon's fanout, not the transport. v0.3 designed it for the local socket; v0.4's Connect transport carries the seq numbers transparently in `PtyEvent.seq`.

### 6.1 Startup-race semantics (daemon mid-boot reconnect, R3 P1-1)

After daemon crash + supervisor respawn, the daemon goes through SQLite migration (could take seconds), Connect server bind, and JWKS prefetch (chapter 05 §4). During this window, a reconnecting client lands on one of three observably-different states:

| State | Connect status | Distinguisher | Client behavior |
|---|---|---|---|
| **Listener not bound yet** | TCP `ECONNREFUSED` / HTTP/2 connect fails | Network-layer error (no Connect headers) | Exp-backoff (1s → 5s → 30s, capped 30s); show "connecting…" banner |
| **Migration pending** | `failed_precondition` with `Retry-After` header (chapter 02 §8 migration-gate interceptor) | Connect error code `failed_precondition` + `Retry-After: <seconds>` | Constant 2s backoff for up to 60s, then escalate to exp; show "starting up…" banner (NOT "unreachable") |
| **JWKS not loaded (boot window)** | `unauthenticated` with header `X-CCSM-Boot: starting` | Header presence distinguishes from real JWT-expired (which omits this header) | Same as migration-pending: constant 2s for up to 60s with "starting up…" banner |
| **JWT actually expired** | `unauthenticated` without `X-CCSM-Boot` header | No boot header | Trigger token refresh flow (chapter 05 §4) |

The daemon emits `X-CCSM-Boot: starting` on every response during the boot window (until JWKS loaded AND migrations complete) so clients can distinguish "daemon is coming up" from real auth/protocol failures without tight-looping retries that thrash daemon during boot. Boot-window duration is logged (`pino.info({ event: 'boot_window_closed', durationMs })`).

## 7. Backpressure / drop-slowest (carryover from v0.3)

v0.3 `daemon/src/pty/drop-slowest.ts` enforces a 1 MiB per-subscriber buffer high-water mark. If a subscriber's outbound queue exceeds 1 MiB, the daemon drops events for that subscriber, emits a `PtyGap { reason: "drop_slowest" }` event, and forces re-snapshot on next event.

v0.4 carries this forward unchanged at the daemon. The Connect transport's flow control (HTTP/2 stream window) interacts naturally: if the client doesn't read fast enough, HTTP/2 stops accepting writes from the daemon's stream handler, the buffer fills, drop-slowest fires.

**Why keep drop-slowest at the application layer in addition to HTTP/2 flow control:** HTTP/2 windows are designed for fairness across streams on one connection, not for "one slow client should not balloon daemon memory". Application-layer drop is the safety net.

**Web client implication:** a backgrounded browser tab throttles its event loop. Slow event consumption → drop-slowest fires → snapshot on tab refocus. Acceptable: user comes back, sees current state, no lost work (input queue is server-side; only display state is rebuilt).

**Subscriber count caps (cross-ref §1):** the per-subscriber 1 MiB watermark protects daemon memory per subscriber but does nothing about subscriber COUNT. The fanout registry enforces `MAX_SUBSCRIBERS_PER_SESSION = 8` and `MAX_TOTAL_SUBSCRIBERS = 64` (§1) — together with drop-slowest these bound worst-case daemon memory at `8 × 1 MiB × N_sessions` for the per-subscriber buffers, plus `4 MiB × N_sessions` for the replay rings (§5).

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

**Heartbeat strategy:** every server-stream RPC has a `Heartbeat` member in its `oneof`. Daemon emits per the per-connection aggregation rule in §4. Same 120s client-side timeout. Test-mode interval overrides (§4) apply uniformly across PTY and non-PTY streams.

### 8.1 Folded-stream bridge contract (R1 P2-1)

When the wire surface folds variants (e.g. `session:cwd_redirected` carried inside `SessionEvent.cwd_redirected` rather than its own RPC), the bridge MUST preserve the v0.3 listener-fan-out shape exactly:

1. **Variant-exact dispatch.** The bridge MUST emit on `onCwdRedirected` listeners ONLY when the wire variant is `cwd_redirected`. It MUST NOT fire `onCwdRedirected` for any other variant of the folded stream (state_change, title_update, etc.). Same rule for `onActivate` vs `streamNotifyFlashes` variants.
2. **No added latency.** Routing through a folded stream's discriminator MUST be synchronous (single switch on the `oneof` tag). No queuing, no microtask hop.
3. **Payload-shape invariance.** The payload object the bridge passes to listeners MUST be bit-for-bit identical to the v0.3 payload shape (same fields, same types). Folding is wire-only; the bridge surface MUST stay v0.3-compatible.

This contract is referenced from chapter 03 §4 (bridge surface stability rule) and is the regression check a future bridge-swap PR reviewer can grep for ("does the bridge emit `onCwdRedirected` on any non-cwd_redirected variant?"). Chapter 08 §3 contract test enforces all three rules.

## 9. Testability seams (hermetic harness hooks)

Stream correctness (replay, snapshot-vs-replay decision, drop-slowest, fanout cleanup, multi-client interleave) is the headline differentiator vs raw CLI and chapter 00 success-criterion #3/#4. Every behavior in §§4-7 MUST be hermetically testable in a fast harness (no real `node-pty`, no real Cloudflare, no 100s waits). This section locks the injection seams.

**9.1 FakePty (chapter 08 §3 harness fixture).** A `FakePty` fixture replaces `node-pty` in tests. It emits a deterministic byte sequence keyed by test scenario name (e.g. `"compile-output-100kb"`, `"interleave-input-stress"`). Bytes-to-seq mapping is stable across runs (no timing jitter from real PTY data events). Daemon code branches on `process.env.CCSM_FAKE_PTY=1` at session-spawn to wire FakePty in.

**9.2 Injectable boot_nonce.** Daemon exposes `__setBootNonceForTest(value: bigint)` (only present when `process.env.CCSM_TEST_HOOKS=1`). Lets tests simulate "daemon restart" by changing boot_nonce in-process without restarting the daemon. The replay-vs-snapshot decision then becomes deterministically assertable.

**9.3 Injectable buffer sizes.**
- `CCSM_TEST_REPLAY_RING_BYTES` (default 4 MiB; tests use 4 KiB to exercise ring-rollover in <1ms).
- `CCSM_TEST_DROP_SLOWEST_BYTES` (default 1 MiB; tests use 8 KiB to exercise drop-slowest with a tiny producer).
- `CCSM_TEST_REPLAY_BURST_BYTES` (default 256 KiB; tests use 2 KiB).
- `CCSM_TEST_SNAPSHOT_CAP_BYTES` (default 2 MiB; tests use 16 KiB to exercise truncation).

**9.4 Injectable heartbeat / liveness intervals.** Per §4: `CCSM_HEARTBEAT_IDLE_MIN_MS`, `CCSM_HEARTBEAT_IDLE_MAX_MS`, `CCSM_HEARTBEAT_TICK_MS`, `CCSM_LIVENESS_TIMEOUT_MS`. Default seconds; tests use the same numerals as milliseconds.

**9.5 Snapshot-vs-replay decision is logged.** On every reconnect the daemon emits exactly one of:
- `pino.debug({ event: 'reconnect_decision', sessionId, decision: 'replay', fromSeq, toSeq, bytes })`
- `pino.debug({ event: 'reconnect_decision', sessionId, decision: 'snapshot', reason: 'boot_nonce_mismatch' | 'fromSeq_too_old' | 'gap_drop_slowest', bytes })`

Tests assert on the log line directly via the structured-log capture sink, instead of trying to detect "did the client get a snapshot or replay?" from event shape (which is ambiguous for small replays).

**9.6 Per-client input counters.** Per §5 lag-asymmetry note, daemon exposes `inputs_received[clientId, sessionId]` and `inputs_acked[clientId, sessionId]` via `/stats`. Multi-client tests can assert "sent N, acked N" without trying to read the PTY back through xterm.

**9.7 Fanout subscriber tracking is observable.** Daemon exposes `getFanoutSubscriberCount(sessionId)` (only present when `CCSM_TEST_HOOKS=1`). Subscriber-leak test (chapter 08 §3) connects N clients, disconnects them across multiple modes (clean close, RST, idle-timeout, mid-stream-exception, force-snapshot-then-bail), asserts count returns to 0 within a bounded grace period.

**9.8 E2E case set this enables (chapter 08 §3 / §5 / §6, R5 P1-1 / P1-2 / P1-3 / P1-4).** Locks the minimum hermetic test set:
- `web-reconnect-exact-replay` (replay path with deterministic FakePty seq trail).
- `web-reconnect-force-snapshot` (boot_nonce mismatch via `__setBootNonceForTest`).
- `web-reconnect-fromSeq-too-old` (replay ring rollover via tiny `CCSM_TEST_REPLAY_RING_BYTES`).
- `web-heartbeat-survives-idle` (idle longer than `CCSM_HEARTBEAT_IDLE_MAX_MS=90` ms, stream stays alive).
- `web-liveness-timeout-triggers-reconnect` (silence > `CCSM_LIVENESS_TIMEOUT_MS=120` ms, client reconnects).
- `drop-slowest-fires-and-recovers` (slow consumer fixture, asserts `PtyGap`, asserts snapshot recovers).
- `fanout-subscriber-cleanup` (5 disconnect modes, asserts count=0 each time).
- **Multi-client coherence (4 cases, expanded from one):**
  - `simple-mirror`: Electron + web both attached, daemon echoes, both see identical bytes.
  - `interleaved-input`: A and B both type 100 alternating bytes, snapshot of PTY queue matches FIFO arrival.
  - `disconnect-while-other-active`: A disconnects mid-stream, B keeps streaming uninterrupted, fanout count drops by 1.
  - `slow-client-doesnt-affect-fast-client`: A is slow (stalled reader), B is live; A trips drop-slowest, B's stream is unaffected.
- `input-batching-coalesces-paste` (50 KB paste produces 1-2 RPCs, not 5-10; asserts the §3 16ms-idle-or-4KB rule).

All cases run in ≤ 5s wall-clock each thanks to the injection seams; total stream-suite ≤ 60s. Reverse-verify discipline (`feedback_bug_fix_test_workflow`) is meaningful only because §9 makes the test deterministic.
