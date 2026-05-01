// Tests for replay-burst exemption (T47, frag-3.5.1 §3.5.1.5 line 120, 165).
//
// Verifies the spec contract:
//   - 256 KB (or even 5 MB stress) replay write does NOT trip the 1 MiB
//     drop-slowest watermark while in replay-mode.
//   - exitReplay resets accounting; subsequent steady-state writes accrue
//     normally and DO trip at >1 MiB.
//   - Reverse-verify: WITHOUT enterReplay (i.e. plain dropSlowest.record),
//     a 5 MB write trips the watermark — proves the exemption is what's
//     suppressing the trip in the positive cases.

import { describe, expect, it } from 'vitest';

import {
  DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES,
  createDropSlowest,
} from '../drop-slowest.js';
import { createReplayBurstExemption } from '../replay-burst-exemption.js';

const KIB = 1024;
const MIB = 1024 * 1024;

describe('replay-burst-exemption: construction', () => {
  it('throws when dropSlowest is missing', () => {
    // @ts-expect-error - intentionally invalid
    expect(() => createReplayBurstExemption({})).toThrow(TypeError);
  });
});

describe('replay-burst-exemption: enter/exit lifecycle', () => {
  it('isInReplay reflects enter/exit', () => {
    const dropSlowest = createDropSlowest();
    const ex = createReplayBurstExemption({ dropSlowest });
    expect(ex.isInReplay('s')).toBe(false);
    ex.enterReplay('s');
    expect(ex.isInReplay('s')).toBe(true);
    ex.exitReplay('s');
    expect(ex.isInReplay('s')).toBe(false);
  });

  it('enterReplay is idempotent (second call returns a usable recorder)', () => {
    const dropSlowest = createDropSlowest();
    const ex = createReplayBurstExemption({ dropSlowest });
    const r1 = ex.enterReplay('s');
    const r2 = ex.enterReplay('s');
    r1(256 * KIB);
    r2(256 * KIB);
    // Both writes should be exempt — tally stays 0.
    expect(dropSlowest.pending('s')).toBe(0);
    expect(dropSlowest.getOverlimit()).toEqual([]);
  });

  it('exitReplay is idempotent (no-op when not in replay)', () => {
    const dropSlowest = createDropSlowest();
    const ex = createReplayBurstExemption({ dropSlowest });
    expect(() => ex.exitReplay('never-entered')).not.toThrow();
    ex.enterReplay('s');
    ex.exitReplay('s');
    expect(() => ex.exitReplay('s')).not.toThrow();
  });
});

describe('replay-burst-exemption: spec §3.5.1.5 line 120 — replay does not trip watermark', () => {
  it('256 KB replay write does not flag overlimit', () => {
    const dropSlowest = createDropSlowest();
    const ex = createReplayBurstExemption({ dropSlowest });
    const record = ex.enterReplay('s');
    record(256 * KIB);
    expect(dropSlowest.pending('s')).toBe(0);
    expect(dropSlowest.getOverlimit()).toEqual([]);
  });

  it('5 MB stress replay write does not flag overlimit while in replay-mode', () => {
    const dropSlowest = createDropSlowest();
    const ex = createReplayBurstExemption({ dropSlowest });
    const record = ex.enterReplay('s');
    // Five 1 MiB chunks — well past the 1 MiB watermark in steady state.
    for (let i = 0; i < 5; i += 1) {
      record(MIB);
    }
    expect(dropSlowest.pending('s')).toBe(0);
    expect(dropSlowest.getOverlimit()).toEqual([]);
  });
});

describe('replay-burst-exemption: spec line 165 — post-exit steady-state accumulates normally', () => {
  it('after exitReplay, normal writes accrue and trip at >1 MiB', () => {
    const dropSlowest = createDropSlowest();
    const ex = createReplayBurstExemption({ dropSlowest });
    const record = ex.enterReplay('s');
    record(5 * MIB); // huge replay burst, exempt
    expect(dropSlowest.pending('s')).toBe(0);
    ex.exitReplay('s');
    // Steady-state writes now go through the SAME recorder reference but
    // the lifecycle-contract says they record as non-exempt.
    record(DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES); // exactly 1 MiB
    expect(dropSlowest.pending('s')).toBe(DROP_SLOWEST_DEFAULT_THRESHOLD_BYTES);
    expect(dropSlowest.getOverlimit()).toEqual([]); // boundary, not over
    record(1); // strictly over
    expect(dropSlowest.getOverlimit()).toEqual(['s']);
  });

  it('exitReplay resets a tally that accrued from coincident steady-state writes', () => {
    // Simulate a steady-state write landing during the replay window via the
    // raw drop-slowest API (the exemption module is not the only writer in
    // the wiring — broadcasts can race the snapshot).
    const dropSlowest = createDropSlowest();
    const ex = createReplayBurstExemption({ dropSlowest });
    ex.enterReplay('s');
    // Coincident steady-state write straight through dropSlowest:
    dropSlowest.record('s', 900 * KIB);
    expect(dropSlowest.pending('s')).toBe(900 * KIB);
    // exitReplay collapses the tally — spec "watermark measured AFTER burst".
    ex.exitReplay('s');
    expect(dropSlowest.pending('s')).toBe(0);
    expect(dropSlowest.getOverlimit()).toEqual([]);
  });
});

describe('replay-burst-exemption: reverse-verify (proves exemption is load-bearing)', () => {
  it('WITHOUT enterReplay, a 5 MB write trips the watermark', () => {
    const dropSlowest = createDropSlowest();
    // No exemption module — directly exercise drop-slowest.
    dropSlowest.record('s', 5 * MIB);
    expect(dropSlowest.pending('s')).toBe(5 * MIB);
    expect(dropSlowest.getOverlimit()).toEqual(['s']);
  });

  it('WITHOUT enterReplay, exemption module records as non-exempt and trips watermark', () => {
    // Belt-and-braces: a recorder obtained then the sub exited — subsequent
    // writes should accrue normally (not silently exempt).
    const dropSlowest = createDropSlowest();
    const ex = createReplayBurstExemption({ dropSlowest });
    const record = ex.enterReplay('s');
    ex.exitReplay('s');
    record(5 * MIB);
    expect(dropSlowest.pending('s')).toBe(5 * MIB);
    expect(dropSlowest.getOverlimit()).toEqual(['s']);
  });
});

describe('replay-burst-exemption: per-subscriber isolation', () => {
  it('replay-mode on one sub does not exempt writes for another', () => {
    const dropSlowest = createDropSlowest();
    const ex = createReplayBurstExemption({ dropSlowest });
    const recA = ex.enterReplay('a');
    recA(5 * MIB); // exempt
    // Subscriber 'b' is NOT in replay-mode; raw write trips.
    dropSlowest.record('b', 5 * MIB);
    expect(dropSlowest.pending('a')).toBe(0);
    expect(dropSlowest.pending('b')).toBe(5 * MIB);
    expect(dropSlowest.getOverlimit()).toEqual(['b']);
  });
});
