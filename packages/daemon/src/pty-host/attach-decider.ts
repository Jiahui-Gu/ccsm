// PtyService.Attach `since_seq` resume decider — pure function (no I/O).
//
// Spec ref: docs/superpowers/specs/2026-05-04-pty-attach-handler.md §3
// (since_seq resume decision tree) and §9.1 T-PA-2 (this task).
//
// SRP layering — this module is a `decider` per dev.md §2: pure function
// `(sinceSeq, currentMaxSeq, oldestRetainedSeq, currentSnapshot,
// deltasSince) -> ResumeDecision`. No reading, no writing, no awaiting.
// The Attach handler (T-PA-6, future PR) is the `sink` that consumes the
// verdict and either streams a snapshot+live or replays deltas or throws
// the structured ConnectError. The `PtySessionEmitter` (T-PA-5, future
// PR) is the `producer` that owns the in-memory snapshot/ring this decider
// reads through the injected `deltasSince` callback.
//
// Mirrors `decideWatchScope` in sessions/watch-sessions.ts (same shape:
// pure function returning a discriminated union; sink translates `refused_*`
// verdicts into ConnectError). Two copies of the pattern are clearer than
// a shared abstraction (each decider's verdict shape is concern-specific).
//
// Layer 1 — alternatives checked:
//   - Embed the decision logic inline in the Attach handler (T-PA-6).
//     Rejected: §3 has four branches with non-trivial seq math; pulling
//     them out as a pure function makes the branches independently
//     unit-testable without spinning up a Connect handler / pty-host
//     child / SQLite. The spec §9.1 explicitly calls out T-PA-2 as a
//     forward-safe split for this reason.
//   - Make this a class with state (cache the last verdict). Rejected:
//     decider per dev.md §2 SRP MUST be stateless; caching belongs to
//     the emitter (which already owns the in-memory ring).
//
// Forever-stable invariants this decider locks (spec §10):
//   - synthetic snapshot at base_seq=0n is treated as a normal snapshot
//     by the `since_seq=0` branch (no special case);
//   - too-far-behind ⇒ refused_too_far_behind verdict (sink maps to
//     Code.OutOfRange + "pty.attach_too_far_behind");
//   - future seq ⇒ refused_protocol_violation verdict (sink maps to
//     Code.InvalidArgument + "pty.attach_future_seq").

// ---------------------------------------------------------------------------
// In-memory shapes the decider reads (forward-declared here; the
// PtySessionEmitter in T-PA-5 will export the same shapes from a shared
// neighbor module and this file will re-export from there. Defining them
// inline today keeps this PR forward-safe — T-PA-5 lands without churning
// the decider's import surface).
// ---------------------------------------------------------------------------

/**
 * In-memory snapshot record held by the daemon-main per-session emitter.
 *
 * `baseSeq` is the seq of the last delta at capture time. The synthetic
 * initial snapshot (spec §3.3, emitted by the pty-host child on `'ready'`
 * before any deltas) carries `baseSeq = 0n`. After cadence-driven
 * snapshots fire (spec ch06 §4: 30s / 256 deltas / 1 MiB / Resize), this
 * value advances monotonically per session.
 *
 * `screenState` is the SnapshotV1 wire bytes (already zstd-wrapped by the
 * codec package per spec ch06 §2). The decider treats it as opaque — only
 * the sink hands it to the proto mapper.
 */
export interface PtySnapshotInMem {
  readonly baseSeq: bigint;
  readonly geometry: { readonly cols: number; readonly rows: number };
  readonly screenState: Uint8Array;
  readonly schemaVersion: number;
}

/**
 * In-memory delta record held in the per-session ring (last
 * `DELTA_RETENTION_SEQS = 4096` entries; spec §2.3, §4.5). `seq` is
 * monotonically-increasing per session; the synthetic initial snapshot
 * occupies the `baseSeq=0` slot but no `DeltaInMem` carries `seq=0n`
 * (deltas start at `1n`).
 */
export interface DeltaInMem {
  readonly seq: bigint;
  readonly tsUnixMs: bigint;
  readonly payload: Uint8Array;
}

// ---------------------------------------------------------------------------
// Decider verdict shape (discriminated union; mirrors WatchScopeVerdict).
// ---------------------------------------------------------------------------

/**
 * Verdict the decider returns. Pure data; the Attach handler (sink)
 * translates `refused_*` variants into `ConnectError` and streams the
 * `snapshot_then_live` / `deltas_only` variants onto the wire.
 *
 * The four variants enumerate the four branches of spec §3.1 + §3.4:
 *
 *   - `snapshot_then_live`     — `sinceSeq == 0n`. Sink emits one
 *                                `PtyFrame.snapshot` then subscribes for
 *                                live deltas at `resumeSeq`
 *                                (== snapshot.baseSeq + 1n).
 *
 *   - `deltas_only`            — `0n < sinceSeq <= currentMaxSeq` AND
 *                                `sinceSeq >= oldestRetainedSeq`. Sink
 *                                replays the `(sinceSeq, currentMaxSeq]`
 *                                slice from `deltas`, then subscribes for
 *                                live deltas at `resumeSeq`.
 *
 *   - `refused_too_far_behind` — `sinceSeq < oldestRetainedSeq`. Sink
 *                                throws `Code.OutOfRange` with
 *                                `ErrorDetail.code = "pty.attach_too_far_behind"`,
 *                                detail carrying `sinceSeq` +
 *                                `oldestRetainedSeq` (per spec §3.2).
 *
 *   - `refused_protocol_violation` — `sinceSeq > currentMaxSeq`. Sink
 *                                throws `Code.InvalidArgument` with
 *                                `ErrorDetail.code = "pty.attach_future_seq"`
 *                                (per spec §3.4). This branch should never
 *                                fire for a correct client; surfacing it
 *                                loudly catches `lastAppliedSeq` accounting
 *                                bugs in the renderer.
 */
export type ResumeDecision =
  | {
      readonly kind: 'snapshot_then_live';
      readonly snapshot: PtySnapshotInMem;
      readonly resumeSeq: bigint;
    }
  | {
      readonly kind: 'deltas_only';
      readonly deltas: readonly DeltaInMem[];
      readonly resumeSeq: bigint;
    }
  | {
      readonly kind: 'refused_too_far_behind';
      readonly reason: 'out-of-window';
      readonly sinceSeq: bigint;
      readonly oldestRetainedSeq: bigint;
    }
  | {
      readonly kind: 'refused_protocol_violation';
      readonly reason: 'future-seq';
      readonly sinceSeq: bigint;
      readonly currentMaxSeq: bigint;
    };

// ---------------------------------------------------------------------------
// Decider input
// ---------------------------------------------------------------------------

/**
 * Inputs the decider needs. Modelled as an injected struct so the unit
 * tests can drive every branch without constructing a full
 * `PtySessionEmitter`. The handler (T-PA-6) will populate this from the
 * emitter's accessors:
 *
 *   ```ts
 *   decideAttachResume({
 *     sinceSeq: req.sinceSeq,
 *     currentMaxSeq: emitter.currentMaxSeq,
 *     oldestRetainedSeq: emitter.oldestRetainedSeq,
 *     currentSnapshot: emitter.currentSnapshot(),
 *     deltasSince: (s) => emitter.deltasSince(s),
 *   });
 *   ```
 *
 * `currentSnapshot` MAY be `null` ONLY in the first-snapshot race window
 * (spec §3.3); when it is, the `snapshot_then_live` branch returns a
 * verdict whose `snapshot` field is sourced via `emitter.awaitSnapshot()`
 * by the sink — but that's an I/O concern, NOT a decider concern. To keep
 * the decider pure, the `snapshot_then_live` branch requires a
 * non-null `currentSnapshot`; if the sink encounters the race it must
 * await the snapshot first and then call the decider with the resolved
 * value. The decider throws a clear error if invoked with a null
 * snapshot on the `sinceSeq=0n` branch (programming error, not a runtime
 * condition) so the contract is checkable at the call site.
 */
export interface ResumeDeciderInput {
  /** `AttachRequest.since_seq` from the wire. `0n` means "fresh attach". */
  readonly sinceSeq: bigint;
  /** Highest seq ever emitted to subscribers; `0n` if no deltas yet. */
  readonly currentMaxSeq: bigint;
  /**
   * Lowest seq still in the in-memory ring (== `max(1n, currentMaxSeq -
   * N + 1n)` once N deltas exist; `0n` before any deltas). When
   * `currentMaxSeq == 0n`, this is `0n` and the deltas-only branch is
   * unreachable (any positive `sinceSeq` > `currentMaxSeq` ⇒
   * future-seq).
   */
  readonly oldestRetainedSeq: bigint;
  /**
   * Most recent snapshot in memory, or `null` if the synthetic initial
   * snapshot has not yet been captured (race window per spec §3.3). The
   * sink resolves the null case via `awaitSnapshot()` BEFORE calling the
   * decider — see `ResumeDeciderInput` doc above.
   */
  readonly currentSnapshot: PtySnapshotInMem | null;
  /**
   * Source of the `(sinceSeq, currentMaxSeq]` slice for the deltas-only
   * branch. Must return the deltas with `seq` strictly greater than the
   * argument and less-than-or-equal to `currentMaxSeq`, in seq-order. The
   * decider only invokes this on the `deltas_only` branch.
   */
  readonly deltasSince: (sinceSeq: bigint) => readonly DeltaInMem[];
}

// ---------------------------------------------------------------------------
// Decider
// ---------------------------------------------------------------------------

/**
 * Decide which `ResumeDecision` to apply for an Attach request. Pure;
 * deterministic in its inputs. No I/O, no awaits, no time.
 *
 * Branch order (matches spec §3.4 pseudo-code):
 *   1. `sinceSeq == 0n`  → snapshot_then_live
 *   2. `sinceSeq > currentMaxSeq` → refused_protocol_violation
 *   3. `sinceSeq < oldestRetainedSeq` → refused_too_far_behind
 *   4. otherwise → deltas_only
 *
 * Branch 2 and 3 ordering matters when `currentMaxSeq < oldestRetainedSeq`
 * is impossible (the emitter invariant is `oldestRetainedSeq <=
 * currentMaxSeq` whenever `currentMaxSeq > 0n`). When `currentMaxSeq ==
 * 0n` (no deltas yet, synthetic snapshot only), `oldestRetainedSeq ==
 * 0n` too: any `sinceSeq > 0n` falls into branch 2 (future-seq), which
 * is the right verdict — the client claims to have applied a delta the
 * daemon never produced.
 *
 * @throws Error if `sinceSeq == 0n` AND `currentSnapshot == null` —
 *   programming error: the sink must await the snapshot before invoking
 *   the decider on the first-snapshot race window (spec §3.3, see
 *   `ResumeDeciderInput.currentSnapshot` doc).
 *
 * @throws Error if `sinceSeq < 0n` — wire-impossible (proto u64) but
 *   guards against caller bugs in tests / future host-side caller code.
 */
export function decideAttachResume(input: ResumeDeciderInput): ResumeDecision {
  const { sinceSeq, currentMaxSeq, oldestRetainedSeq, currentSnapshot, deltasSince } = input;

  if (sinceSeq < 0n) {
    throw new Error(
      `decideAttachResume: sinceSeq must be >= 0n (got ${sinceSeq}); proto u64 cannot be negative`,
    );
  }

  // Branch 1: fresh attach. Send snapshot, then live deltas at baseSeq+1.
  if (sinceSeq === 0n) {
    if (currentSnapshot === null) {
      throw new Error(
        'decideAttachResume: currentSnapshot is null on sinceSeq=0n branch; ' +
          'the sink must await emitter.awaitSnapshot() before invoking the decider ' +
          '(see spec §3.3 first-snapshot race; ResumeDeciderInput.currentSnapshot doc)',
      );
    }
    return {
      kind: 'snapshot_then_live',
      snapshot: currentSnapshot,
      resumeSeq: currentSnapshot.baseSeq + 1n,
    };
  }

  // Branch 2: client claims a future seq. Protocol violation.
  if (sinceSeq > currentMaxSeq) {
    return {
      kind: 'refused_protocol_violation',
      reason: 'future-seq',
      sinceSeq,
      currentMaxSeq,
    };
  }

  // Branch 3: client too far behind retained window. Refuse loudly so
  // the renderer's stale-state bug surfaces (spec §3.2).
  if (sinceSeq < oldestRetainedSeq) {
    return {
      kind: 'refused_too_far_behind',
      reason: 'out-of-window',
      sinceSeq,
      oldestRetainedSeq,
    };
  }

  // Branch 4: happy path — deltas-only resume.
  // Note: `sinceSeq == currentMaxSeq` is valid here and yields an empty
  // `deltas` slice; the live subscription picks up at `currentMaxSeq + 1n`.
  // `deltasSince` returns the slice STRICTLY greater than `sinceSeq`.
  const deltas = deltasSince(sinceSeq);
  return {
    kind: 'deltas_only',
    deltas,
    resumeSeq: sinceSeq + 1n + BigInt(deltas.length),
  };
}
