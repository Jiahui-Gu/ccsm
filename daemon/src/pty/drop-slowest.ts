// PTY subscriber drop-slowest watermark (spec §3.5.1.5 / frag-3.5.1 lines
// 118, 134, 165, 201).
//
// Pure decider primitive used by the per-session fan-out registry. The spec
// mandates a per-subscriber 1 MiB pending-bytes watermark: once a subscriber's
// in-flight (Connect-buffered) byte count strictly exceeds the threshold, the
// subscriber is flagged `slow` and the caller closes its server-stream with
// `RESOURCE_EXHAUSTED` and unregisters it. Drop-slowest preserves desktop UX
// at the cost of forcing the slow client to resume from `fromSeq` (cheap —
// the seq replay in §3.5 is exactly what makes this safe).
//
// Single Responsibility (per `feedback_single_responsibility`):
//   - producer of an in-flight byte count per subscriber;
//   - decider for the threshold predicate (strict greater-than);
//   - NOT a sink: no socket close, no log emission, no metric. The caller
//     reads `getOverlimit()` and performs the close + log + unregister.
//
// Replay-burst exemption seam (spec line 120, 135, 165, 201) — TRACKED IN
// SEPARATE TASK #1004 / T47:
//   The 256 KB replay payload delivered as the first post-resubscribe write
//   does NOT count toward this watermark. The contract here exposes two
//   compatible seams:
//     * `reset(subId)` — caller calls it AFTER the replay write has flushed
//       so steady-state accounting starts from zero (the spec's "watermark is
//       measured AFTER the replay burst is delivered" wording maps to this
//       sequencing).
//     * `record(subId, byteCount, { exempt: true })` — caller may instead
//       record the replay write with the `exempt` flag set; the decider
//       short-circuits and does NOT add to the tally. This is the seam T47
//       wires into the resubscribe code path so the replay write and any
//       coincident steady-state writes can be ordered freely.
//   Both seams are intentionally redundant — T47 picks one. Documented here
//   so this file does not need re-opening when T47 lands.
//
// Threshold semantics (spec line 134, "after exactly 1 MB"):
//   Strict greater-than. Exactly 1 MiB pending = NOT yet overlimit. Tally
//   crosses the threshold only on the write that pushes pending past
//   1_048_576 bytes. This matches the spec's "past 1 MB" wording (line 118).

/** 1 MiB — the spec-mandated default per-subscriber watermark. */
export const DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES = 1_048_576 as const;

/** Construction options. */
export interface DropSlowestOptions {
  /**
   * Per-subscriber pending-bytes watermark. Strict greater-than: a subscriber
   * is overlimit only when its tally is `> thresholdBytes`. Defaults to
   * `DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES` (1 MiB). Must be a positive
   * integer.
   */
  readonly thresholdBytes?: number;
}

/** Per-`record()` options. */
export interface DropSlowestRecordOptions {
  /**
   * If `true`, the byte count is NOT added to the subscriber's tally. Used
   * by the resubscribe path (T47) to deliver the bounded replay payload
   * without tripping the steady-state watermark. See file header for the
   * cross-task contract.
   *
   * Default `false`.
   */
  readonly exempt?: boolean;
}

export interface DropSlowest {
  /**
   * Add `byteCount` to the subscriber's pending-bytes tally. Caller invokes
   * this on each enqueue (i.e. each `socket.write` whose bytes are now sitting
   * in Connect's per-stream buffer). `byteCount` MUST be a non-negative
   * finite integer; zero is a no-op. Negative values throw.
   *
   * Pass `{ exempt: true }` to skip accounting (replay-burst exemption seam,
   * see file header).
   */
  record(subId: string, byteCount: number, opts?: DropSlowestRecordOptions): void;
  /**
   * Decrement the subscriber's pending tally by `byteCount` (caller invokes
   * this when a previously-enqueued chunk has flushed to the OS socket /
   * has been consumed by Connect's drain). Tally is clamped at 0 — a stray
   * over-decrement is silently absorbed rather than thrown so a flush-callback
   * race cannot crash the daemon. `byteCount` MUST be non-negative finite.
   *
   * Convenience name `flush` is exposed alongside `record(neg)` because the
   * caller's intent ("bytes left the buffer") reads more clearly than a
   * signed `record`.
   */
  flush(subId: string, byteCount: number): void;
  /**
   * Reset a subscriber's tally to 0. Used (a) when the caller has dropped the
   * subscriber and is about to forget it (followed by `forget()`), and (b)
   * after the replay write has flushed on resubscribe (T47 exemption seam,
   * see file header).
   */
  reset(subId: string): void;
  /**
   * Forget a subscriber entirely (no tally, no entry). Caller invokes this
   * after closing the stream so the internal map does not leak. Idempotent.
   */
  forget(subId: string): void;
  /**
   * Return the list of subscribers whose tally is strictly greater than
   * `thresholdBytes`. Caller iterates the result and closes each stream with
   * `RESOURCE_EXHAUSTED`, then calls `forget(subId)`. Order is insertion
   * order of first `record()` per subscriber; callers that need oldest-slowest
   * ordering (aggregate cap, frag-3.5.1 line 119, separate task) layer their
   * own LRU on top.
   */
  getOverlimit(): string[];
  /**
   * Test/observability accessor. Returns the current pending-bytes tally for
   * `subId` (0 if unknown).
   */
  pending(subId: string): number;
}

/**
 * Construct a drop-slowest decider. One instance per fan-out registry (i.e.
 * one per session) — keeps subscriber-id scope local to the registry that
 * owns the IDs.
 */
export function createDropSlowest(opts: DropSlowestOptions = {}): DropSlowest {
  const thresholdBytes = opts.thresholdBytes ?? DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES;
  if (!Number.isInteger(thresholdBytes) || thresholdBytes <= 0) {
    throw new RangeError(
      `drop-slowest thresholdBytes must be a positive integer, got ${thresholdBytes}`,
    );
  }

  // Insertion-ordered for stable `getOverlimit()` output. `Map` preserves
  // insertion order per ECMAScript spec, which is what we want.
  const tally = new Map<string, number>();

  function assertNonNegByteCount(byteCount: number, fnName: string): void {
    if (!Number.isFinite(byteCount) || byteCount < 0 || !Number.isInteger(byteCount)) {
      throw new RangeError(
        `drop-slowest ${fnName} byteCount must be a non-negative integer, got ${byteCount}`,
      );
    }
  }

  function record(
    subId: string,
    byteCount: number,
    recordOpts?: DropSlowestRecordOptions,
  ): void {
    assertNonNegByteCount(byteCount, 'record');
    if (recordOpts?.exempt) return;
    if (byteCount === 0) {
      // Touch the entry so insertion order is established even on a no-op,
      // mirroring the contract that `pending(subId)` returns 0 (not undefined)
      // after any `record()` has been called for that subscriber.
      if (!tally.has(subId)) tally.set(subId, 0);
      return;
    }
    const prev = tally.get(subId) ?? 0;
    tally.set(subId, prev + byteCount);
  }

  function flush(subId: string, byteCount: number): void {
    assertNonNegByteCount(byteCount, 'flush');
    if (byteCount === 0) return;
    const prev = tally.get(subId);
    if (prev === undefined) return; // never recorded — nothing to flush
    const next = prev - byteCount;
    tally.set(subId, next > 0 ? next : 0);
  }

  function reset(subId: string): void {
    if (tally.has(subId)) tally.set(subId, 0);
  }

  function forget(subId: string): void {
    tally.delete(subId);
  }

  function getOverlimit(): string[] {
    const out: string[] = [];
    for (const [subId, bytes] of tally) {
      if (bytes > thresholdBytes) out.push(subId);
    }
    return out;
  }

  function pending(subId: string): number {
    return tally.get(subId) ?? 0;
  }

  return { record, flush, reset, forget, getOverlimit, pending };
}
