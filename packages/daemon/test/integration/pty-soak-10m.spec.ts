// packages/daemon/test/integration/pty-soak-10m.spec.ts
//
// Phase-5 smoke variant of the 1-hour ship-gate (c) soak. Per
// docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md chapter 13
// phase 5 done-when:
//
//   "pty-attach-stream + pty-reattach + pty-too-far-behind integration
//    tests green AND a 10-minute soak smoke (`pty-soak-10m.spec.ts`,
//    scaled-down variant of ship-gate (c)) green on all 3 OSes. The full
//    1-hour soak ship-gate (c) runs in phase 11."
//
// This file rides the same shared driver as the 1h variant (single source
// of truth for invariants) so behaviour drift between the two is
// mechanically impossible. The 10m smoke runs per-PR on `{ubuntu, macos,
// windows}`; the 1h variant runs nightly.
//
// Same skip semantics as the 1h variant: until T4.1 / T4.6 / T4.10 land
// the entire suite auto-skips via `describe.skipIf`.

import { describe, expect, it } from 'vitest';

import {
  SOAK_DURATION_10M_MS,
  dependenciesPresent,
  loadSoakDriver,
} from './pty-soak-shared.js';

const probe = dependenciesPresent();

describe.skipIf(!probe.ready)('pty-soak-10m (phase-5 smoke variant)', () => {
  // 5-minute slack on top of the soak window for boot + final byte-equality.
  const TIMEOUT_MS = SOAK_DURATION_10M_MS + 5 * 60 * 1000;

  it(
    'runs 10 minutes against claude-sim and meets the same gate-(c) invariants',
    async () => {
      const driver = await loadSoakDriver();
      const result = await driver.runSoak({ durationMs: SOAK_DURATION_10M_MS });
      driver.assertSoakInvariants(result, { durationMs: SOAK_DURATION_10M_MS });
      // Re-state load-bearing assertions (mirrors pty-soak-1h.spec.ts so a
      // weakening of either driver-side or shared invariants is caught here
      // too, not only in the nightly).
      expect(result.daemonSnapshotBytes.length).toBeGreaterThan(0);
      expect(Buffer.compare(result.daemonSnapshotBytes, result.clientSnapshotBytes)).toBe(0);
      expect(result.sendInputP99Ms).toBeLessThan(5);
      expect(result.memoryFinalMib - result.memoryBaselineMib).toBeLessThanOrEqual(256);
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(probe.ready)('pty-soak-10m (skipped — pending dependencies)', () => {
  it('reports gating reason', () => {
    expect(probe.reason).toMatch(/T4\./);
  });
});
