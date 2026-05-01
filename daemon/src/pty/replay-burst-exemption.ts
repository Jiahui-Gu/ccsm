// PTY replay-burst exemption (spec §3.5.1.5 / frag-3.5.1 lines 120, 135, 165, 201).
//
// Wraps the per-subscriber replay window so the bounded (256 KB) snapshot
// payload delivered as the first post-resubscribe write is EXEMPT from the
// T43 drop-slowest 1 MiB watermark accounting.
//
// Why the exemption exists (spec line 120):
//   The 256 KB replay payload is a *one-shot, per-message hard limit* on the
//   resubscribe burst; the 1 MiB drop-slowest watermark is a *steady-state
//   per-second flow rate cap* on the per-subscriber Connect buffer. They
//   measure different things on different time scales. Without this seam, a
//   nodemon dev save-storm with 5 sessions producing 100 KB/s could exceed
//   1 MiB on the first post-reconnect frame, drop the stream as slow,
//   re-resubscribe, loop. The exemption breaks that loop.
//
// Single Responsibility (per `feedback_single_responsibility`):
//   - producer of replay-mode lifecycle events (enter/exit) keyed by subId;
//   - decider for the per-write `exempt` flag during replay-mode;
//   - NOT a sink: does not write bytes, does not log, does not emit metrics.
//     The fan-out caller (T44 wiring) calls `enterReplay(subId)` before
//     pushing the snapshot bytes through the returned recorder and
//     `exitReplay(subId)` once the snapshot has flushed; both calls are
//     idempotent enough that the lifecycle is a single decision point.
//
// Coordination with T43 drop-slowest:
//   The drop-slowest module exposes two compatible seams (see its file
//   header lines 18-33). This module USES BOTH:
//     * `record(subId, byteCount, { exempt: true })` for every write that
//       lands during replay-mode — covers the "snapshot bytes interleaved
//       with steady-state writes" race the T43 header calls out.
//     * `reset(subId)` on `exitReplay` so steady-state accounting starts
//       from zero immediately AFTER the burst, matching the spec wording
//       "watermark is measured AFTER the replay burst is delivered."
//   The redundancy is intentional: ordering of the snapshot writes vs any
//   coincident broadcast writes is therefore safe; the post-burst reset
//   collapses any residual tally to zero before normal accounting resumes.
//
// Hard non-goals (do NOT add here, push back if asked):
//   - No socket I/O (caller owns the actual `socket.write`).
//   - No replay-payload framing or 256 KB clamping (frag-3.7 / T44 territory).
//   - No `gap: true` flag handling (resubscribe RPC owns it).
//   - No drop-slowest threshold enforcement (T43 owns `getOverlimit()`).

import type { DropSlowest } from './drop-slowest.js';

/**
 * Per-write recorder returned by `enterReplay`. Caller invokes this for each
 * snapshot byte chunk that lands during the replay window. Internally it
 * forwards to the underlying drop-slowest with `{ exempt: true }`.
 *
 * `byteCount` MUST be a non-negative integer (the underlying drop-slowest
 * enforces this and throws on violation).
 */
export type ExemptRecorder = (byteCount: number) => void;

/**
 * Public surface of the replay-burst exemption module.
 *
 * Lifecycle contract:
 *   enterReplay(subId) → exemptRecord(...)+ → exitReplay(subId)
 *
 *   - `enterReplay` is idempotent: calling it twice for the same `subId`
 *     without an intervening `exitReplay` returns a recorder bound to the
 *     same replay window (no double-count, no crash). Useful when the
 *     caller's resubscribe path is re-entrant (e.g. retried snapshot fetch).
 *   - `exitReplay` is idempotent: calling it on a `subId` that is not in
 *     replay-mode is a no-op (no throw). This means the caller's try/finally
 *     can safely run `exitReplay` even on the cancellation path.
 *   - Calling `exemptRecord` AFTER `exitReplay` for that subId records as a
 *     normal (non-exempt) write through the underlying drop-slowest. This
 *     mirrors the spec semantics: the exemption window closes precisely at
 *     `exitReplay`; subsequent writes are steady-state.
 */
export interface ReplayBurstExemption {
  /**
   * Mark `subId` as in replay-mode. Returns a recorder that the caller uses
   * for every snapshot byte chunk written during this window. Idempotent
   * (see lifecycle contract).
   */
  enterReplay(subId: string): ExemptRecorder;
  /**
   * End the replay window for `subId` and reset the underlying drop-slowest
   * tally for `subId` to 0 (so steady-state accounting starts fresh after
   * the burst). Idempotent. No-op if `subId` was not in replay-mode.
   */
  exitReplay(subId: string): void;
  /**
   * Test/observability accessor — returns `true` iff `subId` is currently in
   * replay-mode. Not used by production callers.
   */
  isInReplay(subId: string): boolean;
}

/** Construction options. */
export interface ReplayBurstExemptionOptions {
  /**
   * The drop-slowest decider whose accounting this module is exempting from.
   * Typically the per-session instance owned by the fan-out registry wiring.
   */
  readonly dropSlowest: DropSlowest;
}

/**
 * Construct a replay-burst exemption. One instance per drop-slowest decider
 * (i.e. one per session, mirroring the drop-slowest construction site).
 */
export function createReplayBurstExemption(
  opts: ReplayBurstExemptionOptions,
): ReplayBurstExemption {
  const dropSlowest = opts.dropSlowest;
  if (!dropSlowest) {
    throw new TypeError(
      'createReplayBurstExemption requires opts.dropSlowest',
    );
  }
  // Set of subIds currently in replay-mode. Identity-only — no per-sub state
  // needed since the exempt flag is a single bit decided by membership.
  const inReplay = new Set<string>();

  function enterReplay(subId: string): ExemptRecorder {
    inReplay.add(subId);
    // Bind the recorder to the subId at enterReplay time. Membership in
    // `inReplay` is checked at each invocation so a write that lands AFTER
    // exitReplay records as steady-state (see lifecycle contract).
    return (byteCount: number) => {
      if (inReplay.has(subId)) {
        dropSlowest.record(subId, byteCount, { exempt: true });
      } else {
        dropSlowest.record(subId, byteCount);
      }
    };
  }

  function exitReplay(subId: string): void {
    if (!inReplay.has(subId)) return;
    inReplay.delete(subId);
    // Reset the tally so any residual exempt-bookkeeping (none today, but
    // the seam is documented) AND any coincident steady-state writes that
    // landed during the burst are collapsed to zero. Spec line 120:
    // "1 MB drop-slowest watermark is measured AFTER the replay burst is
    // delivered."
    dropSlowest.reset(subId);
  }

  function isInReplay(subId: string): boolean {
    return inReplay.has(subId);
  }

  return { enterReplay, exitReplay, isInReplay };
}
