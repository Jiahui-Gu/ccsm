// Post-restart pty-host replay decider — pure function (no I/O).
//
// Spec ref: design ch06 §7 ("Daemon restart replay") + ch05 §7
// (restore flow). When the daemon process restarts, every session row
// with `state IN (STARTING, RUNNING)` MUST be brought back to its
// in-memory state by:
//
//   1. Reading the most recent `pty_snapshot` row for the session
//      (highest `base_seq`).
//   2. Reading every `pty_delta` row with `seq > snapshot.base_seq`,
//      in monotonically-ascending seq order.
//   3. Applying that snapshot then those deltas, in order, into the
//      restored pty-host's xterm-headless Terminal so its in-memory
//      state matches what the previous daemon process had at the
//      moment it died.
//   4. After replay, the new pty-host begins emitting fresh deltas
//      with `seq = lastReplayedSeq + 1n` so the per-session monotonic
//      seq invariant from spec §2.1 holds across the restart boundary
//      (subscribers reattaching with `since_seq = lastAppliedSeq`
//      resume seamlessly via the existing T-PA-2 attach decider).
//
// SRP layering — this module is a `decider` per dev.md §2: pure
// function `(snapshotRow, deltaRows) -> RestoreReplayPlan`. No
// reading, no writing, no awaiting. The caller (`host.ts` on child
// 'ready') is the sink that:
//
//   - Reads `latestSnapshotRow` + `postSnapDeltaRows` from the
//     `SnapshotStore` (`storage/snapshot-store.ts`).
//   - Calls {@link decideRestoreReplay} to validate + plan.
//   - Applies the plan against the per-session `PtySessionEmitter`
//     (publishes the hydrated snapshot then each delta in order) so
//     subscribers attaching after the restart see the same in-memory
//     state the previous daemon process had.
//
// Mirrors `attach-decider.ts` (same shape: pure function returning a
// discriminated union; sink translates verdicts into action). Two
// copies of the pattern are clearer than a shared abstraction (each
// decider's verdict shape is concern-specific).
//
// Layer 1 — alternatives checked:
//   - Embed the replay logic inline in `host.ts`. Rejected: spec ch06
//     §7 + ch05 §7 dictate the restore *order* and the seq-anchor
//     math; pulling them out as a pure function makes the order
//     independently unit-testable without spinning up a pty-host
//     child / SQLite. The same pattern is already used by
//     `attach-decider.ts` (T-PA-2) for the live-attach decision tree.
//   - Make this a class with state. Rejected: decider per dev.md §2
//     SRP MUST be stateless; persistence belongs to the SQLite layer
//     (snapshot-store.ts), not the decider.
//
// Forever-stable invariants this decider locks:
//   - Snapshot is the *most recent* (highest base_seq) for the
//     session — older snapshots are stale and the SnapshotStore
//     resolver MUST already have filtered them out.
//   - Deltas are strictly monotonic and contiguous from
//     `baseSeq + 1n`. A gap is a SQLite corruption / pruning bug;
//     the decider returns a `corrupt_seq_gap` verdict so the sink
//     can crash_log + degrade gracefully (replay the snapshot
//     alone — the spec §2.4 "snapshot is forever-recoverable on its
//     own" property still holds).
//   - When no snapshot exists for the session (first boot, or a
//     session that crashed before its first snapshot fired), the
//     verdict is `no_prior_state` — the sink lets the new pty-host
//     child emit its own synthetic baseSeq=0 snapshot per spec §3.3
//     (no hydration needed; this is the cold-start fast path).

import type { DeltaInMem, PtySnapshotInMem } from './attach-decider.js';

// ---------------------------------------------------------------------------
// Inputs the decider reads. Mirror the SQLite row shape from
// `db/migrations/001_initial.sql` for `pty_snapshot` and `pty_delta`
// (chapter 06 §3 / §4) but use `bigint` for seq to match the
// in-memory shapes the emitter publishes. The SQLite reader
// (`storage/snapshot-store.ts`) is responsible for converting the
// `INTEGER` SQLite columns to `bigint` here.
// ---------------------------------------------------------------------------

/**
 * The single most-recent `pty_snapshot` row for a session, as read
 * by `SnapshotStore.getLatestSnapshot`. The `payload` blob is the
 * SnapshotV1 wire bytes (spec ch06 §2 — opaque to this layer; the
 * future T4.6 child-side wiring will pass it to
 * `decodeSnapshotV1` from `@ccsm/snapshot-codec`).
 */
export interface RestoreSnapshotRow {
  readonly baseSeq: bigint;
  readonly schemaVersion: number;
  readonly geometry: { readonly cols: number; readonly rows: number };
  readonly payload: Uint8Array;
  readonly createdMs: number;
}

/**
 * A single `pty_delta` row, ordered by ascending `seq`. The reader is
 * responsible for ORDERing — the decider trusts the input order and
 * cross-checks the monotonicity invariant.
 */
export interface RestoreDeltaRow {
  readonly seq: bigint;
  readonly tsUnixMs: bigint;
  readonly payload: Uint8Array;
}

// ---------------------------------------------------------------------------
// Decider verdict — discriminated union; sink translates each variant
// into the matching emitter call sequence.
// ---------------------------------------------------------------------------

/**
 * The plan returned when prior state exists and is consistent. The
 * sink applies this exactly as: publish `snapshot` first, then publish
 * each entry of `deltas` in order, then arm the per-session seq
 * counter at `nextEmitSeq` for fresh live output.
 *
 * `nextEmitSeq` equals `(lastReplayedSeq + 1n)` where `lastReplayedSeq`
 * is the seq of the last delta replayed (or `baseSeq` when there are
 * no post-snapshot deltas). Spec §2.1 ("monotonically-increasing per
 * session, never reused") is preserved across restart by anchoring
 * the new child's accumulator at this value.
 */
export interface RestorePlanHydrate {
  readonly kind: 'hydrate';
  readonly snapshot: PtySnapshotInMem;
  readonly deltas: readonly DeltaInMem[];
  readonly lastReplayedSeq: bigint;
  readonly nextEmitSeq: bigint;
}

/**
 * Cold-start verdict — no `pty_snapshot` row exists for the session.
 * The sink lets the new child emit its own synthetic baseSeq=0
 * snapshot per spec §3.3 (no hydration needed). `nextEmitSeq` is
 * `1n` so the first live delta carries `seq = 1n`, matching the
 * cold-spawn behavior of `DeltaAccumulator` (firstSeq defaults to 1).
 */
export interface RestorePlanColdStart {
  readonly kind: 'no_prior_state';
  readonly nextEmitSeq: bigint;
}

/**
 * Corrupt-input verdict — the post-snapshot delta sequence has a gap
 * or out-of-order entry. The sink should:
 *   - log a `crash_log` row with `source = 'pty_replay_seq_gap'` so
 *     ops can investigate the SQLite corruption;
 *   - fall back to publishing the snapshot alone (which is recoverable
 *     on its own per spec §2.4) and arming `nextEmitSeq = baseSeq + 1n`.
 * The `firstBadSeq` field carries the seq the decider expected but
 * did not see (`previousSeq + 1n`); `actualSeq` is what it found.
 */
export interface RestorePlanCorrupt {
  readonly kind: 'corrupt_seq_gap';
  readonly snapshot: PtySnapshotInMem;
  readonly expectedSeq: bigint;
  readonly actualSeq: bigint;
  readonly nextEmitSeq: bigint;
}

export type RestoreReplayPlan =
  | RestorePlanHydrate
  | RestorePlanColdStart
  | RestorePlanCorrupt;

// ---------------------------------------------------------------------------
// Inputs accepted by the decider. Pure values only — the sink
// resolves `latestSnapshot` / `postSnapDeltas` from the SnapshotStore
// before calling.
// ---------------------------------------------------------------------------

export interface RestoreReplayInputs {
  /**
   * The most-recent snapshot row, or `null` if none exists for this
   * session (cold start). The store MUST return at most one row —
   * the one with the highest `base_seq` for the session.
   */
  readonly latestSnapshot: RestoreSnapshotRow | null;
  /**
   * Every delta row with `seq > latestSnapshot.base_seq`, in
   * ascending `seq` order. Empty when `latestSnapshot` is null OR
   * when no deltas were captured between the snapshot and the daemon
   * crash.
   */
  readonly postSnapDeltas: readonly RestoreDeltaRow[];
}

// ---------------------------------------------------------------------------
// The decider.
// ---------------------------------------------------------------------------

/**
 * Decide the post-restart replay plan from the SQLite-resolved inputs.
 *
 * Pure function. No I/O, no awaits, no side effects. Safe to call
 * from any context (host wire-up, unit test, future v0.4 admin RPC
 * that re-issues replay on demand).
 */
export function decideRestoreReplay(
  inputs: RestoreReplayInputs,
): RestoreReplayPlan {
  const { latestSnapshot, postSnapDeltas } = inputs;

  // Cold start: no snapshot ever captured for this session. The
  // synthetic baseSeq=0 snapshot the new child emits on `'ready'`
  // covers the empty-buffer case per spec §3.3; nothing to hydrate.
  // Any postSnapDeltas in this branch are a programmer error in the
  // store layer (deltas without a snapshot are always pruned by the
  // coalescer per spec ch06 §4) — we ignore them and treat as cold.
  if (latestSnapshot === null) {
    return { kind: 'no_prior_state', nextEmitSeq: 1n };
  }

  // Materialize the in-memory snapshot record the emitter expects.
  // Field-by-field copy (not spread) so the verdict is independent
  // of any future SQLite row-shape additions (extra columns won't
  // leak into the in-mem record).
  const snapshot: PtySnapshotInMem = {
    baseSeq: latestSnapshot.baseSeq,
    geometry: {
      cols: latestSnapshot.geometry.cols,
      rows: latestSnapshot.geometry.rows,
    },
    screenState: latestSnapshot.payload,
    schemaVersion: latestSnapshot.schemaVersion,
  };

  // Validate strict monotonicity + contiguity of the post-snap
  // deltas against `snapshot.baseSeq`. Spec §2.1: deltas are
  // "monotonically-increasing per session, never reused, never
  // gapped". A gap survives across restart only if the SQLite
  // pruner mis-ordered with the snapshot writer — a real bug, but
  // one we can recover from (snapshot alone is byte-equivalent to
  // the screen state at base_seq per spec §2.4).
  const deltas: DeltaInMem[] = [];
  let expectedSeq = latestSnapshot.baseSeq + 1n;
  for (const row of postSnapDeltas) {
    if (row.seq !== expectedSeq) {
      // First gap or out-of-order seq — degrade gracefully. We DO
      // NOT include the deltas already collected (publishing a
      // partial sequence then jumping to a fresh seq counter would
      // confuse the renderer's xterm.write replay; better to start
      // fresh from snapshot alone).
      return {
        kind: 'corrupt_seq_gap',
        snapshot,
        expectedSeq,
        actualSeq: row.seq,
        nextEmitSeq: latestSnapshot.baseSeq + 1n,
      };
    }
    deltas.push({
      seq: row.seq,
      tsUnixMs: row.tsUnixMs,
      payload: row.payload,
    });
    expectedSeq = row.seq + 1n;
  }

  // `lastReplayedSeq` is the seq of the last delta we hand back, or
  // the snapshot's baseSeq if there were no post-snap deltas. The
  // new pty-host child's accumulator MUST start at
  // `lastReplayedSeq + 1n` so the per-session monotonic invariant
  // holds across the restart boundary.
  const lastReplayedSeq =
    deltas.length > 0
      ? deltas[deltas.length - 1]!.seq
      : latestSnapshot.baseSeq;

  return {
    kind: 'hydrate',
    snapshot,
    deltas,
    lastReplayedSeq,
    nextEmitSeq: lastReplayedSeq + 1n,
  };
}
