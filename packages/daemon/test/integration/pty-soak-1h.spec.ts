// packages/daemon/test/integration/pty-soak-1h.spec.ts
//
// FOREVER-STABLE per docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 12 §4.3 (ship-gate (c)) + chapter 15 §3 #28 (canonical path lock).
// The 1-hour zero-loss PTY soak. Path is single-source-of-truth: chapter 06
// §8 and chapter 11 §6's `pnpm run test:pty-soak` invocation MUST resolve to
// this file.
//
// Behaviour locked here:
//   1. Spawn a pty-host child (T4.1 — `child_process.fork` boundary).
//   2. Drive it with the canned 60-minute high-throughput VT workload from
//      `claude-sim --simulate-workload 60m` (T8.7), which exercises every
//      class enumerated in chapter 12 §4.3 (UTF-8/CJK, 256-color/truecolor,
//      cursor positioning, alt-screen, bursts/idles, OSC, DECSTBM, mouse
//      modes, resize-during-burst).
//   3. Sample pty-host child RSS at MEMORY_SAMPLE_INTERVAL_MS cadence;
//      assert (final RSS - 2-minute-baseline RSS) <= MEMORY_LEAK_BUDGET_MIB.
//      This is gate (a) of T8.4 ("zero memory leak above N MiB").
//   4. Sample snapshot/delta cadence per minute; assert each minute lies in
//      [CADENCE_SNAPSHOTS_PER_MINUTE_MIN, CADENCE_SNAPSHOTS_PER_MINUTE_MAX].
//      This is gate (b) of T8.4 ("snapshot/delta cadence stays in spec
//      budget" — chapter 06 §4 K_TIME / M_DELTAS / B_BYTES envelope).
//   5. Sample SendInput RTT once per second; assert p99 < 5 ms (chapter 12
//      §4.3 SendInput sampling — blocking via gate (c)).
//   6. At t = 60m: serialize daemon-side xterm-headless state via SnapshotV1
//      and the client-side replayed state via SnapshotV1; assert
//      `Buffer.compare === 0` (chapter 12 §4.3 comparator algorithm).
//
// Until T4.1 / T4.6 / T4.10 land, the entire suite auto-skips via
// `describe.skipIf` (`dependenciesPresent().ready === false`). This makes
// the file safe to land first so chapter 11 §6 CI can pin the canonical
// path immediately; no reshape is needed when the dependencies arrive.
//
// CI orchestration: nightly schedule + `[soak]` token in commit message
// (chapter 12 §4.3). Per-PR runs the 10-minute smoke variant in the
// sibling spec.

import { describe, expect, it } from 'vitest';

import {
  SOAK_DURATION_1H_MS,
  dependenciesPresent,
  loadSoakDriver,
} from './pty-soak-shared.js';

const probe = dependenciesPresent();

// `nightly` tag: spec runners may filter by tag (`vitest run --testNamePattern`)
// to keep this out of the per-PR run. The 10m smoke variant is per-PR.
describe.skipIf(!probe.ready)(`pty-soak-1h (ship-gate (c)) [nightly]`, () => {
  // Vitest test-level timeout. Add a 5-minute slack on top of the soak
  // duration for boot, shutdown, and final byte-equality comparison.
  const TIMEOUT_MS = SOAK_DURATION_1H_MS + 5 * 60 * 1000;

  it(
    'runs 60 minutes against claude-sim and meets all gate-(c) invariants',
    async () => {
      const driver = await loadSoakDriver();
      const result = await driver.runSoak({ durationMs: SOAK_DURATION_1H_MS });
      driver.assertSoakInvariants(result, { durationMs: SOAK_DURATION_1H_MS });
      // Re-state the load-bearing assertions here (in addition to the
      // driver-side asserts) so a regression in the driver that silently
      // weakens an invariant fails this spec, not just the driver's own
      // self-tests.
      expect(result.daemonSnapshotBytes.length).toBeGreaterThan(0);
      expect(Buffer.compare(result.daemonSnapshotBytes, result.clientSnapshotBytes)).toBe(0);
      expect(result.sendInputP99Ms).toBeLessThan(5);
      expect(result.memoryFinalMib - result.memoryBaselineMib).toBeLessThanOrEqual(256);
    },
    TIMEOUT_MS,
  );
});

// When the suite is skipped, leave a single sentinel test that records WHY
// it was skipped (so `vitest --reporter=verbose` makes the gating reason
// visible in CI output without polluting the regular test list).
describe.skipIf(probe.ready)('pty-soak-1h (skipped — pending dependencies)', () => {
  it('reports gating reason', () => {
    expect(probe.reason).toMatch(/T4\./);
  });
});
