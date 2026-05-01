// T79 — drop-slowest L8 probe (frag-3.5.1 §3.5.1.5 lines 118-122, 134-135).
//
// Asserts the v0.3 PTY data-plane backpressure contract end-to-end across the
// real primitives the daemon shell will compose at wiring time:
//
//   1. **Slow consumer dropped at the 1 MiB per-subscriber watermark**.
//      Two `pty.subscribe` consumers attach to the real fan-out registry via
//      the real `handlePtySubscribe` handler (#1057). A producer broadcasts
//      frames and accounts pending bytes through the real `createDropSlowest`
//      decider; only the slow consumer (which never `flush`es) accumulates
//      past 1 MiB and is unsubscribed + close()d. The fast consumer (which
//      flushes after every delivery) continues to receive every subsequent
//      frame.
//
//   2. **Replay-burst exemption** (spec line 120). During the resubscribe
//      replay window, the slow consumer is fed >1 MiB through the
//      `createReplayBurstExemption` recorder (which forwards to drop-slowest
//      with `exempt: true`). The slow consumer MUST NOT be dropped while in
//      replay-mode, no matter how large the burst. Once `exitReplay()` runs
//      and subsequent steady-state writes resume, the watermark accounting
//      starts fresh and the slow consumer is dropped on the first
//      post-replay overlimit broadcast.
//
//   3. **End-frame reason for dropped consumer**. `DrainReason` does NOT
//      carry a dedicated `drop-slowest` kind (the registry close vocabulary
//      is `pty-exit | pty-crashed | daemon-shutdown | session-removed`), so
//      the canonical drop-slowest signal is `{ kind: 'session-removed',
//      detail: 'drop-slowest' }` — the `detail` slot is exactly what the
//      `DrainReason` JSDoc reserves for "free-form detail for log lines"
//      (frag-3.5.1 §3.5.1.5 wires this to the `subscriber-dropped-slow` log
//      line on the producer side). This probe pins that convention so a
//      future wiring task can't silently change the reason and break
//      downstream renderer reconnect telemetry. The handler maps it to the
//      `session-removed` end-reason via `drainReasonToEndReason`.
//
// Composition under test (real modules, no mocks of registry / handler /
// drop-slowest / replay-burst — only the PTY producer is a tiny in-test
// loop, per the T81 ACL probe convention of using real primitives):
//
//   producer (in-test) ─► registry.broadcast()
//                         │
//                         └─► subscriber.deliver()  ──► stream.push()
//                         ▲                                │
//                         │                                ▼
//                         │            handlePtySubscribe (real, #1057)
//                         │
//   producer accounts each broadcast through createDropSlowest (real); on
//   overlimit it calls unsubscribe(subId, sub) and sub.close({...drop-slowest})
//   which the handler maps to `stream.end({ kind: 'session-removed', detail })`.
//
// Why a probe (not a unit test):
//   - The drop-slowest decider, the replay-burst exemption, the fan-out
//     registry, and the pty.subscribe handler are each unit-tested in
//     isolation. The watermark contract only emerges from their composition,
//     which the daemon shell will perform at wiring time. This probe pins
//     the composition shape now so the wiring task (T44/T47 follow-up) can
//     code against a working reference.
//
// Mirrors T80 (snapshot-interleave.probe.test.ts) conventions: small
// self-contained file, no harness changes, vitest `daemon/**/__tests__`
// glob, no fake timers — uses real microtask flushes.

import { describe, expect, it } from 'vitest';

import {
  PTY_SUBSCRIBE_METHOD,
  handlePtySubscribe,
  registerPtySubscribeHandler,
  type PtySubscribeContext,
  type PtySubscribeEndReason,
  type PtySubscribeFrame,
  type PtySubscribeStream,
} from '../pty-subscribe.js';
import {
  createFanoutRegistry,
  type DrainReason,
  type FanoutRegistry,
  type Subscriber,
} from '../../pty/fanout-registry.js';
import {
  DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES,
  createDropSlowest,
  type DropSlowest,
} from '../../pty/drop-slowest.js';
import { createReplayBurstExemption } from '../../pty/replay-burst-exemption.js';
import { createDataDispatcher } from '../../dispatcher.js';

// ---------------------------------------------------------------------------
// Probe constants
// ---------------------------------------------------------------------------

/** Canonical drop-slowest detail string. The registry's DrainReason union
 *  has no dedicated `drop-slowest` kind, so the convention is
 *  `session-removed` + this detail string, which the handler maps to a
 *  `session-removed` end-reason envelope (drainReasonToEndReason). The
 *  `subscriber-dropped-slow` log line (spec line 118) is emitted by the
 *  producer side at the same call site. */
const DROP_SLOWEST_DETAIL = 'drop-slowest' as const;

/** Per-broadcast frame size — chosen so an integer number of frames hits
 *  the 1 MiB watermark cleanly. 64 KiB × 17 = 1_114_112 bytes (just past
 *  1_048_576). 16 frames = 1 MiB exactly, NOT yet overlimit (strict
 *  greater-than per drop-slowest.ts:36). The 17th broadcast trips the
 *  watermark. */
const FRAME_BYTES = 64 * 1024;

const SESSION_ID = 'pty-T79' as const;
const SLOW_SUB_ID = 'sub-slow' as const;
const FAST_SUB_ID = 'sub-fast' as const;

// ---------------------------------------------------------------------------
// Test-side stream + producer harness
// ---------------------------------------------------------------------------

interface CapturedStream extends PtySubscribeStream {
  readonly id: string;
  readonly pushed: PtySubscribeFrame[];
  readonly ended: PtySubscribeEndReason[];
}

function makeStream(id: string): CapturedStream {
  const pushed: PtySubscribeFrame[] = [];
  const ended: PtySubscribeEndReason[] = [];
  return {
    id,
    pushed,
    ended,
    push(frame) {
      pushed.push(frame);
    },
    end(reason) {
      ended.push(reason);
    },
  };
}

function makeCtx(
  registry: FanoutRegistry<PtySubscribeFrame>,
): PtySubscribeContext {
  return {
    registry,
    isValidPtyId: (id) => id === SESSION_ID,
  };
}

/**
 * The producer side that the daemon wiring task (T44/T47) will eventually
 * own. Composes registry + drop-slowest + (optionally) replay-burst
 * exemption: every broadcast is mirrored to the per-subscriber tally; if
 * any subscriber is overlimit, it is unsubscribed AND closed with the
 * canonical drop-slowest DrainReason.
 *
 * The producer tracks subscriber identity via a side map (subId → Subscriber)
 * because the registry itself is identity-only and does not surface ids.
 * Production wiring will key the same map off the streamId / subscribeId
 * issued by the transport.
 */
interface Producer {
  /** Register a subscriber under the given subId (so the producer can map
   *  drop-slowest tally hits back to a Subscriber to close). */
  track(subId: string, subscriber: Subscriber<PtySubscribeFrame>): void;
  /** Forget a subscriber (e.g. after caller-cancel). */
  untrack(subId: string): void;
  /**
   * Broadcast one frame. For each currently-registered subscriber on
   * `SESSION_ID`, accounts `byteCount` against drop-slowest. Subscribers
   * whose tally crosses the watermark are unsubscribed + close()d with the
   * canonical DrainReason and removed from the producer's tracker.
   *
   * Returns the list of subIds dropped on this broadcast (for assertion).
   */
  broadcast(frame: PtySubscribeFrame, byteCount: number): string[];
  /** Mark a subscriber as having flushed `byteCount` bytes from its
   *  Connect-side buffer. */
  flush(subId: string, byteCount: number): void;
  /** Direct accessor for assertions / reverse-verify. */
  readonly dropSlowest: DropSlowest;
}

function makeProducer(
  registry: FanoutRegistry<PtySubscribeFrame>,
  dropSlowest: DropSlowest,
): Producer {
  const subById = new Map<string, Subscriber<PtySubscribeFrame>>();

  function track(subId: string, subscriber: Subscriber<PtySubscribeFrame>): void {
    subById.set(subId, subscriber);
  }

  function untrack(subId: string): void {
    subById.delete(subId);
    dropSlowest.forget(subId);
  }

  function broadcast(frame: PtySubscribeFrame, byteCount: number): string[] {
    // Producer side: deliver first, then account. (Production order is
    // identical: socket.write returns synchronously and Connect's per-stream
    // buffer takes the bytes immediately; the tally is incremented by the
    // same call site.)
    registry.broadcast(SESSION_ID, frame);
    for (const subId of subById.keys()) {
      dropSlowest.record(subId, byteCount);
    }
    const overlimit = dropSlowest.getOverlimit();
    const dropped: string[] = [];
    for (const subId of overlimit) {
      const sub = subById.get(subId);
      if (!sub) continue;
      // Order matters: unsubscribe BEFORE close so a re-entrant broadcast
      // from the close callback cannot deliver into a closed stream. This
      // mirrors the order documented in pty-subscribe.ts:274-279 (caller-
      // cancel path).
      registry.unsubscribe(SESSION_ID, sub);
      const reason: DrainReason = {
        kind: 'session-removed',
        detail: DROP_SLOWEST_DETAIL,
      };
      sub.close(reason);
      subById.delete(subId);
      dropSlowest.forget(subId);
      dropped.push(subId);
    }
    return dropped;
  }

  function flush(subId: string, byteCount: number): void {
    dropSlowest.flush(subId, byteCount);
  }

  return { track, untrack, broadcast, flush, dropSlowest };
}

/** Build a single-byte Uint8Array of the requested length. The probe
 *  cares about the byte count, not the contents; 0xff fills are easy to
 *  eyeball in failure traces. */
function payload(len: number): Uint8Array {
  return new Uint8Array(len).fill(0xff);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T79 drop-slowest L8 probe (frag-3.5.1 §3.5.1.5)', () => {
  it('slow consumer dropped at the 1 MiB watermark; fast consumer continues; end-frame reason is canonical', () => {
    const registry = createFanoutRegistry<PtySubscribeFrame>();
    const dropSlowest = createDropSlowest(); // default 1 MiB threshold
    const producer = makeProducer(registry, dropSlowest);
    const ctx = makeCtx(registry);

    // Two consumers. The handler returns the cancel hook; we do NOT cancel
    // (the producer side is the one that drops them).
    const slowStream = makeStream(SLOW_SUB_ID);
    const fastStream = makeStream(FAST_SUB_ID);
    handlePtySubscribe({ ptyId: SESSION_ID }, slowStream, ctx);
    handlePtySubscribe({ ptyId: SESSION_ID }, fastStream, ctx);

    // Map handler-registered subscribers back to ids by looking up in the
    // registry's snapshot — the handler subscribes in the order we called
    // it, so the first subscriber is the slow one.
    const subs = registry.getSubscribers(SESSION_ID);
    expect(subs).toHaveLength(2);
    producer.track(SLOW_SUB_ID, subs[0]!);
    producer.track(FAST_SUB_ID, subs[1]!);

    // Pump frames. After 16 frames, both tallies sit at exactly 1 MiB —
    // NOT yet overlimit (strict >). The 17th frame trips the slow
    // subscriber: slow tally goes to 1_114_112; fast tally drops to
    // 64 KiB on the same broadcast because the producer flushes the fast
    // consumer immediately after every delivery (its OS socket drained
    // the bytes synchronously).
    let droppedSubs: string[] = [];
    const FRAMES_TO_TRIP = 17;
    for (let i = 0; i < FRAMES_TO_TRIP; i += 1) {
      const seq = i + 1;
      const dropped = producer.broadcast(
        { kind: 'delta', seq, data: payload(FRAME_BYTES) },
        FRAME_BYTES,
      );
      // Fast consumer flushes as soon as the bytes are delivered (its OS
      // socket has unlimited capacity in this test). This is the
      // production-equivalent of Connect's `drain` event firing on the
      // fast consumer's per-stream buffer.
      producer.flush(FAST_SUB_ID, FRAME_BYTES);
      if (dropped.length > 0) droppedSubs = droppedSubs.concat(dropped);
    }

    // Assertion 1: slow consumer dropped exactly once, on the 17th frame.
    expect(droppedSubs).toEqual([SLOW_SUB_ID]);

    // Assertion 2: slow stream end()ed with canonical reason.
    expect(slowStream.ended).toHaveLength(1);
    expect(slowStream.ended[0]).toEqual({
      kind: 'session-removed',
      detail: DROP_SLOWEST_DETAIL,
    });

    // Assertion 3: fast stream NEVER end()ed.
    expect(fastStream.ended).toHaveLength(0);

    // Assertion 4: slow stream received exactly the 17 pre-drop frames
    // (it gets the trip-frame because deliver() runs BEFORE the tally
    // accounting + close — same call-site ordering production will use).
    expect(slowStream.pushed).toHaveLength(FRAMES_TO_TRIP);
    for (let i = 0; i < FRAMES_TO_TRIP; i += 1) {
      const f = slowStream.pushed[i]!;
      expect(f.kind).toBe('delta');
      if (f.kind === 'delta') expect(f.seq).toBe(i + 1);
    }

    // Assertion 5: fast consumer continues to receive subsequent frames
    // after the slow drop.
    const POST_DROP_FRAMES = 5;
    for (let i = 0; i < POST_DROP_FRAMES; i += 1) {
      const seq = FRAMES_TO_TRIP + 1 + i;
      const dropped = producer.broadcast(
        { kind: 'delta', seq, data: payload(FRAME_BYTES) },
        FRAME_BYTES,
      );
      producer.flush(FAST_SUB_ID, FRAME_BYTES);
      // No more drops — slow consumer is gone, fast consumer is healthy.
      expect(dropped).toEqual([]);
    }
    expect(fastStream.pushed).toHaveLength(FRAMES_TO_TRIP + POST_DROP_FRAMES);
    expect(fastStream.ended).toHaveLength(0);

    // Registry state: slow gone, fast still attached. The slow subscriber
    // was unsubscribed by the producer; the fast one remains.
    const remaining = registry.getSubscribers(SESSION_ID);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(subs[1]);
  });

  it('replay-burst exemption: slow consumer NOT dropped past 1 MiB during replay; dropped on first post-replay overlimit', () => {
    const registry = createFanoutRegistry<PtySubscribeFrame>();
    const dropSlowest = createDropSlowest();
    const replayBurst = createReplayBurstExemption({ dropSlowest });
    const producer = makeProducer(registry, dropSlowest);
    const ctx = makeCtx(registry);

    const slowStream = makeStream(SLOW_SUB_ID);
    handlePtySubscribe({ ptyId: SESSION_ID }, slowStream, ctx);
    const subs = registry.getSubscribers(SESSION_ID);
    expect(subs).toHaveLength(1);
    producer.track(SLOW_SUB_ID, subs[0]!);

    // ── Replay window ────────────────────────────────────────────────
    // Enter replay-mode and pump >1 MiB through the exempt recorder.
    // The exempt recorder does NOT touch the drop-slowest tally, so the
    // slow consumer cannot trip the watermark no matter how big the
    // burst. (Production: T44 calls exemptRecord for the bounded 256 KB
    // snapshot payload; we deliberately overshoot to 2 MiB to prove the
    // exemption is unconditional within the window.)
    const exemptRecord = replayBurst.enterReplay(SLOW_SUB_ID);
    const REPLAY_BYTES_TOTAL = 2 * 1024 * 1024; // 2 MiB — well past watermark
    const REPLAY_FRAMES = REPLAY_BYTES_TOTAL / FRAME_BYTES;
    for (let i = 0; i < REPLAY_FRAMES; i += 1) {
      // Producer delivers the replay frame to the registry directly (the
      // bytes still flow to subscribers; only the accounting is exempt).
      registry.broadcast(SESSION_ID, {
        kind: 'delta',
        seq: i + 1,
        data: payload(FRAME_BYTES),
      });
      // Exempt accounting — does NOT add to the tally.
      exemptRecord(FRAME_BYTES);
    }

    // Assertion: tally is still 0 (exempt writes never accumulate) and
    // the slow consumer is still attached + has received every replay
    // frame.
    expect(dropSlowest.pending(SLOW_SUB_ID)).toBe(0);
    expect(replayBurst.isInReplay(SLOW_SUB_ID)).toBe(true);
    expect(slowStream.ended).toHaveLength(0);
    expect(slowStream.pushed).toHaveLength(REPLAY_FRAMES);
    expect(registry.getSubscribers(SESSION_ID)).toHaveLength(1);

    // ── Exit replay → steady-state watermark resumes ────────────────
    replayBurst.exitReplay(SLOW_SUB_ID);
    expect(replayBurst.isInReplay(SLOW_SUB_ID)).toBe(false);
    // exitReplay also resets the tally to 0; verify the post-burst
    // accounting starts fresh (spec line 120: "watermark is measured
    // AFTER the replay burst is delivered").
    expect(dropSlowest.pending(SLOW_SUB_ID)).toBe(0);

    // Pump 17 steady-state frames — the slow consumer trips on the 17th.
    let droppedSubs: string[] = [];
    const FRAMES_TO_TRIP = 17;
    for (let i = 0; i < FRAMES_TO_TRIP; i += 1) {
      const seq = REPLAY_FRAMES + i + 1;
      const dropped = producer.broadcast(
        { kind: 'delta', seq, data: payload(FRAME_BYTES) },
        FRAME_BYTES,
      );
      if (dropped.length > 0) droppedSubs = droppedSubs.concat(dropped);
    }

    // Assertion: slow consumer dropped exactly once on the steady-state
    // tip-over, with the canonical drop-slowest end-reason.
    expect(droppedSubs).toEqual([SLOW_SUB_ID]);
    expect(slowStream.ended).toHaveLength(1);
    expect(slowStream.ended[0]).toEqual({
      kind: 'session-removed',
      detail: DROP_SLOWEST_DETAIL,
    });
    expect(slowStream.pushed).toHaveLength(REPLAY_FRAMES + FRAMES_TO_TRIP);
    expect(registry.getSubscribers(SESSION_ID)).toHaveLength(0);
  });

  it('handler is registered on the data-plane dispatcher under the canonical method name', () => {
    // Smoke check: the L8 probe composition relies on the handler being
    // registerable on a real data-plane dispatcher. Pinning it here means
    // a future refactor that breaks `registerPtySubscribeHandler`'s
    // dispatcher interaction also breaks the probe — we don't want a
    // green probe with a silently-misregistered handler.
    const registry = createFanoutRegistry<PtySubscribeFrame>();
    const dispatcher = createDataDispatcher();
    const { method, handle } = registerPtySubscribeHandler(dispatcher, makeCtx(registry));
    expect(method).toBe(PTY_SUBSCRIBE_METHOD);
    expect(dispatcher.has(PTY_SUBSCRIBE_METHOD)).toBe(true);
    // `handle` is a real function; we don't invoke it (the streaming
    // shape is exercised by the two functional tests above).
    expect(typeof handle).toBe('function');
  });

  it('uses the spec-default 1 MiB watermark constant (regression guard for spec line 118 / drop-slowest.ts:41)', () => {
    // If the default constant is ever moved off 1 MiB without a paired
    // spec update, this probe's frame counts (FRAMES_TO_TRIP = 17 with
    // FRAME_BYTES = 64 KiB) would silently start passing for the wrong
    // reason. Pin the constant here so the trip arithmetic stays sound.
    expect(DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES).toBe(1_048_576);
    // 16 frames of 64 KiB = 1 MiB = NOT yet overlimit; the 17th frame is
    // the canonical trip point.
    expect(16 * FRAME_BYTES).toBe(DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES);
    expect(17 * FRAME_BYTES).toBeGreaterThan(DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES);
  });
});
