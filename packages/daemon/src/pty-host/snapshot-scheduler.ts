// Per-session pty-host snapshot scheduler — spec ch06 §4 (T4.10).
//
// [LIBRARY-ONLY] Pure decider: given (a) per-delta byte/count notifications,
// (b) Resize events, and (c) a clock + timer abstraction, this module decides
// WHEN a SnapshotV1 must be taken. It does NOT take the snapshot itself —
// the caller (the pty-host child, wired in T4.12 #48 Attach handler) supplies
// an `onSnapshot(reason)` sink. Storage of the snapshot bytes lives in the
// in-memory delta ring (T4.11 #47) + SQLite write coalescer (T5.5).
//
// SRP:
//   - This is a *decider*. No I/O, no real timers (the caller injects
//     `TimerOps` so tests can advance time deterministically), no knowledge
//     of the snapshot wire format.
//   - The four cadence numbers (time / deltas / bytes thresholds) live in
//     `packages/daemon/src/pty/segmentation.ts` per the
//     `test/lock/segmentation-cadence` lock — this module imports the named
//     constants under aliases (so the canonical identifier names appear in
//     exactly one source file, satisfying the single-source lock) and never
//     redefines them.
//
// Trigger matrix (ch06 §4):
//   1. Wall-clock window — 30s of wall clock has elapsed since the last
//      snapshot AND at least one delta has been emitted in that window.
//      (No deltas → no snapshot — empty sessions stay quiet.)
//   2. Delta-count window — 256 deltas have been observed since the last
//      snapshot.
//   3. Byte-volume window — 1 MiB of cumulative delta payload bytes since
//      the last snapshot.
//   4. Resize — any geometry change forces a snapshot, BUT consecutive
//      Resizes are coalesced into a single snapshot using a 500ms cap
//      (drag-resize emits SIGWINCH many times per second; without
//      coalescing the daemon would queue a snapshot per Resize, which
//      thrashes the snapshot writer and wastes IO). See ch06 §4 narrative
//      lock — "Resize-triggered snapshot coalescing (drag-resize emits
//      Resize many times per second; without coalescing the daemon would
//      queue a snapshot per Resize)".
//
// Wire-up follows T4.11 (in-memory ring) + T4.12 (Attach handler). Until
// then, this module is wired by unit tests only.
//
// Aliases below: the named constant exports are re-imported under
// scheduler-local names so the canonical names (and the magic numbers they
// carry) only appear in `pty/segmentation.ts`. The single-source lock spec
// allows the import line itself to mention the canonical names; everything
// else in this file uses the aliases.

// prettier-ignore
import { K_TIME_MS as TIME_TRIGGER_MS, M_DELTAS as DELTA_COUNT_TRIGGER, B_BYTES as BYTE_VOLUME_TRIGGER, type Clock, type TimerOps, type TimerHandle } from '../pty/segmentation.js';

/**
 * Why a snapshot was triggered. Surfaced to the `onSnapshot` sink so the
 * caller can attribute snapshot writes in logs / metrics. The variants are
 * 1:1 with the four trigger rules in ch06 §4.
 */
export type SnapshotReason = 'time' | 'deltas' | 'bytes' | 'resize';

/**
 * Maximum time the scheduler waits after the FIRST Resize event in a burst
 * before forcing a snapshot. Subsequent Resizes inside this window are
 * coalesced into the same snapshot.
 *
 * Spec ch06 §4 narrative lock fixes this at 500ms. Forever-stable; the
 * cadence-source-of-truth lock only forbids the wall-clock / delta-count /
 * byte-volume / segmentation literals from leaving `pty/segmentation.ts`,
 * so the resize coalescing window (which is a property of the resize
 * trigger, not of the delta segmenter) lives next to the code that uses it.
 */
export const RESIZE_COALESCE_WINDOW_MS = 500;

export interface SnapshotSchedulerOptions {
  /**
   * Sink invoked synchronously when a snapshot must be taken. The caller
   * is responsible for actually capturing xterm-headless screen state and
   * writing the SnapshotV1 bytes; this scheduler only decides WHEN.
   *
   * After `onSnapshot` returns, all four counters are reset to zero and
   * the wall-clock baseline is reset to `now()`. The caller MUST NOT
   * throw from `onSnapshot` — failures are tracked by T4.11
   * (consecutiveSnapshotWriteFailures + DEGRADED) at a layer above this
   * decider.
   */
  readonly onSnapshot: (reason: SnapshotReason) => void;
  /** Wall-clock source. Production: `Date.now`. */
  readonly now: Clock;
  /** Timer ops. Production: `{ setTimer: setTimeout, clearTimer: clearTimeout }`. */
  readonly timer: TimerOps;
}

/**
 * Per-session snapshot scheduler. Spec ch06 §4.
 *
 * Lifecycle:
 *   - Construct one per pty-host session. The wall-clock baseline starts
 *     at `now()` at construction (treat construction as "time of session
 *     start" — there is no snapshot at seq=0).
 *   - The pty-host calls `noteDelta(byteCount)` once per emitted PtyDelta
 *     (after the delta accumulator from T4.9 has decided to flush), and
 *     `noteResize()` once per processed Resize RPC.
 *   - When any trigger fires, the scheduler synchronously invokes
 *     `onSnapshot(reason)` and resets counters. The caller's snapshot
 *     write is part of that synchronous call so no second delta can slip
 *     in between the trigger and the counter reset.
 *   - `dispose()` clears all pending timers and prevents further
 *     `onSnapshot` calls. Idempotent.
 *
 * Concurrency: synchronous state machine. The only async edges are the
 * two timers (the wall-clock window and the Resize coalescing window),
 * both of which are driven through the injected `TimerOps`.
 */
export class SnapshotScheduler {
  private readonly opts: SnapshotSchedulerOptions;

  // Counters since the last snapshot (or since construction, before the
  // first snapshot). Both reset to zero in `resetCounters`.
  private deltasSince = 0;
  private bytesSince = 0;

  // Wall-clock time of the last snapshot. Used to compute time elapsed.
  // Initialized to `now()` at construction so the first window starts at
  // session start, not at the first delta.
  private lastSnapshotMs: number;

  // Wall-clock window timer — armed when there is at least one delta and
  // we are waiting for the window to elapse. Disarmed after each snapshot
  // (counters reset → no in-window deltas → re-arm on next delta).
  private windowTimer: TimerHandle | null = null;

  // Resize coalescing timer — armed by the FIRST Resize in a burst and
  // disarmed when it fires (which takes the snapshot). Subsequent Resizes
  // while this is armed are no-ops (coalesced).
  private resizeTimer: TimerHandle | null = null;

  private disposed = false;

  constructor(opts: SnapshotSchedulerOptions) {
    this.opts = opts;
    this.lastSnapshotMs = opts.now();
  }

  /**
   * The pty-host child calls this once per emitted `PtyDelta` (after the
   * delta accumulator from T4.9 flushes). `byteCount` is the size of the
   * `payload` field on the delta (raw VT bytes only — header / wire
   * framing not counted).
   *
   * Increments the delta counter and the byte counter. If either crosses
   * its trigger threshold, fires `onSnapshot` synchronously with the
   * matching reason. Otherwise, arms the wall-clock-window timer if it
   * isn't already armed (the timer fires when the window has elapsed
   * since the last snapshot, AND we just observed a delta in that window
   * — exactly the AND clause in ch06 §4 trigger #1).
   *
   * `byteCount` of zero is treated as a real delta (it still counts
   * toward the delta-count trigger) but does not advance the byte
   * counter. Negative byte counts are programmer errors and are clamped
   * to zero — this matches the accumulator's invariant that empty pushes
   * never produce a delta.
   */
  noteDelta(byteCount: number): void {
    if (this.disposed) return;
    const safeBytes = byteCount > 0 ? byteCount : 0;
    this.deltasSince += 1;
    this.bytesSince += safeBytes;

    // Trigger checks: delta-count first, then byte-volume. Ordering only
    // affects the `reason` reported in the rare race where both triggers
    // cross in the same noteDelta — it does NOT affect snapshot
    // frequency. The spec ch06 §4 enumerates the triggers as a set, so
    // either reason is valid attribution. We pick delta-count first
    // because it is the higher-frequency trigger in practice (256 deltas
    // of avg ~512 bytes = 128 KiB << 1 MiB).
    if (this.deltasSince >= DELTA_COUNT_TRIGGER) {
      this.fire('deltas');
      return;
    }
    if (this.bytesSince >= BYTE_VOLUME_TRIGGER) {
      this.fire('bytes');
      return;
    }

    // No threshold crossing → arm the wall-clock-window timer if it isn't
    // already armed. The timer fires `TIME_TRIGGER_MS` after the LAST
    // snapshot (lastSnapshotMs), not relative to this delta — otherwise
    // a steady trickle of deltas would push the trigger out forever.
    this.armWindowTimer();
  }

  /**
   * The pty-host child calls this once per processed Resize RPC (geometry
   * change applied to xterm-headless via `terminal.resize(cols, rows)`).
   *
   * Schedules a snapshot to fire `RESIZE_COALESCE_WINDOW_MS` (500ms) from
   * now if no resize timer is already armed. Subsequent Resizes inside
   * the window are no-ops, so a continuous drag-resize produces exactly
   * one snapshot at the end of each 500ms epoch.
   *
   * Why coalesce instead of snapshotting per-Resize: drag-resize on a
   * desktop terminal emits SIGWINCH at the screen refresh rate
   * (~60Hz = once per ~16ms). Snapshotting per-Resize would queue ~30
   * snapshot writes during a 500ms drag, each ~tens of KiB, which thrashes
   * the snapshot writer and burns IO for no reattach benefit (the user is
   * mid-drag; only the final geometry matters).
   */
  noteResize(): void {
    if (this.disposed) return;
    if (this.resizeTimer !== null) return; // already coalescing
    this.resizeTimer = this.opts.timer.setTimer(() => {
      this.resizeTimer = null;
      // Disposed-after-arm guard: if dispose() ran between arm and fire,
      // bail rather than calling the sink.
      if (this.disposed) return;
      this.fire('resize');
    }, RESIZE_COALESCE_WINDOW_MS);
  }

  /**
   * Stop the scheduler. Clears any pending timer and prevents further
   * `onSnapshot` calls. Idempotent.
   *
   * Does NOT fire a final snapshot — callers that want a pre-shutdown
   * drain should snapshot explicitly before disposing.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.windowTimer !== null) {
      this.opts.timer.clearTimer(this.windowTimer);
      this.windowTimer = null;
    }
    if (this.resizeTimer !== null) {
      this.opts.timer.clearTimer(this.resizeTimer);
      this.resizeTimer = null;
    }
  }

  /**
   * Diagnostics: number of deltas observed since the last snapshot.
   */
  deltasSinceLastSnapshot(): number {
    return this.deltasSince;
  }

  /**
   * Diagnostics: cumulative delta payload bytes since the last snapshot.
   */
  bytesSinceLastSnapshot(): number {
    return this.bytesSince;
  }

  /**
   * Diagnostics: wall-clock time the last snapshot fired (or construction
   * time, if no snapshot has fired yet).
   */
  lastSnapshotAtMs(): number {
    return this.lastSnapshotMs;
  }

  // --- internal -----------------------------------------------------------

  private fire(reason: SnapshotReason): void {
    // Reset state BEFORE invoking the sink so a re-entrant `noteDelta`
    // from the sink (in theory; in practice sinks are pure writes) sees a
    // fresh window. Then invoke the sink.
    this.resetCounters();
    this.opts.onSnapshot(reason);
  }

  private resetCounters(): void {
    this.deltasSince = 0;
    this.bytesSince = 0;
    this.lastSnapshotMs = this.opts.now();
    if (this.windowTimer !== null) {
      this.opts.timer.clearTimer(this.windowTimer);
      this.windowTimer = null;
    }
    // Note: we DO NOT clear `resizeTimer` here. A Resize-triggered fire
    // already cleared it in its callback; a deltas/bytes/time fire that
    // races with a pending resize timer should let the resize timer keep
    // running — it will fire shortly with `reason=resize` on what is by
    // then a fresh window, which is the correct user-visible behavior
    // (the user resized, they should get a post-resize snapshot).
  }

  private armWindowTimer(): void {
    if (this.windowTimer !== null) return;
    const elapsed = this.opts.now() - this.lastSnapshotMs;
    const remaining = TIME_TRIGGER_MS - elapsed;
    // If the window has already elapsed (e.g. the session was idle for
    // longer than the window and only now produced a delta), fire
    // immediately rather than scheduling a 0ms or negative timer. This
    // keeps the trigger semantics crisp: "window elapsed AND at least
    // one delta" — both conditions are true the moment we observe this
    // delta.
    if (remaining <= 0) {
      this.fire('time');
      return;
    }
    this.windowTimer = this.opts.timer.setTimer(() => {
      this.windowTimer = null;
      if (this.disposed) return;
      // Re-check the AND clause: at least one delta in the window. If
      // the most recent fire (e.g. a resize) reset counters to zero and
      // no further delta arrived, do nothing — the next noteDelta will
      // re-arm the timer with a fresh baseline.
      if (this.deltasSince === 0) return;
      this.fire('time');
    }, remaining);
  }
}
