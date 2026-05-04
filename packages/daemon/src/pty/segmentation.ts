// PTY delta segmentation cadence — spec ch06 §3 (FOREVER-STABLE).
//
// This file is the SINGLE source of truth for the per-session pty cadence
// constants used throughout the daemon. The `test/lock/segmentation-cadence`
// lock spec asserts that the numeric literals (16, 16384, 30000, 256,
// 1048576) and the named exports below MUST NOT appear in any other file
// under `packages/daemon/src/`. Consumers import from here.
//
// Why one file:
//   - The cadence is per-session (NOT per-subscriber): the pty-host child
//     accumulates raw VT bytes once per session and broadcasts each
//     resulting `PtyDelta` to every Attach subscriber as the SAME byte
//     range. A second source of truth would invite skew between the
//     accumulator (T4.9) and the snapshot scheduler (T4.10) and would
//     break ship-gate (b)/(c) byte-equality on reattach.
//   - v0.4 web/iOS clients reuse identical cadence; client-side coalescing
//     for high-latency transports happens in the renderer, NEVER on the
//     daemon emitter (see ch06 §3 narrative lock + ch15 §3 #26).
//
// SRP:
//   - This module is a *decider*: a `DeltaAccumulator` is a pure-ish
//     state machine that, given (a) a stream of raw VT byte chunks from
//     `node-pty.master.onData` and (b) a clock + flush callback, emits
//     monotonic-seq `PtyDeltaPayload`s at the 16 ms / 16 KiB boundary.
//     It owns NO I/O: no timers fire on the JS event loop unless the
//     caller wires `setTimeout` to `arm`/`disarm`; the test harness drives
//     time deterministically via an injected clock.
//   - The constants are exported individually AND grouped under
//     `PTY_CADENCE` so call sites can pick whichever ergonomics fit.
//   - T4.10 (snapshot scheduler) imports K_TIME_MS / M_DELTAS / B_BYTES
//     from here; T4.9 (this PR) only USES the segmentation constants but
//     EXPORTS all five so the lock spec passes once the file exists.

/**
 * Maximum time the delta accumulator buffers raw VT bytes before flushing
 * a `PtyDelta`. **16 milliseconds** matches the snapshot/write coalescer
 * tick (ch07 §5) so all daemon-wide async fan-out happens on the same
 * cadence — no jitter between delta-emit and SQLite-write.
 *
 * FOREVER-STABLE per spec ch06 §3.
 */
export const SEGMENTATION_TIMEOUT_MS = 16;

/**
 * Maximum bytes the delta accumulator buffers before forcing a flush —
 * **16 KiB = 16384 bytes**. Picked so a single `PtyDelta.payload` fits in
 * a typical TLS record / HTTP/2 frame without needing on-wire splitting.
 *
 * FOREVER-STABLE per spec ch06 §3.
 */
export const SEGMENTATION_BYTE_CAP = 16384;

/**
 * Snapshot cadence — time trigger. The pty-host snapshot scheduler
 * (T4.10) takes a snapshot after **30 seconds** since the last snapshot
 * if at least one delta has been emitted in that window.
 *
 * FOREVER-STABLE per spec ch06 §4. Exported here (not in the snapshot
 * scheduler module) so the cadence-source-of-truth lock holds.
 */
export const K_TIME_MS = 30000;

/**
 * Snapshot cadence — delta-count trigger. **256 deltas** since the last
 * snapshot forces a new snapshot.
 *
 * FOREVER-STABLE per spec ch06 §4.
 */
export const M_DELTAS = 256;

/**
 * Snapshot cadence — byte-volume trigger. **1 MiB = 1048576 bytes** of
 * cumulative delta payload since the last snapshot forces a new snapshot.
 *
 * FOREVER-STABLE per spec ch06 §4.
 */
export const B_BYTES = 1048576;

/**
 * Convenience grouped object for call sites that prefer a single import.
 * Mirrors the named exports above; both shapes are FOREVER-STABLE.
 */
export const PTY_CADENCE = Object.freeze({
  SEGMENTATION_TIMEOUT_MS,
  SEGMENTATION_BYTE_CAP,
  K_TIME_MS,
  M_DELTAS,
  B_BYTES,
} as const);

/**
 * One emitted segment. The payload is a contiguous slice of raw VT bytes
 * (ch06 §3: "no re-encoding, no escape-sequence parsing on the daemon
 * side"). `seq` is per-session, monotonically increasing by 1, never
 * reused, and starts at `firstSeq` (defaulting to 1) for the lifetime of
 * one accumulator instance.
 *
 * `tsMs` is the wall-clock time at the FIRST byte of the segment,
 * captured via the injected clock. It is NOT used as part of the wire
 * format (raw VT only) but is included so the snapshot scheduler (T4.10)
 * can correlate with the K_TIME trigger and so log lines can attribute
 * latency.
 */
export interface PtyDeltaPayload {
  readonly seq: number;
  readonly payload: Uint8Array;
  readonly tsMs: number;
}

/**
 * Caller-injected clock. Deterministic tests pass a fake clock; production
 * passes `Date.now`. The accumulator never reads the wall clock directly.
 */
export type Clock = () => number;

/**
 * Caller-injected timer ops. Production code wires these to `setTimeout`
 * / `clearTimeout`; tests pass deterministic stubs that surface the
 * scheduled deadline so the harness can advance time exactly.
 *
 * The accumulator only ever holds AT MOST ONE pending timer (the 16 ms
 * deadline starting from the first byte of the current segment). It is
 * the caller's responsibility to make sure `setTimer` is idempotent in
 * the face of synchronous re-arming, which the implementation does
 * internally by always clearing before re-arming.
 */
export interface TimerOps {
  setTimer(cb: () => void, delayMs: number): TimerHandle;
  clearTimer(h: TimerHandle): void;
}

/** Opaque timer handle — `unknown` because production uses Node's
 *  `Timeout` and tests use whatever stub they like. */
export type TimerHandle = unknown;

export interface DeltaAccumulatorOptions {
  /** Sink invoked synchronously when a segment is ready to emit.
   *  Caller fans the payload out to the IPC channel + the in-memory ring
   *  + the SQLite write coalescer. The accumulator does NOT care what
   *  the sink does — it only cares that `seq` is consumed. */
  readonly onDelta: (delta: PtyDeltaPayload) => void;
  /** Wall-clock source. Production: `Date.now`. */
  readonly now: Clock;
  /** Timer ops. Production: `{ setTimer: setTimeout, clearTimer: clearTimeout }`. */
  readonly timer: TimerOps;
  /** First `seq` value to emit. Defaults to `1`. After daemon restart
   *  the caller passes `lastSnapshotBaseSeq + 1` so the seq sequence
   *  continues monotonically across the restart boundary (ch06 §7). */
  readonly firstSeq?: number;
}

/**
 * Per-session raw-VT delta accumulator. Spec ch06 §3.
 *
 * Contract:
 *   - `push(bytes)` MAY be called any number of times with any byte
 *     count >= 0 (zero-byte calls are allowed and are a no-op).
 *   - On the first byte of a segment, the accumulator arms a 16 ms
 *     deadline via `timer.setTimer`. If the buffer reaches 16 KiB before
 *     the deadline fires, the accumulator flushes synchronously and
 *     disarms the timer. If the deadline fires first, the accumulator
 *     flushes whatever is buffered.
 *   - When the byte cap is hit MID-CHUNK (a single `push` carries enough
 *     bytes to overflow), the accumulator flushes the prefix that fills
 *     the cap, then loops on the suffix. A single `push` of 50_000 bytes
 *     produces three back-to-back full-cap `onDelta` calls and a tail
 *     segment that arms the timer.
 *   - Empty intervals (no `push` between two timer fires) emit no delta —
 *     the timer never arms while the buffer is empty, so this is by
 *     construction (not a special case).
 *   - `flushNow()` is the manual-flush entry the snapshot scheduler
 *     (T4.10) calls before taking a snapshot, so the snapshot's
 *     `base_seq` matches the most-recent emitted delta. No-op when the
 *     buffer is empty.
 *   - `dispose()` clears any pending timer and prevents further
 *     `onDelta` calls. The accumulator is NOT reusable after dispose.
 *
 * Concurrency: this is a synchronous state machine running on the JS
 * event loop. There is no locking; the only async edge is the timer
 * callback the caller schedules.
 */
export class DeltaAccumulator {
  private readonly opts: Required<Omit<DeltaAccumulatorOptions, 'firstSeq'>> & {
    firstSeq: number;
  };
  private buf: Uint8Array[] = [];
  private bufBytes = 0;
  private nextSeq: number;
  private pendingTimer: TimerHandle | null = null;
  private firstByteTsMs: number | null = null;
  private disposed = false;

  constructor(opts: DeltaAccumulatorOptions) {
    this.opts = {
      onDelta: opts.onDelta,
      now: opts.now,
      timer: opts.timer,
      firstSeq: opts.firstSeq ?? 1,
    };
    this.nextSeq = this.opts.firstSeq;
  }

  /**
   * Feed raw VT bytes (`node-pty` master `data` event) into the
   * accumulator. Splits the input across as many `onDelta` calls as the
   * 16 KiB cap requires, then arms the 16 ms deadline if any tail bytes
   * remain buffered.
   *
   * Zero-byte input is a legal no-op (some terminal emitters can flush a
   * `Buffer.alloc(0)` between real writes; treating it as a delta would
   * burn a `seq` for no observable bytes).
   */
  push(bytes: Uint8Array): void {
    if (this.disposed) return;
    if (bytes.length === 0) return;

    let view = bytes;
    while (view.length > 0) {
      const room = SEGMENTATION_BYTE_CAP - this.bufBytes;
      if (view.length >= room) {
        // This chunk fills the segment. Take `room` bytes, flush, loop
        // on the remainder (which may itself be >= 16 KiB — the loop
        // handles that the same way).
        const head = view.subarray(0, room);
        this.appendNoArm(head);
        this.flushBuffered();
        view = view.subarray(room);
      } else {
        // Fits in the current segment. Append; the timer-arm happens at
        // the bottom of the function so a synchronous flush above does
        // not leave a stale timer pending.
        this.appendNoArm(view);
        view = view.subarray(view.length);
      }
    }

    if (this.bufBytes > 0 && this.pendingTimer === null) {
      this.armTimer();
    }
  }

  /**
   * Flush any buffered bytes immediately. Called by the snapshot
   * scheduler (T4.10) so the snapshot's `base_seq` reflects the
   * most-recent emitted delta, and by callers that want to drain on
   * shutdown before disposing.
   *
   * No-op when the buffer is empty.
   */
  flushNow(): void {
    if (this.disposed) return;
    if (this.bufBytes === 0) return;
    this.flushBuffered();
  }

  /**
   * Stop the accumulator. Clears the pending timer if any. Does NOT
   * flush buffered bytes — buffered bytes that have not yet been emitted
   * are dropped, because `dispose` is called on session teardown (the
   * pty-host child is exiting) and the daemon already serialized the
   * latest snapshot via T4.10's pre-shutdown flush. Callers that need a
   * pre-dispose drain should call `flushNow()` first.
   *
   * After dispose, `push` / `flushNow` are silent no-ops.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pendingTimer !== null) {
      this.opts.timer.clearTimer(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.buf = [];
    this.bufBytes = 0;
    this.firstByteTsMs = null;
  }

  /**
   * Returns the seq value that the NEXT emitted delta will carry. Used
   * by the snapshot scheduler to compute `base_seq` after a flush
   * (`base_seq = nextSeqWillEmit() - 1`) and by tests for assertions.
   */
  nextSeqWillEmit(): number {
    return this.nextSeq;
  }

  /**
   * Returns the number of bytes currently buffered (not yet emitted).
   * Useful for diagnostics and for tests that want to assert on
   * mid-segment state without forcing a flush.
   */
  bufferedBytes(): number {
    return this.bufBytes;
  }

  // --- internal -----------------------------------------------------------

  private appendNoArm(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (this.bufBytes === 0) {
      this.firstByteTsMs = this.opts.now();
    }
    this.buf.push(bytes);
    this.bufBytes += bytes.length;
  }

  private armTimer(): void {
    // Always disarm before arming so the invariant "at most one pending
    // timer" holds. The caller's `setTimer` may be a stub that returns a
    // sentinel; clearing a fresh handle is harmless.
    if (this.pendingTimer !== null) {
      this.opts.timer.clearTimer(this.pendingTimer);
    }
    this.pendingTimer = this.opts.timer.setTimer(() => {
      this.pendingTimer = null;
      if (this.bufBytes > 0) {
        this.flushBuffered();
      }
    }, SEGMENTATION_TIMEOUT_MS);
  }

  private flushBuffered(): void {
    if (this.bufBytes === 0) return;
    if (this.pendingTimer !== null) {
      this.opts.timer.clearTimer(this.pendingTimer);
      this.pendingTimer = null;
    }
    const merged = concatChunks(this.buf, this.bufBytes);
    const tsMs = this.firstByteTsMs ?? this.opts.now();
    this.buf = [];
    this.bufBytes = 0;
    this.firstByteTsMs = null;

    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.opts.onDelta({ seq, payload: merged, tsMs });
  }
}

/**
 * Concatenate a list of `Uint8Array` chunks into a single `Uint8Array`
 * of length `total`. Pulled out so the hot-path `flushBuffered` reads
 * top-to-bottom without an inline reduce.
 *
 * Uses `Uint8Array` (not `Buffer`) for portability — the accumulator
 * lives in `packages/daemon/src/` and is consumed by code that ships
 * over IPC where the daemon may convert to `Buffer` later, but the
 * accumulator itself stays Node-API-agnostic so it is unit-testable in
 * any JS runtime (vitest, browser-mode, etc.).
 */
function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
