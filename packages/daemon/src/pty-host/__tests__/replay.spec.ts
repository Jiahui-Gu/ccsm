// Unit tests for the post-restart pty-host replay decider (T4.14 / Task #51).
//
// The decider in `../replay.ts` is a pure function — these tests drive
// it with hand-rolled `RestoreSnapshotRow` / `RestoreDeltaRow` fixtures
// and assert each verdict variant. No SQLite, no pty-host child, no
// IPC — the decider is the entire decision surface.

import { describe, expect, it } from 'vitest';

import {
  decideRestoreReplay,
  type RestoreDeltaRow,
  type RestoreSnapshotRow,
} from '../replay.js';

const SCREEN_BYTES = new Uint8Array([0xc5, 0x53, 0x53, 0x31, 0x01]); // "CSS1"+codec
const DELTA_PAYLOAD = (n: number): Uint8Array =>
  new Uint8Array([0x1b, 0x5b, n]); // ESC[ + n

function snap(baseSeq: bigint, cols = 80, rows = 24): RestoreSnapshotRow {
  return {
    baseSeq,
    schemaVersion: 1,
    geometry: { cols, rows },
    payload: SCREEN_BYTES,
    createdMs: 1_700_000_000_000,
  };
}

function delta(seq: bigint, byte = 0x41): RestoreDeltaRow {
  return {
    seq,
    tsUnixMs: 1_700_000_001_000n + seq,
    payload: DELTA_PAYLOAD(byte),
  };
}

describe('replay.decideRestoreReplay', () => {
  it('cold start: returns no_prior_state when latestSnapshot is null', () => {
    const plan = decideRestoreReplay({
      latestSnapshot: null,
      postSnapDeltas: [],
    });
    expect(plan.kind).toBe('no_prior_state');
    if (plan.kind === 'no_prior_state') {
      expect(plan.nextEmitSeq).toBe(1n);
    }
  });

  it('cold start: ignores stray deltas when no snapshot exists', () => {
    // Defensive: postSnapDeltas without a snapshot is a store-layer bug
    // (deltas are pruned by the coalescer when no snapshot anchors
    // them per spec ch06 §4). The decider should NOT crash; it should
    // treat the input as cold-start.
    const plan = decideRestoreReplay({
      latestSnapshot: null,
      postSnapDeltas: [delta(1n)],
    });
    expect(plan.kind).toBe('no_prior_state');
  });

  it('hydrate (snapshot only): zero post-snap deltas', () => {
    const snapshot = snap(42n);
    const plan = decideRestoreReplay({
      latestSnapshot: snapshot,
      postSnapDeltas: [],
    });
    expect(plan.kind).toBe('hydrate');
    if (plan.kind !== 'hydrate') return;
    expect(plan.snapshot.baseSeq).toBe(42n);
    expect(plan.snapshot.geometry).toEqual({ cols: 80, rows: 24 });
    expect(plan.snapshot.screenState).toBe(SCREEN_BYTES);
    expect(plan.snapshot.schemaVersion).toBe(1);
    expect(plan.deltas.length).toBe(0);
    // No deltas → lastReplayedSeq is the snapshot's baseSeq.
    expect(plan.lastReplayedSeq).toBe(42n);
    expect(plan.nextEmitSeq).toBe(43n);
  });

  it('hydrate (snapshot + contiguous deltas): publishes plan in seq order', () => {
    const snapshot = snap(10n, 120, 40);
    const plan = decideRestoreReplay({
      latestSnapshot: snapshot,
      postSnapDeltas: [delta(11n, 0x41), delta(12n, 0x42), delta(13n, 0x43)],
    });
    expect(plan.kind).toBe('hydrate');
    if (plan.kind !== 'hydrate') return;
    expect(plan.deltas.map((d) => d.seq)).toEqual([11n, 12n, 13n]);
    expect(plan.deltas.map((d) => d.payload[2])).toEqual([0x41, 0x42, 0x43]);
    expect(plan.snapshot.geometry).toEqual({ cols: 120, rows: 40 });
    expect(plan.lastReplayedSeq).toBe(13n);
    expect(plan.nextEmitSeq).toBe(14n);
  });

  it('hydrate: passes the geometry from the snapshot row through unchanged', () => {
    // The geometry MUST come from the snapshot (it represents the
    // PTY size at capture time), not from any delta — deltas don't
    // carry geometry per spec ch06 §3.
    const plan = decideRestoreReplay({
      latestSnapshot: snap(5n, 200, 60),
      postSnapDeltas: [delta(6n)],
    });
    expect(plan.kind).toBe('hydrate');
    if (plan.kind !== 'hydrate') return;
    expect(plan.snapshot.geometry).toEqual({ cols: 200, rows: 60 });
  });

  it('corrupt_seq_gap: detects a missing seq', () => {
    const snapshot = snap(100n);
    // Expected 101, 102, 103 — missing 102 (jump to 103).
    const plan = decideRestoreReplay({
      latestSnapshot: snapshot,
      postSnapDeltas: [delta(101n), delta(103n)],
    });
    expect(plan.kind).toBe('corrupt_seq_gap');
    if (plan.kind !== 'corrupt_seq_gap') return;
    expect(plan.expectedSeq).toBe(102n);
    expect(plan.actualSeq).toBe(103n);
    expect(plan.snapshot.baseSeq).toBe(100n);
    // Snapshot-only fallback: nextEmitSeq is baseSeq + 1, NOT past the
    // partial run of valid deltas (publishing those would have been
    // partial-state hydration which the decider rejects per replay.ts
    // jsdoc).
    expect(plan.nextEmitSeq).toBe(101n);
  });

  it('corrupt_seq_gap: detects out-of-order seq', () => {
    const snapshot = snap(50n);
    // Expected 51, 52, 53 — got 51 then 53 then 52 (re-ordering).
    const plan = decideRestoreReplay({
      latestSnapshot: snapshot,
      postSnapDeltas: [delta(51n), delta(53n), delta(52n)],
    });
    expect(plan.kind).toBe('corrupt_seq_gap');
    if (plan.kind !== 'corrupt_seq_gap') return;
    expect(plan.expectedSeq).toBe(52n);
    expect(plan.actualSeq).toBe(53n);
  });

  it('corrupt_seq_gap: detects a delta whose seq does not advance from baseSeq+1', () => {
    // The first post-snap delta MUST be baseSeq+1; if the store hands
    // us baseSeq+5 as the first row (older deltas pruned mid-flight),
    // that's a corruption verdict, not a partial-replay opportunity.
    const snapshot = snap(7n);
    const plan = decideRestoreReplay({
      latestSnapshot: snapshot,
      postSnapDeltas: [delta(12n)],
    });
    expect(plan.kind).toBe('corrupt_seq_gap');
    if (plan.kind !== 'corrupt_seq_gap') return;
    expect(plan.expectedSeq).toBe(8n);
    expect(plan.actualSeq).toBe(12n);
    expect(plan.nextEmitSeq).toBe(8n);
  });

  it('hydrate: handles a snapshot with baseSeq=0n (synthetic captured before any deltas)', () => {
    // Spec §3.3: the synthetic initial snapshot uses baseSeq=0n.
    // If the daemon crashed AFTER the synthetic was persisted but
    // BEFORE any real deltas, the replay path should hydrate the
    // empty buffer — which is byte-identical to a cold-start child's
    // own synthetic, but the seq anchor is still 0n+1n.
    const plan = decideRestoreReplay({
      latestSnapshot: snap(0n),
      postSnapDeltas: [],
    });
    expect(plan.kind).toBe('hydrate');
    if (plan.kind !== 'hydrate') return;
    expect(plan.lastReplayedSeq).toBe(0n);
    expect(plan.nextEmitSeq).toBe(1n);
  });

  it('hydrate: bigint seq math holds at large values (regression on Number coercion)', () => {
    // The decider uses bigint everywhere; this asserts no accidental
    // Number() coercion narrows precision past 2^53.
    const big = 9_007_199_254_740_993n; // 2^53 + 1, unrepresentable as Number
    const plan = decideRestoreReplay({
      latestSnapshot: snap(big),
      postSnapDeltas: [delta(big + 1n), delta(big + 2n)],
    });
    expect(plan.kind).toBe('hydrate');
    if (plan.kind !== 'hydrate') return;
    expect(plan.lastReplayedSeq).toBe(big + 2n);
    expect(plan.nextEmitSeq).toBe(big + 3n);
  });
});
