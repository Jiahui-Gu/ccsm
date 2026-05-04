---
title: PtyService.Attach handler — emitter contract, since_seq resume, requires_ack backpressure
date: 2026-05-04
status: research+spec (no code change)
audit_trail: Task #341 (Wave 3 §6.9 sub-task 10) — closes the largest gap from
  #228 RPC-stub audit (`research/228-rpc-stub-audit`); CreateSession (#339) /
  DestroySession (#338) unblocked once response shape (§7) lands.
spec_refs:
  - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md ch06 §1, §3, §5, §6
  - packages/proto/src/ccsm/v1/pty.proto (lines 10-90; AttachRequest, PtyFrame,
    AckPty, requires_ack)
  - packages/daemon/src/sessions/watch-sessions.ts (#34/#290 server-stream
    AsyncIterable adapter + HandlerContext.signal cleanup canonical pattern)
  - packages/daemon/src/pty-host/host.ts (T4.1 lifecycle skeleton)
  - packages/daemon/src/pty-host/types.ts (IPC kinds incl. reserved
    `delta` / `snapshot` / `send-input-rejected`)
---

# PtyService.Attach handler — design spec

## §0 Why this doc exists

The #228 audit flagged `PtyService.Attach` as the **largest unimplemented
behavior surface in v0.3 daemon**: pty-host children already drive the PTY
and produce snapshot+delta state machines (T4.x landed up to T4.10), but the
Connect server-stream adapter that turns the in-process producer into a
wire-shaped `stream PtyFrame` is missing. Three sibling RPC handlers
(`CreateSession` #339, `DestroySession` #338, `SendInput` / `Resize`) are
intentionally blocked on this spec because they all share response-shape
constraints that only become visible once Attach is pinned (e.g. a freshly
created session must be Attach-able with `since_seq=0` and yield exactly one
`PtySnapshot` frame; the `Session` proto returned by `CreateSession` must
carry the geometry that the first snapshot will report).

This doc is **research + spec only**. It does not introduce code. The
"Implementation tasks" section (§9) splits the work into PR-sized,
forward-safe units a manager can dispatch into a wave plan.

## §1 Scope and non-goals

In scope:
- The Connect server-streaming handler signature for `PtyService.Attach`.
- The producer/decider/sink layering (dev.md §2 SRP) the handler must use.
- The `since_seq` resume decision tree (snapshot / replay-deltas / refused).
- `requires_ack` per-subscriber backpressure (per-subscriber counter; bound
  channel; what triggers stream close vs. `RESOURCE_EXHAUSTED`).
- `HandlerContext.signal` cleanup contract.
- Companion `AckPty` semantics (per-subscriber watermark, prune influence).
- The downstream response-shape implications for `CreateSession` (#339)
  and `DestroySession` (#338).
- The minimum `daemon-boot-e2e` acceptance points.
- The implementation-task split (forward-safe / wave-locked).

Out of scope:
- The SnapshotV1 codec bytes (locked in design ch06 §2; we only consume).
- The delta wire format (locked in design ch06 §3; raw VT bytes; opaque).
- The 1-hour soak harness (ch06 §8; gated by ship-gate (c), separate task).
- Multi-principal admin attach (v0.4; spec ch06 §9 "Add" delta).
- Per-frame proto-level compression beyond the snapshot codec (v0.4
  optional `Attach.batch_window_ms` is mentioned but NOT introduced here).

## §2 Emitter contract (pty-host child → daemon main → subscribers)

### 2.1 Source of truth

The pty-host child process (`packages/daemon/src/pty-host/child.ts`,
spawned via `host.ts`) is the single producer of:

- `PtyDelta` records with monotonically-increasing per-session `seq`
  (starting at `1` after the most recent snapshot's `base_seq`; never
  reused; never gapped — see design ch06 §3).
- `PtySnapshot` records with a `base_seq` equal to the last delta seq at
  capture time.

The child emits these to the daemon main process over the
`child_process.fork` IPC channel (`serialization: 'advanced'`, so `Buffer`
and `Uint8Array` round-trip without base64 cost). The reserved IPC kinds
already declared in `packages/daemon/src/pty-host/types.ts` are
`'delta' | 'snapshot' | 'send-input-rejected'`; this spec fills in their
payload shapes.

### 2.2 IPC payload shapes (host → daemon main; lock now, T4.6+ implements)

```ts
// in packages/daemon/src/pty-host/types.ts — extends ChildToHostMessage
export interface DeltaMessage {
  readonly kind: 'delta';
  readonly seq: bigint;            // u64; matches PtyDelta.seq on the wire
  readonly tsUnixMs: bigint;       // i64; matches PtyDelta.ts_unix_ms
  readonly payload: Uint8Array;    // raw VT bytes (ch06 §3); opaque to daemon
}

export interface SnapshotMessage {
  readonly kind: 'snapshot';
  readonly baseSeq: bigint;        // u64; equals seq of last delta at capture
  readonly geometry: { readonly cols: number; readonly rows: number };
  readonly screenState: Uint8Array; // SnapshotV1 wire bytes (ch06 §2),
                                    // already zstd-wrapped by codec pkg
  readonly schemaVersion: number;   // 1 in v0.3
}

export interface SendInputRejectedMessage {
  readonly kind: 'send-input-rejected';
  readonly pendingWriteBytes: number;  // current pending; for crash_log
  readonly attemptedBytes: number;     // size of the rejected write
}
```

These three are additive to the existing `ChildToHostMessage` union; no
discriminant rename, no field renumber. Lock occurs in this spec; T4.6+
fills the payload at the same time it stops being a stub.

### 2.3 Daemon-main side: per-session in-memory ring + broadcast

The daemon main process holds one `PtySessionEmitter` per session (created
when the pty-host child's `ready` IPC fires; torn down when the child
exits per ch06 §1). The emitter owns:

- An in-memory ring of the last `N = 4096` deltas (the
  `DELTA_RETENTION_SEQS` figure from ch06 §4 / §5 — pinned here so the
  daemon-main number matches the SQLite prune number; mismatched values
  would silently break `since_seq` resume math).
- The most recent snapshot bytes + `base_seq` (overwritten when a newer
  one is taken; the SQLite row remains canonical for cold-restart, but
  the in-memory copy is what live Attach handlers read for `since_seq=0`
  to avoid a SQLite read on the hot path).
- A `Set<Subscriber>` (one entry per active Attach RPC); design ch06 §6
  permits N concurrent subscribers per session and we honor that.

The emitter is a **producer** in dev.md §2 SRP terms. It exposes:

```ts
export interface PtySessionEmitter {
  readonly sessionId: string;
  /** Current snapshot in memory (null only between session start and
   *  the first snapshot — Attach handler must wait for `awaitSnapshot()`
   *  in that window; see §3.3). */
  currentSnapshot(): PtySnapshotInMem | null;
  /** Synchronously read deltas in `(sinceSeq, currentMaxSeq]`. Returns
   *  `'out-of-window'` if `sinceSeq < oldestRetainedSeq`. */
  deltasSince(sinceSeq: bigint): readonly DeltaInMem[] | 'out-of-window';
  /** Subscribe to live deltas + snapshots. The listener fires
   *  synchronously from within the IPC `'message'` handler. The bus
   *  does NOT filter — subscriber owns per-subscriber `lastDeliveredSeq`
   *  and decides what to drop on overflow. Returns unsubscribe. */
  subscribe(listener: PtyEventListener): () => void;
  /** Resolves with the first snapshot if none is in memory yet; resolves
   *  immediately if one already is. Rejects if the session ends before
   *  the first snapshot (e.g. `claude` crashes during init). */
  awaitSnapshot(signal?: AbortSignal): Promise<PtySnapshotInMem>;
}
```

The emitter has NO knowledge of proto, Connect, or the wire — it speaks
in `Uint8Array` payloads + `bigint` seqs. The Attach handler (sink) is the
ONLY place that maps in-memory shapes to `PtyFrame` proto. This mirrors
the watch-sessions.ts split (event-bus.ts is the bus; watch-sessions.ts
is the proto mapper; manager.ts produces) and keeps the codec/wire
boundary single-sourced.

### 2.4 Snapshot boundary semantics (forever-stable)

When the pty-host child generates a snapshot (per ch06 §4 cadence rules:
`K_TIME=30s`, `M_DELTAS=256`, `B_BYTES=1 MiB`, or `Resize` with the 500ms
coalescing cap from ch06 §4):

1. The child captures `screenState` from xterm-headless and assigns
   `baseSeq = lastEmittedDeltaSeq` (the seq of the most recent delta
   ALREADY emitted to the daemon main; no in-flight deltas).
2. The child sends the `SnapshotMessage` IPC.
3. The daemon main process atomically:
   - writes the row through the SQLite write coalescer (per ch07 §5);
   - replaces the in-memory `currentSnapshot` reference;
   - **prunes the in-memory ring** of deltas with `seq < baseSeq -
     DELTA_RETENTION_SEQS + 1` so the in-memory window stays bounded;
   - publishes a `PtyEvent.snapshot` to subscribers (broadcast).

**Subscribers DO NOT receive snapshot events as ordinary stream frames
during the steady state**: an Attach handler that has already streamed a
snapshot at attach-time + been streaming deltas since does NOT switch to a
new snapshot mid-stream. The mid-stream snapshot event exists ONLY for
two consumers: (a) post-restart hydration in T4.14, and (b) future
admin/debug observers; the v0.3 Attach handler subscribes only to deltas
+ heartbeats and ignores the snapshot variant. This keeps the wire shape
trivial: every Attach RPC sends **at most one snapshot** (the initial one
if `since_seq=0` or out-of-window) followed by a strictly increasing
delta stream.

> **Why we pin "at most one snapshot per Attach"**: If the daemon could
> swap snapshots mid-stream the client would have to discard its accrued
> xterm-headless state and rehydrate from new bytes — equivalent to a
> reattach but without the `since_seq` advance. That breaks the
> client-side "lastAppliedSeq is monotone within an Attach" invariant
> and complicates cold-replay tests. Reattach is cheap (loopback);
> mid-stream rehydration is not worth the complexity.

## §3 since_seq resume decision tree

The pure decider (analogous to `decideWatchScope` in watch-sessions.ts):

```ts
type ResumeDecision =
  | { kind: 'snapshot_then_live'; snapshot: PtySnapshotInMem;
      resumeSeq: bigint /* = snapshot.baseSeq + 1n */ }
  | { kind: 'deltas_only'; deltas: readonly DeltaInMem[];
      resumeSeq: bigint /* = sinceSeq + 1n + BigInt(deltas.length) */ }
  | { kind: 'refused_too_far_behind'; reason: 'out-of-window';
      oldestRetainedSeq: bigint; sinceSeq: bigint };
```

### 3.1 Three branches (matches design ch06 §5)

1. **`since_seq == 0`** → `snapshot_then_live`. Send the in-memory
   `currentSnapshot`; live deltas resume at `baseSeq + 1`.
2. **`0 < since_seq <= currentMaxSeq` AND `since_seq >= oldestRetainedSeq`**
   → `deltas_only`. Replay the `(since_seq, currentMaxSeq]` slice from
   the in-memory ring; live deltas continue from `currentMaxSeq + 1`.
3. **`since_seq < oldestRetainedSeq`** (client too far behind retained
   window) → ch06 §5 falls back to "snapshot then live". This spec
   **diverges deliberately** from that wording into a third branch:
   `refused_too_far_behind`. Justification (next §3.2).

### 3.2 Why §3 refuses instead of silently sending a snapshot

ch06 §5 reads "fall back to snapshot" but pinning **silent** snapshot
fallback hides a real client bug: a renderer that consistently lags the
retention window means the renderer's xterm state is wrong (it's
applying deltas slower than the daemon emits them). Silently
re-snapshotting masks this until the user notices a corrupt screen.
Better: the daemon closes the stream with a structured Connect error
(`Code.OutOfRange`, `ErrorDetail.code = "pty.attach_too_far_behind"`,
detail carrying `since_seq` + `oldestRetainedSeq`). The client treats
that error by **immediately reattaching with `since_seq = 0`** — same
network cost as the silent fallback, but observable.

This is forever-additive: a v0.4 client that wants the silent fallback
can opt in via a new `AttachRequest.allow_snapshot_fallback` field
(v0.3 daemon ignores; v0.4 daemon checks). The v0.3 wire shape does
NOT need that field today because the renderer already implements
"on stream error, reattach from `lastAppliedSeq=0`" (T4.14 covers the
post-restart case which hits the same code path).

> **Reconciliation with ch06 §5**: ch06 §5 wording is preserved as the
> *semantic intent* (the user sees a working screen on reattach); §3.2
> here is a *protocol refinement* of how that intent is realized. The
> spec ch06 wording will be updated in a follow-up patch to point at
> this doc; the existing behavior contract (no data loss for any
> client that retries) is unchanged.

### 3.3 First-snapshot race (session just created)

A freshly created session may be Attach-able before its first snapshot
exists (CreateSession returns once the pty-host child sends `ready`,
but the first snapshot only arrives after at least one of: 30s elapsed
| 256 deltas | 1 MiB delta bytes | first Resize). For `since_seq=0`
during this window:

- Attach handler awaits `emitter.awaitSnapshot(handlerContext.signal)`.
- The pty-host child is REQUIRED to capture an **initial synthetic
  snapshot** on `'ready'` BEFORE it begins streaming any deltas. The
  initial snapshot has `baseSeq = 0n` (no deltas yet), reflects the
  initial geometry, and an empty xterm-headless screen. This eliminates
  the race for the common case (renderer attaches immediately after
  CreateSession returns) without requiring the renderer to handle a
  null-snapshot state.
- The synthetic snapshot is NOT persisted to SQLite differently from
  any other snapshot — the same `pty_snapshot` row (with `base_seq=0`)
  is written through the coalescer. Daemon restart hydration (T4.14)
  treats it identically to any other snapshot; xterm-headless
  decode-then-replay-zero-deltas is a no-op.

This pins the answer to a question that the audit raised but ch06 left
implicit ("what does Attach return for a session with no deltas yet?").
Locking the synthetic-snapshot-at-ready contract here is forever-stable;
clients never need to handle the null case.

### 3.4 Deciding the seq math precisely

```text
emitter.currentMaxSeq      = highest seq ever emitted to subscribers
emitter.oldestRetainedSeq  = lowest seq still in the in-memory ring
                              (== max(1, currentMaxSeq - N + 1) once N
                               deltas exist; 0 before any deltas)
snapshot.baseSeq           = seq of last delta at snapshot capture
                              (0 for the synthetic initial snapshot)

decide(req.sinceSeq):
  if req.sinceSeq == 0:
    return { kind: snapshot_then_live,
             snapshot: emitter.currentSnapshot ?? await awaitSnapshot,
             resumeSeq: snapshot.baseSeq + 1 }
  if req.sinceSeq > emitter.currentMaxSeq:
    # client claims to have applied a future seq — protocol bug.
    return { kind: refused_protocol_violation,
             reason: 'pty.attach_future_seq',
             sinceSeq: req.sinceSeq, currentMaxSeq: emitter.currentMaxSeq }
  if req.sinceSeq < emitter.oldestRetainedSeq:
    return { kind: refused_too_far_behind, ... }
  # Happy path: deltas-only resume.
  deltas = emitter.deltasSince(req.sinceSeq)  # excludes sinceSeq itself
  return { kind: deltas_only,
           deltas: deltas,
           resumeSeq: req.sinceSeq + 1 + BigInt(deltas.length) }
```

The `refused_protocol_violation` fourth branch (`since_seq` in the
future) is added here for completeness; it should never happen with a
correct client but a bug in `lastAppliedSeq` accounting (e.g. the
renderer increments before persisting) would otherwise silently
desync. Map to `Code.InvalidArgument`,
`ErrorDetail.code = "pty.attach_future_seq"`.

## §4 requires_ack backpressure

### 4.1 The two operating modes

`AttachRequest.requires_ack` (proto field 4; pty.proto lines 38-52):

- `false` (proto3 zero default; v0.3 Electron over loopback): the daemon
  streams freely. Connect's HTTP/2 flow control + the `since_seq` resume
  tree handle disconnect cases. No per-subscriber bookkeeping beyond
  identity.
- `true` (v0.4 web/iOS over CF Tunnel; v0.3 daemon MUST honor): the
  daemon tracks per-subscriber unacked-frame backlog; clients call
  `AckPty(session_id, applied_seq)` after persisting each frame; daemon
  closes the stream with `RESOURCE_EXHAUSTED` if backlog exceeds N=4096.

### 4.2 Per-subscriber state (requires_ack=true)

```ts
interface AckSubscriberState {
  readonly subscriberId: string;       // ULID; minted at Attach time
  lastDeliveredSeq: bigint;            // updated as each frame is yielded
  lastAckedSeq: bigint;                // updated on AckPty IPC
  // Bounded channel between producer (emitter listener) and consumer
  // (handler's for-await loop). Capacity 4096 — same as DELTA_RETENTION_SEQS.
  // Overflow triggers stream close (see §4.3).
  channel: BoundedChannel<DeltaInMem>;
}
```

- `lastAckedSeq` is the high-water-mark of contiguous `applied_seq` values
  the client has confirmed via `AckPty`. Out-of-order acks are rejected
  (since the client streams in order, an out-of-order ack means client
  bug; daemon returns `Code.InvalidArgument` from the AckPty RPC and does
  not advance the watermark).
- `unackedBacklog = lastDeliveredSeq - lastAckedSeq` — the load metric.

### 4.3 Triggers: stream close vs. RESOURCE_EXHAUSTED

The daemon checks backlog in TWO places, with TWO different outcomes:

| Where | Condition | Outcome |
|---|---|---|
| Producer (emitter listener about to enqueue a delta) | `channel.size >= 4096` | Close stream with `Code.ResourceExhausted`, `ErrorDetail.code = "pty.subscriber_channel_full"`. Subscriber channel is gone; client reconnects with `since_seq = lastAckedSeq`. |
| AckPty RPC (when the daemon receives an ack) | After advancing watermark, if `unackedBacklog > 4096` | This shouldn't be reachable since the producer check fires first, BUT defensive: same `RESOURCE_EXHAUSTED`. |
| Periodic watchdog (every 10s, same cadence as heartbeat) | `unackedBacklog > 4096` AND no ack received in last 30s | Close stream with `Code.DeadlineExceeded`, `ErrorDetail.code = "pty.ack_stalled"`. Distinguishes a stuck client (slow CPU; no ack progress) from a fast client that briefly fell behind (channel-full path). Both map to client reconnect. |

Note on the difference: `pty.subscriber_channel_full` ⇒ the daemon
COULDN'T enqueue (producer side); `pty.ack_stalled` ⇒ the client isn't
ACKing back (consumer side). Different `ErrorDetail.code` lets the
renderer instrument them differently (a stalled-ack pattern is a hint
that the renderer's persistence layer is the bottleneck).

### 4.4 requires_ack=false fast path

When `requires_ack=false`:
- No per-subscriber `BoundedChannel`. The handler's for-await loop pulls
  directly from a `subscribe(listener)` callback into a 1024-deep
  fallback buffer (same shape as watch-sessions.ts; ResourceExhausted on
  overflow at 1024 — bus is for sane consumers, not for absorbing
  unbounded delay).
- No AckPty interaction. AckPty RPC for a `requires_ack=false`
  subscription is silently a no-op (returns OK with the current
  `daemon_max_seq`); this keeps clients that erroneously send AckPty
  from breaking.
- HTTP/2 flow control is the only backpressure. On loopback this is
  effectively unbounded; on CF Tunnel a misbehaving v0.3 client over
  the public network would degrade gracefully (the daemon's send buffer
  fills, Connect applies backpressure to the emitter listener, eventually
  the 1024-deep fallback buffer overflows and the stream closes).

### 4.5 Why N=4096 in BOTH places

The same `N=4096` figure governs:
- `DELTA_RETENTION_SEQS` (in-memory ring + SQLite prune; ch06 §4).
- `requires_ack` per-subscriber channel capacity (this spec, §4.2).

Pinning them equal means: a subscriber that hits the channel-full path
can ALWAYS reconnect with `since_seq = lastAckedSeq` and resume via
deltas-only (because everything between `lastAckedSeq + 1` and
`currentMaxSeq` is still in the ring — by definition, if the ring kept
4096 deltas and the channel held at most 4096, the channel can't have
been further behind than the ring). The `refused_too_far_behind`
branch (§3.1.3) is therefore reachable ONLY for clients that disconnect
for an extended period and reconnect, never as a side effect of normal
backpressure. This is a FOREVER-STABLE invariant — changing either N
without the other would make the steady-state "kick + reconnect"
recovery unreliable.

## §5 HandlerContext.signal cleanup

Connect-ES v2 passes `HandlerContext.signal` (an `AbortSignal`) to every
handler. It fires when:
- the client disconnects mid-stream (TCP RST / clean FIN);
- the server is shutting down (the lifecycle module aborts all pending
  handlers per `packages/daemon/src/lifecycle.ts`);
- the listener is rotated (Listener-A re-bind during boot — should not
  happen mid-stream in v0.3 but the contract is the same).

The Attach handler MUST:

1. Forward `handlerContext.signal` into `emitter.subscribe`'s teardown
   callback so the `Set<Subscriber>` entry is removed synchronously when
   the signal fires. (Without this, the daemon would leak subscribers
   for every disconnected stream — the emitter's per-listener cost is
   small but accumulates over a long-running daemon.)
2. Forward into `awaitSnapshot(signal)` so a renderer that disconnects
   during the first-snapshot wait does not pin the handler.
3. Detach the AckPty interest (clear the subscriberId from the
   per-session ack map) so a late AckPty RPC for a closed stream
   returns OK without trying to advance a deleted watermark.
4. NOT cancel any pending IPC writes to the pty-host child — `SendInput`
   / `Resize` are separate RPCs with their own handler lifetimes.
   Closing one Attach stream MUST NOT affect the underlying session.

The cleanup pattern matches watch-sessions.ts's `onAbort` /
`detachAbort` / `signal.removeEventListener('abort', onAbort)` shape;
spec implementation should reuse the structure verbatim (no new
abstraction — the surface is small enough that two copies are clearer
than a shared helper).

## §6 AckPty companion RPC semantics

`AckPty(session_id, applied_seq) → { daemon_max_seq }` (pty.proto §54-62).

### 6.1 When `requires_ack=true` for the calling subscriber

- Resolve the calling subscriber by `(principalKey, session_id, peer
  connection identity)`. The peer-connection identity comes from
  Connect's `HandlerContext` (specifically the underlying http2 stream's
  parent session on Node — this is the same identity used to scope the
  Attach stream). A subscriber's `subscriberId` is minted by the Attach
  handler when the stream starts; the AckPty handler looks it up by
  `(principalKey, session_id)` returning the FIRST matching subscriber
  whose channel has been awaiting an ack. Multiple Attach streams from
  the same client to the same session are rare (only during reattach
  overlap) and the wrong-stream ack is harmless — it just advances the
  wrong watermark and the right subscriber will hit a stalled-ack
  watchdog within 30s.
- Validate `applied_seq <= subscriber.lastDeliveredSeq` (you can't ack
  a frame the daemon hasn't sent you). Out-of-bound ack returns
  `Code.InvalidArgument`, `ErrorDetail.code = "pty.ack_overrun"`.
- Validate `applied_seq >= subscriber.lastAckedSeq` (acks are monotonic;
  a regressing ack means client bug). Same `Code.InvalidArgument`,
  `ErrorDetail.code = "pty.ack_regress"`.
- On valid ack: `subscriber.lastAckedSeq = applied_seq`. Return
  `daemon_max_seq = emitter.currentMaxSeq`. The client uses this to
  decide if it has caught up (`applied_seq == daemon_max_seq` ⇒ idle).

### 6.2 When `requires_ack=false` for the calling subscriber (or no subscriber)

No-op: the daemon returns OK with `daemon_max_seq = emitter.currentMaxSeq`
and does NOT touch any state. This handles three cases uniformly:
- subscriber's Attach was opened with `requires_ack=false`;
- subscriber's Attach has ended (disconnect race);
- the AckPty RPC arrives before any Attach RPC (badly-ordered client).

The no-op posture is forever-stable — a v0.4 client doing speculative
acks before reattach gets benign daemon-side behavior.

### 6.3 Prune influence — daemon does NOT trim ring on ack

The in-memory ring + SQLite `pty_delta` are pruned ONLY by the
snapshot-cadence rule (ch06 §4: `seq < base_seq - DELTA_RETENTION_SEQS`).
Per-subscriber acks DO NOT advance the prune watermark, because:
- multiple subscribers share the ring; pruning by one would lose data
  for another;
- the snapshot-cadence prune already gives the daemon a bounded
  retention window without coordinating across subscribers.

This is the right call (forever-stable): per-subscriber pruning would
require a min-watermark across all subscribers, which would let one
slow subscriber pin daemon RAM/disk indefinitely — the OPPOSITE of what
backpressure is supposed to achieve.

## §7 CreateSession (#339) / DestroySession (#338) response shape implications

This is what the audit means by "Attach unblocks 339/338": the response
shapes for those two RPCs cannot be finalized until the post-RPC Attach
contract is pinned. With §3.3 above (synthetic initial snapshot at
`base_seq=0`), we can now pin them:

### 7.1 CreateSession response (`session.proto` `CreateSessionResponse`)

The proto already declares:
```proto
message CreateSessionResponse {
  RequestMeta meta = 1;
  Session session = 2;
}
```

Pin: `CreateSession` MUST NOT return until BOTH:
1. The `sessions` row is committed (state = `RUNNING`, `should_be_running=1`).
2. The pty-host child has emitted `'ready'` AND its synthetic initial
   snapshot has been written to SQLite (the pre-condition for any client
   to safely call `Attach` with `since_seq=0` immediately afterward).

The returned `Session` carries the geometry from `CreateSessionRequest.
initial_geometry` (which equals the synthetic snapshot's geometry — the
two are constructed from the same source). `runtime_pid` is the
pty-host child's PID; a client that observes `runtime_pid` set in the
response is guaranteed Attach-able. This eliminates a "session created
but not yet snapshot-able" intermediate state from the wire surface.

### 7.2 DestroySession response (`session.proto` `DestroySessionResponse`)

```proto
message DestroySessionResponse { RequestMeta meta = 1; }
```

Pin: `DestroySession` MUST NOT return until ALL of:
1. The session row's `should_be_running` is set to `0`.
2. The pty-host child has been sent `{kind:'close'}` and has exited
   (graceful or forced via `closeAndWait` 5s timeout per host.ts).
3. All active Attach subscribers for this session have received a
   terminal `Code.Canceled` with `ErrorDetail.code =
   "pty.session_destroyed"` and their handlers have returned.

The third bullet is the Attach-shape implication: without it, a renderer
that calls `DestroySession` then immediately disposes its UI would race
the Attach stream's natural teardown and either (a) leak the
HandlerContext or (b) emit a "stream errored" toast for what was a
deliberate destroy. Pinning the handler return ordering eliminates the
race at the wire boundary; the renderer just observes "RPC returned →
all my Attach streams have ended cleanly".

### 7.3 SessionEvent on the watch-sessions bus

`destroyed` event publishes AFTER step 3 of §7.2; this guarantees that
a `WatchSessions` subscriber observing `destroyed` can be sure no
further Attach frames will arrive for that session.

## §8 daemon-boot-e2e acceptance points

`packages/daemon/test/integration/daemon-boot-end-to-end.spec.ts`
(existing scaffold) is the canonical end-to-end harness — it already
spins up the daemon, opens a Connect channel over loopback, and runs
through Hello + listener descriptor validation. The Attach handler
ships with these added assertion points (in this same spec or a
sibling `daemon-boot-pty-attach.spec.ts` — implementation chooses; both
are forward-safe):

1. **Create-then-Attach happy path**: `CreateSession(cwd=tmp,
   claude_args=["--simulate-workload","short"], geometry=80x24)` →
   assert response contains a `Session` with non-zero `runtime_pid` and
   `state=RUNNING`. Immediately `Attach(session_id, since_seq=0)` →
   first frame is `PtyFrame.snapshot` with `base_seq=0` (synthetic
   initial) AND `geometry={cols:80,rows:24}` AND `schema_version=1`.

2. **since_seq=0 mid-session**: After at least one delta has streamed
   (drive a few bytes via `SendInput`), close the Attach and reopen
   with `since_seq=0` → first frame is a NON-synthetic `PtyFrame.snapshot`
   (the cadence-driven one if one has fired, OR the synthetic one if
   not yet — both are valid per §3.3); subsequent frames are deltas
   with monotonic `seq` strictly greater than `snapshot.base_seq`.

3. **since_seq mid-window**: Record `lastAppliedSeq = N`; reattach
   with `since_seq=N` → no snapshot frame; first frame is a delta with
   `seq=N+1`.

4. **since_seq out-of-window** (force the ring to roll over by emitting
   >4096 deltas with `--simulate-workload=burst`): reattach with
   `since_seq = N` where N is older than `oldestRetainedSeq` → stream
   closes with `Code.OutOfRange` + `ErrorDetail.code =
   "pty.attach_too_far_behind"`. Client retries with `since_seq=0` and
   succeeds (snapshot path).

5. **Disconnect cleanup**: open Attach, immediately abort the
   client-side AbortController → the daemon's `emitter.subscribe` Set
   loses the subscriber within 100ms (assert via a daemon-internal
   test seam: `emitter.subscriberCount() === 0`).

6. **DestroySession terminal frame**: open Attach, then call
   `DestroySession(session_id)`. The `DestroySession` response MUST
   arrive only AFTER the Attach stream has emitted its terminal
   `Code.Canceled` with `ErrorDetail.code = "pty.session_destroyed"`.
   Verify via timestamps: `attach_stream_ended_at <
   destroy_response_received_at`.

7. **requires_ack=true backpressure** (deferred to a separate spec
   file in the v0.4 readiness suite — out of v0.3 boot-e2e scope; the
   wire shape is locked here so v0.4 lights the test up without proto
   change). Listed for completeness so reviewers can see the v0.4
   acceptance gate exists.

The first 6 are MUST-PASS for v0.3 ship-gate (b) (renderer hard-kill
reconnect equivalence). #7 is MUST-PASS for v0.4 ship-gate (web/iOS).

## §9 Implementation tasks (split for wave plan)

Per dev.md "task size discipline" + manager memory
`feedback_spec_task_size_discipline.md` (one PR = one concern), the work
splits into the following PR-sized tasks. Forward-safe vs. wave-locked
classification per `feedback_wave_ordering_discipline.md` (forward-safe:
audit / new package / rules file / new test surface; wave-locked:
modifies an existing source file that other tasks may also touch).

### 9.1 Forward-safe (parallelizable)

- **T-PA-1 (forward-safe)** — Add `DeltaMessage` / `SnapshotMessage` /
  `SendInputRejectedMessage` payload shapes to `packages/daemon/src/
  pty-host/types.ts`. Pure type addition; widens the `ChildToHostMessage`
  union (the existing `'delta' | 'snapshot' | 'send-input-rejected'`
  reserved kinds get full payloads). NO behavior change. NO test impact
  beyond the type-check guard.

- **T-PA-2 (forward-safe)** — Add `ResumeDecision` decider as a pure
  function in a new file `packages/daemon/src/pty-host/attach-decider.ts`,
  with full unit-test coverage for §3 branches (decider takes
  `(sinceSeq, currentMaxSeq, oldestRetainedSeq, currentSnapshot,
  deltasSince)` and returns the verdict; no I/O). Mirrors
  `decideWatchScope` shape. The handler in T-PA-5 below imports it.

- **T-PA-3 (forward-safe)** — New file `packages/daemon/src/pty-host/
  ack-state.ts`: per-subscriber ack-state struct + the bounded channel
  primitive (extract or wrap an off-the-shelf primitive — Layer 1
  check: `node:stream`'s `Readable.from` has bounded backpressure but
  no peek/size accessor; a 30-line bespoke ring-buffer with `enqueue`
  / `dequeue` / `size` is simpler than wrapping a Stream). Forward-safe
  because it's a NEW file; T-PA-5 imports it.

- **T-PA-4 (forward-safe)** — New unit tests under
  `packages/daemon/src/pty-host/__tests__/`: `attach-decider.spec.ts`
  (T-PA-2 coverage), `ack-state.spec.ts` (T-PA-3 coverage), and
  `pty-emitter.spec.ts` (the in-memory ring + subscribe/broadcast
  invariants from §2.3-§2.4 — uses fake IPC messages, no real child
  process).

### 9.2 Wave-locked (must serialize against other PRs touching the same files)

- **T-PA-5 (wave-locked: modifies pty-host/host.ts surface)** — Construct
  the `PtySessionEmitter` in the daemon main process when the pty-host
  child sends `'ready'`; tear down on child exit. Wire IPC `'delta'` /
  `'snapshot'` messages into the emitter's ring + broadcast. Adds an
  exported `getEmitter(sessionId)` lookup that the Attach handler
  consumes. Wave-locked because T4.x tasks landing in parallel may
  also touch `host.ts` / a new neighbor file in `pty-host/`.

- **T-PA-6 (wave-locked: modifies rpc/router.ts)** — Implement the
  Attach handler in a new file `packages/daemon/src/rpc/pty-attach.ts`,
  composing the decider (T-PA-2), emitter (T-PA-5), and ack-state
  (T-PA-3). Register with `registerStubServices`'s replacement pattern
  (see `makeWatchSessionsHandler` precedent). The handler's signature
  is the Connect-ES v2 server-streaming async-generator shape;
  HandlerContext.signal cleanup per §5. Wave-locked because every
  `PtyService` method handler will land via the same file.

- **T-PA-7 (wave-locked: modifies sessions/SessionManager.ts response
  shape)** — Update `CreateSession` to wait for the synthetic-snapshot
  emission before returning (§7.1); update `DestroySession` to wait for
  Attach subscriber teardown before returning (§7.2). Both are
  semantic tightenings that v0.3 RPC implementations (#338/#339) need.

- **T-PA-8 (wave-locked: modifies pty-host/child.ts)** — Implement the
  child-side: emit a synthetic snapshot on `'ready'` (§3.3); accumulate
  raw VT bytes per ch06 §3 cadence and send `DeltaMessage`s; trigger
  cadence-driven snapshots per ch06 §4 and send `SnapshotMessage`s.
  Wave-locked because `child.ts` is a hot file across T4.x.

### 9.3 Dependency graph for the wave planner

```
T-PA-1 ──┬──> T-PA-5 ──┬──> T-PA-6
         │              │
T-PA-2 ──┘              │
T-PA-3 ─────────────────┘
T-PA-4 ─ (parallel; not blocking)
T-PA-1 ──> T-PA-8 ─────> T-PA-5
T-PA-6 ─ (does not block T-PA-7; T-PA-7 only depends on §7's contract)
```

Recommended wave packing for one manager dispatch:
- **Wave A (parallel, forward-safe)**: T-PA-1, T-PA-2, T-PA-3, T-PA-4.
- **Wave B (after A)**: T-PA-8 (depends on T-PA-1).
- **Wave C (after A+B)**: T-PA-5 (depends on T-PA-1, T-PA-8 for IPC).
- **Wave D (after C)**: T-PA-6, T-PA-7 (parallel with each other; both
  depend on the response-shape contract being live).

T-PA-7 may run before T-PA-6 if reviewer prefers landing the
session-manager tightening first (it's a smaller diff), but the order
is symmetric — neither blocks the other on file overlap.

## §10 Forever-stable summary (for cross-spec linking)

The forever-stable invariants this spec adds to v0.3 (additive to ch06):

1. Synthetic initial snapshot at `base_seq=0` on pty-host `'ready'`
   (§3.3).
2. At-most-one snapshot per Attach stream (§2.4); mid-stream snapshot
   IPC is for hydration consumers only.
3. `since_seq` too-far-behind ⇒ `Code.OutOfRange` +
   `pty.attach_too_far_behind` (§3.2; refines ch06 §5's wording).
4. `since_seq` future ⇒ `Code.InvalidArgument` + `pty.attach_future_seq`
   (§3.4).
5. requires_ack channel capacity == DELTA_RETENTION_SEQS == 4096
   (§4.5).
6. Per-subscriber acks DO NOT influence ring/SQLite prune (§6.3).
7. CreateSession waits for synthetic snapshot (§7.1); DestroySession
   waits for Attach teardown (§7.2).

All seven are additive: a v0.4 client over CF Tunnel uses the SAME wire
shape; a v0.4 admin watcher uses the SAME emitter; a v0.4 mobile client
opting into delta batching uses the SAME decider with one new field.
Zero rework.
