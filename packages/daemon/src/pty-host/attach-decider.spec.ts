// Unit tests for the PtyService.Attach since_seq resume decider
// (spec docs/superpowers/specs/2026-05-04-pty-attach-handler.md §3).
//
// The decider is a pure function — these tests exercise every branch of
// §3.4's pseudo-code plus the edge cases that emerge from spec §3.3
// (synthetic initial snapshot at baseSeq=0n) and §4.5 (oldestRetained ==
// currentMax - N + 1n). No I/O, no async — fast (sub-ms) tests; the spec
// §9.1 T-PA-2 split exists precisely so this layer is unit-testable in
// isolation.

import { describe, expect, it } from 'vitest';

import {
  decideAttachResume,
  type DeltaInMem,
  type PtySnapshotInMem,
  type ResumeDeciderInput,
} from './attach-decider.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function snapshotAt(baseSeq: bigint): PtySnapshotInMem {
  return {
    baseSeq,
    geometry: { cols: 80, rows: 24 },
    // Distinct payload per baseSeq makes assertion failures readable.
    screenState: new Uint8Array([Number(baseSeq & 0xffn)]),
    schemaVersion: 1,
  };
}

function delta(seq: bigint): DeltaInMem {
  return {
    seq,
    tsUnixMs: 1_700_000_000_000n + seq,
    payload: new Uint8Array([Number(seq & 0xffn)]),
  };
}

/**
 * Build a `deltasSince` mock backed by an in-memory array. Returns the
 * slice with `seq > sinceSeq` AND `seq <= currentMaxSeq` (the same
 * contract the real `PtySessionEmitter.deltasSince` will honor per spec
 * §2.3). The mock asserts it is only invoked on the `deltas_only`
 * branch (i.e. with arguments inside the retained window) so a decider
 * regression that calls it from the wrong branch fails the test loudly.
 */
function mockDeltasSince(
  ring: readonly DeltaInMem[],
): { fn: (sinceSeq: bigint) => readonly DeltaInMem[]; calls: bigint[] } {
  const calls: bigint[] = [];
  return {
    fn: (sinceSeq: bigint) => {
      calls.push(sinceSeq);
      return ring.filter((d) => d.seq > sinceSeq);
    },
    calls,
  };
}

function baseInput(overrides: Partial<ResumeDeciderInput> = {}): ResumeDeciderInput {
  return {
    sinceSeq: 0n,
    currentMaxSeq: 0n,
    oldestRetainedSeq: 0n,
    currentSnapshot: snapshotAt(0n),
    deltasSince: () => [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Branch 1: snapshot_then_live (sinceSeq == 0n)
// ---------------------------------------------------------------------------

describe('decideAttachResume — branch 1: snapshot_then_live (sinceSeq == 0n)', () => {
  it('returns snapshot + resumeSeq = baseSeq + 1n on synthetic initial snapshot', () => {
    // Spec §3.3: fresh session right after `ready`, no deltas yet,
    // synthetic snapshot at baseSeq=0n.
    const snap = snapshotAt(0n);
    const verdict = decideAttachResume(
      baseInput({ sinceSeq: 0n, currentMaxSeq: 0n, currentSnapshot: snap }),
    );

    expect(verdict.kind).toBe('snapshot_then_live');
    if (verdict.kind !== 'snapshot_then_live') return; // type narrow
    expect(verdict.snapshot).toBe(snap);
    expect(verdict.resumeSeq).toBe(1n);
  });

  it('returns snapshot + resumeSeq = baseSeq + 1n on cadence-driven snapshot', () => {
    // Mid-session snapshot: cadence fired after some deltas; baseSeq = 257n
    // (spec ch06 §4 M_DELTAS=256 trigger fires at seq 257 conceptually).
    const snap = snapshotAt(257n);
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 0n,
        currentMaxSeq: 257n,
        oldestRetainedSeq: 1n,
        currentSnapshot: snap,
      }),
    );

    expect(verdict.kind).toBe('snapshot_then_live');
    if (verdict.kind !== 'snapshot_then_live') return;
    expect(verdict.snapshot).toBe(snap);
    expect(verdict.resumeSeq).toBe(258n);
  });

  it('does NOT call deltasSince on the snapshot branch', () => {
    // Pure-function discipline: the snapshot path must not pull deltas.
    const ds = mockDeltasSince([delta(1n), delta(2n)]);
    decideAttachResume(
      baseInput({
        sinceSeq: 0n,
        currentMaxSeq: 2n,
        oldestRetainedSeq: 1n,
        currentSnapshot: snapshotAt(2n),
        deltasSince: ds.fn,
      }),
    );
    expect(ds.calls).toEqual([]);
  });

  it('throws if currentSnapshot is null on sinceSeq=0n (programming error)', () => {
    // Spec §3.3 + ResumeDeciderInput.currentSnapshot doc: the sink must
    // await awaitSnapshot() before calling the decider on the first-
    // snapshot race. Calling with null is a contract violation.
    expect(() =>
      decideAttachResume(baseInput({ sinceSeq: 0n, currentSnapshot: null })),
    ).toThrow(/currentSnapshot is null/);
  });
});

// ---------------------------------------------------------------------------
// Branch 4: deltas_only (the happy "mid-window" path)
// ---------------------------------------------------------------------------

describe('decideAttachResume — branch 4: deltas_only (mid-window resume)', () => {
  it('replays the (sinceSeq, currentMaxSeq] slice and computes resumeSeq', () => {
    const ring: DeltaInMem[] = [delta(1n), delta(2n), delta(3n), delta(4n), delta(5n)];
    const ds = mockDeltasSince(ring);

    // Client has applied through seq=2; reattaching wants 3,4,5.
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 2n,
        currentMaxSeq: 5n,
        oldestRetainedSeq: 1n,
        currentSnapshot: snapshotAt(0n),
        deltasSince: ds.fn,
      }),
    );

    expect(verdict.kind).toBe('deltas_only');
    if (verdict.kind !== 'deltas_only') return;
    expect(verdict.deltas.map((d) => d.seq)).toEqual([3n, 4n, 5n]);
    // resumeSeq = sinceSeq + 1 + len(deltas) = 2 + 1 + 3 = 6.
    expect(verdict.resumeSeq).toBe(6n);
    expect(ds.calls).toEqual([2n]);
  });

  it('handles caught-up client (sinceSeq == currentMaxSeq) with empty slice', () => {
    // Renderer is fully caught up; deltas slice is empty; live subscription
    // picks up at currentMaxSeq + 1n. This is the steady-state reattach
    // shape after a brief blip.
    const ds = mockDeltasSince([delta(1n), delta(2n), delta(3n)]);
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 3n,
        currentMaxSeq: 3n,
        oldestRetainedSeq: 1n,
        currentSnapshot: snapshotAt(0n),
        deltasSince: ds.fn,
      }),
    );

    expect(verdict.kind).toBe('deltas_only');
    if (verdict.kind !== 'deltas_only') return;
    expect(verdict.deltas).toEqual([]);
    expect(verdict.resumeSeq).toBe(4n);
  });

  it('handles sinceSeq exactly at oldestRetainedSeq (window boundary inclusive)', () => {
    // Spec §3.1.2: the lower bound is INCLUSIVE — sinceSeq ==
    // oldestRetainedSeq is in-window. (deltasSince still returns the
    // strictly-greater slice, so a client that has applied EXACTLY
    // through oldestRetainedSeq receives oldestRetainedSeq+1 onwards.)
    const ring: DeltaInMem[] = [delta(10n), delta(11n), delta(12n)];
    const ds = mockDeltasSince(ring);
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 10n,
        currentMaxSeq: 12n,
        oldestRetainedSeq: 10n,
        currentSnapshot: snapshotAt(9n),
        deltasSince: ds.fn,
      }),
    );

    expect(verdict.kind).toBe('deltas_only');
    if (verdict.kind !== 'deltas_only') return;
    expect(verdict.deltas.map((d) => d.seq)).toEqual([11n, 12n]);
    expect(verdict.resumeSeq).toBe(13n);
  });
});

// ---------------------------------------------------------------------------
// Branch 3: refused_too_far_behind (sinceSeq < oldestRetainedSeq)
// ---------------------------------------------------------------------------

describe('decideAttachResume — branch 3: refused_too_far_behind', () => {
  it('refuses when sinceSeq is one below oldestRetainedSeq', () => {
    // Tightest off-window case — oldestRetainedSeq=10, client at 9.
    // Spec §3.2: refuse loudly with structured ConnectError so the
    // renderer instruments the lag (silently re-snapshotting would
    // mask the bug).
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 9n,
        currentMaxSeq: 12n,
        oldestRetainedSeq: 10n,
        currentSnapshot: snapshotAt(9n),
      }),
    );

    expect(verdict).toEqual({
      kind: 'refused_too_far_behind',
      reason: 'out-of-window',
      sinceSeq: 9n,
      oldestRetainedSeq: 10n,
    });
  });

  it('refuses when sinceSeq is far below oldestRetainedSeq (ring rolled over)', () => {
    // Spec §8.4 acceptance: client disconnects, daemon emits >4096
    // deltas, oldestRetainedSeq advances; reattach with stale seq.
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 1n,
        currentMaxSeq: 5000n,
        oldestRetainedSeq: 905n, // 5000 - 4096 + 1
        currentSnapshot: snapshotAt(4900n),
      }),
    );

    expect(verdict.kind).toBe('refused_too_far_behind');
    if (verdict.kind !== 'refused_too_far_behind') return;
    expect(verdict.sinceSeq).toBe(1n);
    expect(verdict.oldestRetainedSeq).toBe(905n);
  });

  it('does NOT call deltasSince on the refused branch', () => {
    const ds = mockDeltasSince([delta(10n), delta(11n)]);
    decideAttachResume(
      baseInput({
        sinceSeq: 5n,
        currentMaxSeq: 11n,
        oldestRetainedSeq: 10n,
        currentSnapshot: snapshotAt(9n),
        deltasSince: ds.fn,
      }),
    );
    expect(ds.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Branch 2: refused_protocol_violation (sinceSeq > currentMaxSeq)
// ---------------------------------------------------------------------------

describe('decideAttachResume — branch 2: refused_protocol_violation (future-seq)', () => {
  it('refuses when sinceSeq exceeds currentMaxSeq by 1', () => {
    // Tightest off-by-one — client claims to have applied seq=11 when
    // daemon has only emitted through seq=10. Spec §3.4: surfaces the
    // renderer's `lastAppliedSeq` accounting bug loudly.
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 11n,
        currentMaxSeq: 10n,
        oldestRetainedSeq: 1n,
        currentSnapshot: snapshotAt(10n),
      }),
    );

    expect(verdict).toEqual({
      kind: 'refused_protocol_violation',
      reason: 'future-seq',
      sinceSeq: 11n,
      currentMaxSeq: 10n,
    });
  });

  it('refuses sinceSeq>0n on a freshly created session (currentMaxSeq == 0n)', () => {
    // Edge: synthetic snapshot only, no deltas yet (currentMaxSeq=0n,
    // oldestRetainedSeq=0n). A client sending sinceSeq>0n is buggy —
    // there is nothing to resume from. This must hit branch 2
    // (future-seq), NOT branch 3, because the seq it claims is impossible.
    // Branch ordering in the decider (branch 2 before branch 3) ensures
    // this verdict.
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 1n,
        currentMaxSeq: 0n,
        oldestRetainedSeq: 0n,
        currentSnapshot: snapshotAt(0n),
      }),
    );

    expect(verdict.kind).toBe('refused_protocol_violation');
    if (verdict.kind !== 'refused_protocol_violation') return;
    expect(verdict.sinceSeq).toBe(1n);
    expect(verdict.currentMaxSeq).toBe(0n);
  });

  it('does NOT call deltasSince on the refused branch', () => {
    const ds = mockDeltasSince([]);
    decideAttachResume(
      baseInput({
        sinceSeq: 99n,
        currentMaxSeq: 10n,
        oldestRetainedSeq: 1n,
        currentSnapshot: snapshotAt(10n),
        deltasSince: ds.fn,
      }),
    );
    expect(ds.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('decideAttachResume — input validation', () => {
  it('throws on negative sinceSeq (proto u64 cannot be negative)', () => {
    expect(() => decideAttachResume(baseInput({ sinceSeq: -1n }))).toThrow(
      /sinceSeq must be >= 0n/,
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism: pure function — same input → same output
// ---------------------------------------------------------------------------

describe('decideAttachResume — determinism', () => {
  it('returns structurally equal verdicts on repeated calls with same input', () => {
    const ring: DeltaInMem[] = [delta(1n), delta(2n), delta(3n)];
    const input: ResumeDeciderInput = {
      sinceSeq: 1n,
      currentMaxSeq: 3n,
      oldestRetainedSeq: 1n,
      currentSnapshot: snapshotAt(0n),
      deltasSince: (s) => ring.filter((d) => d.seq > s),
    };

    const a = decideAttachResume(input);
    const b = decideAttachResume(input);

    expect(a).toEqual(b);
    expect(a.kind).toBe('deltas_only');
  });
});

// ---------------------------------------------------------------------------
// Extended edge coverage — Task #353 (T-PA-IMPL.4):
// the existing 15 UTs above cover every spec §3.4 branch; the cases below
// pin behaviors that future refactors could silently regress (branch
// ordering, bigint arithmetic at u64-scale, deltasSince argument contract,
// retention-window boundary collisions).
// ---------------------------------------------------------------------------

describe('decideAttachResume — branch ordering invariants', () => {
  it('checks negative sinceSeq BEFORE null-snapshot programming-error guard', () => {
    // Both checks throw, but the negative guard must fire first so a
    // bug-report stack trace points at the caller's wire-decoding bug
    // rather than the (downstream, unrelated) snapshot-race assertion.
    expect(() =>
      decideAttachResume(baseInput({ sinceSeq: -1n, currentSnapshot: null })),
    ).toThrow(/sinceSeq must be >= 0n/);
  });

  it('checks sinceSeq=0n snapshot branch BEFORE future-seq branch', () => {
    // currentMaxSeq=0n + sinceSeq=0n is the cold-start shape: must hit
    // branch 1 (snapshot_then_live), NOT branch 2 (future-seq), even
    // though `0n > 0n` is false, the branch ordering is still load-
    // bearing for the symmetric case where the `>` becomes `>=` in a
    // refactor. Pin it.
    const snap = snapshotAt(0n);
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 0n,
        currentMaxSeq: 0n,
        oldestRetainedSeq: 0n,
        currentSnapshot: snap,
      }),
    );
    expect(verdict.kind).toBe('snapshot_then_live');
  });

  it('checks future-seq branch BEFORE too-far-behind branch', () => {
    // Pathological emitter state where currentMaxSeq < oldestRetainedSeq
    // is supposed to be impossible per the emitter invariant, but the
    // decider must still route deterministically: spec §3.4 branch order
    // says future-seq wins. Without the explicit ordering test, a future
    // refactor that swaps the two `if` blocks would silently change the
    // verdict for genuine wire-bug clients.
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 100n,
        currentMaxSeq: 50n,
        oldestRetainedSeq: 200n,
        currentSnapshot: snapshotAt(50n),
      }),
    );
    expect(verdict.kind).toBe('refused_protocol_violation');
  });
});

describe('decideAttachResume — bigint arithmetic at u64 scale', () => {
  it('handles sinceSeq near 2^63 without precision loss', () => {
    // Proto u64 fits in bigint losslessly; verify the resumeSeq math
    // (`sinceSeq + 1n + len`) doesn't drop bits via accidental Number
    // coercion. 2^63 - 1 is the largest signed i64; the unsigned u64
    // domain is twice that, but 2^63 is plenty to surface a Number cast.
    const big = 1n << 62n; // 2^62 = 4_611_686_018_427_387_904
    const ring: DeltaInMem[] = [delta(big + 1n), delta(big + 2n)];
    const ds = mockDeltasSince(ring);
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: big,
        currentMaxSeq: big + 2n,
        oldestRetainedSeq: big - 4095n,
        currentSnapshot: snapshotAt(big),
        deltasSince: ds.fn,
      }),
    );
    expect(verdict.kind).toBe('deltas_only');
    if (verdict.kind !== 'deltas_only') return;
    expect(verdict.deltas.map((d) => d.seq)).toEqual([big + 1n, big + 2n]);
    // Critical: the resumeSeq must equal big + 3n with NO precision loss.
    expect(verdict.resumeSeq).toBe(big + 3n);
  });

  it('handles snapshot baseSeq near 2^62 in the snapshot branch', () => {
    const big = 1n << 62n;
    const snap = snapshotAt(big);
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 0n,
        currentMaxSeq: big,
        oldestRetainedSeq: big - 4095n,
        currentSnapshot: snap,
      }),
    );
    expect(verdict.kind).toBe('snapshot_then_live');
    if (verdict.kind !== 'snapshot_then_live') return;
    expect(verdict.resumeSeq).toBe(big + 1n);
  });
});

describe('decideAttachResume — deltasSince argument contract', () => {
  it('passes the original sinceSeq (NOT oldestRetainedSeq) to deltasSince', () => {
    // The decider must hand `deltasSince` the client-supplied sinceSeq
    // verbatim — the emitter implementation is what filters by the ring
    // window. A regression that passed `oldestRetainedSeq` instead would
    // over-replay deltas the client already applied.
    const ds = mockDeltasSince([delta(5n), delta(6n), delta(7n)]);
    decideAttachResume(
      baseInput({
        sinceSeq: 6n,
        currentMaxSeq: 7n,
        oldestRetainedSeq: 1n,
        currentSnapshot: snapshotAt(4n),
        deltasSince: ds.fn,
      }),
    );
    expect(ds.calls).toEqual([6n]);
  });

  it('invokes deltasSince exactly once per call (no double-pull)', () => {
    const ds = mockDeltasSince([delta(2n), delta(3n)]);
    decideAttachResume(
      baseInput({
        sinceSeq: 1n,
        currentMaxSeq: 3n,
        oldestRetainedSeq: 1n,
        currentSnapshot: snapshotAt(0n),
        deltasSince: ds.fn,
      }),
    );
    expect(ds.calls).toHaveLength(1);
  });

  it('forwards an empty deltas slice unchanged when none returned', () => {
    // `sinceSeq == currentMaxSeq` is the steady-state caught-up shape;
    // deltasSince returns []; the verdict must carry the empty array
    // (not undefined / not throw / not coerce to snapshot).
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 10n,
        currentMaxSeq: 10n,
        oldestRetainedSeq: 1n,
        currentSnapshot: snapshotAt(0n),
        deltasSince: () => [],
      }),
    );
    expect(verdict.kind).toBe('deltas_only');
    if (verdict.kind !== 'deltas_only') return;
    expect(verdict.deltas).toEqual([]);
    expect(verdict.resumeSeq).toBe(11n);
  });
});

describe('decideAttachResume — single-delta retention window', () => {
  it('handles oldestRetainedSeq == currentMaxSeq (only one delta in ring)', () => {
    // Edge: emitter has emitted exactly one delta; ring contains only
    // seq=1n; oldestRetainedSeq == currentMaxSeq == 1n. Client at
    // sinceSeq=1n must yield deltas_only with empty slice (caught up);
    // client at sinceSeq=0n hits the snapshot branch (covered above);
    // client at sinceSeq=2n hits future-seq.
    const ds = mockDeltasSince([delta(1n)]);
    const verdict = decideAttachResume(
      baseInput({
        sinceSeq: 1n,
        currentMaxSeq: 1n,
        oldestRetainedSeq: 1n,
        currentSnapshot: snapshotAt(0n),
        deltasSince: ds.fn,
      }),
    );
    expect(verdict.kind).toBe('deltas_only');
    if (verdict.kind !== 'deltas_only') return;
    expect(verdict.deltas).toEqual([]);
    expect(verdict.resumeSeq).toBe(2n);
  });
});
