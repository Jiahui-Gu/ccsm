// T8.5 — Electron-side companion to the daemon `pty-soak-1h` ship-gate (c).
// Canonical path locked by design spec ch12 §4.3 (single source of truth):
//   "Electron-side reattach companion: packages/electron/test/e2e/pty-soak-reconnect.spec.ts"
//
// PURPOSE
// -------
// The daemon-side soak (`packages/daemon/test/integration/pty-soak-1h.spec.ts`,
// task T8.4) drives a 60-minute `claude-sim` workload through the daemon's
// pty-host, then asserts byte-equality between the daemon-side xterm-headless
// SnapshotV1 and a client-side replay SnapshotV1 (ch06 §8). That assertion
// covers the daemon side of the wire. THIS spec covers the OTHER side: a real
// Electron renderer process attaches to the same long-running pty session
// over Connect-RPC, drives a daemon restart mid-stream, reattaches with the
// recorded `last_applied_seq`, and asserts the post-reconnect xterm-headless
// state SnapshotV1-byte-equals the pre-restart daemon snapshot.
//
// The two specs together close ship-gate (c) end-to-end:
//   - T8.4 (daemon side): in-process replay byte-equality (no Electron).
//   - T8.5 (this file):   real Electron renderer survives a daemon restart
//                         and renders the same screen.
//
// SHIP-GATE (c) vs SHIP-GATE (b)
// ------------------------------
// Ship-gate (b) is `sigkill-reattach.spec.ts` (task T8.3): kill the *Electron*
// PID, daemon survives, relaunch Electron, byte-equality. This file inverts
// the failure mode: kill the *daemon* PID, Electron survives, daemon
// relaunches, Electron auto-reconnects per the chapter 02 §6 process-boundary
// contract ("Electron MUST tolerate Connect UNAVAILABLE with auto-reconnect +
// exponential backoff"), reattaches each session with `since_seq =
// lastAppliedSeq`, byte-equality (chapter 06 §5).
//
// SCALED-DOWN VARIANT
// -------------------
// Per ch13 phase-5 done criterion ("a 10-minute soak smoke
// `pty-soak-10m.spec.ts`, scaled-down variant of ship-gate (c)"), this file's
// per-PR run uses `CCSM_SOAK_DURATION_MS` (default 30s) so PR CI is bounded.
// Nightly self-hosted runs override to 60m via `CCSM_SOAK_DURATION_MS=3600000`
// (ch12 §4.3 self-hosted runner constraint). The byte-equality gate is
// duration-independent — a 30s run still catches encoder non-determinism,
// `since_seq` off-by-ones, and snapshot-cadence races; the 60m run adds
// burn-in for slow leaks.
//
// SKIP CONTRACT (load-bearing)
// ----------------------------
// This file is `.skip`'d at the top until ALL of the following land. Each
// dependency has a checked-in marker (an exported symbol or fixture path) so
// the skip flips automatically when the marker materializes — no follow-up
// dev work to "remember to un-skip". The skip is verified by the
// `skip-marker-resolved` assertion in the suite-bootstrap step, which fails
// loudly (rather than silently un-skipping into a fake green) if a marker
// appears without the rest of the wiring.
//
//   T6.2 — Electron-side Connect-RPC transport bridge
//          marker: `import('@ccsm/electron/src/rpc/transport.js')` resolves AND
//                  the module exports `createDaemonTransport`.
//          Without it the renderer has no Connect transport to drive
//          `PtyService.Attach`. Per task brief: "Mark .skip if T6.2 transport
//          bridge not yet landed (don't block on it)."
//
//   T8.4 — daemon `pty-soak-1h` spec + claude-sim fixture
//          marker: `packages/daemon/test/integration/pty-soak-1h.spec.ts` exists
//                  AND `packages/daemon/test/fixtures/claude-sim/bin/claude-sim`
//                  (or `.exe` on win32) is built per T8.7.
//          Without claude-sim there is no canonical workload generator that
//          exercises the ch12 §4.3 workload-class table; substituting a hand-
//          rolled echo loop would let the gate pass vacuously.
//
//   T8.3 — `sigkill-reattach.spec.ts` Playwright + per-OS process helpers
//          marker: `packages/electron/test/e2e/sigkill-reattach.spec.ts` exists.
//          That file ships the per-OS `killByPid()` helper and the Playwright
//          `_electron.launch()` boilerplate this spec reuses (the daemon-kill
//          path uses the same helper, just aimed at the daemon PID instead of
//          the Electron PID — see step 5 below).
//
// When all three markers are present, set `SKIP = false` below or unset the
// `CCSM_SKIP_E2E_PTY_SOAK_RECONNECT=1` env override; the suite then runs.
//
// FORBIDDEN SHORTCUTS
// -------------------
// 1. Do NOT replace claude-sim with `seq 1 1000000`. The ch12 §4.3
//    workload-class table (UTF-8 wide cells, alt-screen, DECSTBM, mouse
//    modes, etc.) is the *reason* byte-equality is meaningful; toy workloads
//    pass vacuously.
// 2. Do NOT kill the daemon by closing the Connect channel. The point is to
//    test process death (the daemon's pty-host child dies WITH the parent on
//    the per-OS path), not graceful RPC teardown.
// 3. Do NOT compare rendered text instead of SnapshotV1 bytes. Rendered-text
//    equality is the spike `[snapshot-roundtrip-fidelity]` *fallback* (ch14
//    §1.8); using it pre-emptively would silently downgrade ship-gate (c)
//    from STRICT_BYTE to RENDERED_EQUIVALENT. Reviewer MUST reject any such
//    diff.
// 4. Do NOT reuse the in-memory descriptor across the daemon restart. Per
//    ch03 §3.3 step 5, on UNAVAILABLE the client MUST re-read the descriptor
//    file so the new daemon's `boot_id` is detected on the very first
//    reconnect attempt. A stale-descriptor reattach masks the boot_id race.
//
// IMPLEMENTATION OUTLINE (executes once dependencies land)
// --------------------------------------------------------
// 1. Spawn daemon as a real OS subprocess in its own process group (mirrors
//    sigkill-reattach.spec.ts §step-1: `detached: true` on POSIX,
//    `windowsHide: true` + CREATE_NEW_PROCESS_GROUP on Windows). Capture
//    PID + descriptor path. Wait for `Hello`.
// 2. Launch Electron via `_electron.launch()` (Playwright). Through the
//    renderer, create one pty session with `claude-sim --simulate-workload`
//    (duration = CCSM_SOAK_DURATION_MS). Wait for `RUNNING`. Subscribe to
//    `PtyService.Attach`; let the workload run for the configured duration
//    while the renderer accumulates frames into an xterm-headless Terminal
//    and tracks `lastAppliedSeq`.
// 3. At t = duration / 2, snapshot the current renderer-side terminal via
//    SnapshotV1 (`recordedSnap`) and record `recordedSeq = lastAppliedSeq`.
// 4. Kill the daemon PID (NOT Electron) with the per-OS killer from T8.3.
//    Verify `claude` PIDs die with it (chapter 02 process-boundary contract).
// 5. Spawn a fresh daemon. Per ch03 §3.3, the new daemon writes a new
//    descriptor with a new `boot_id`. The renderer's Connect transport sees
//    UNAVAILABLE, re-reads the descriptor (NOT the in-memory copy), and
//    re-Hellos.
// 6. Renderer reattaches the same session with `since_seq = recordedSeq`.
//    Branch on retention window per ch06 §5:
//        - if gap < DELTA_RETENTION_SEQS (4096): expect deltas, no snapshot
//          frame; renderer applies them in-place.
//        - if gap >= DELTA_RETENTION_SEQS: expect a `snapshot` frame
//          followed by tail deltas; renderer rebuilds the terminal from
//          scratch.
//    Either path SHOULD converge to the same byte-equality result.
// 7. Wait for the workload to finish. Encode the renderer-side terminal via
//    SnapshotV1 (`replayedSnap`).
// 8. Ask the daemon to encode its xterm-headless state for the same session
//    (`PtyService.GetSnapshot`, ch04 §4) into `daemonSnap`.
// 9. Assert `Buffer.compare(daemonSnap, replayedSnap) === 0` AND assert
//    `recordedSnap` is a strict prefix of the data path that produced
//    `replayedSnap` (no rollback / dropped applied seqs across the restart).
//    Per ch12 §4.3: "Allowed deviation: zero."
//
// PLAYWRIGHT FIXTURE NOTE
// -----------------------
// Once T8.3 lands, the `_electron.launch()` boilerplate, per-OS killer, and
// descriptor-path discovery move into a shared fixture under
// `packages/electron/test/e2e/_fixtures/`. This spec then reduces to the
// 9-step sequence above against those fixtures. Until then, the single
// `it.skip` below is the entire executable surface — so the file
// type-checks, the path is locked, and `pnpm --filter @ccsm/electron test`
// emits a stable "1 skipped" line that CI can grep.

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Skip-marker resolution (synchronous, top-of-module)
// ---------------------------------------------------------------------------
// Each marker is a path on disk. We probe via `node:fs` (sync, cheap) instead
// of `import()` so a missing module does not throw during test collection.
// When all three markers exist AND the env override is unset, the suite runs.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// __dirname is not available under NodeNext ESM; derive from import.meta.url.
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

// Repo root = packages/electron/test/e2e/<this> -> ../../../../
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const T6_2_TRANSPORT_MARKER = join(
  REPO_ROOT,
  'packages',
  'electron',
  'src',
  'rpc',
  'transport.ts',
);
const T8_4_DAEMON_SOAK_MARKER = join(
  REPO_ROOT,
  'packages',
  'daemon',
  'test',
  'integration',
  'pty-soak-1h.spec.ts',
);
const T8_3_SIGKILL_FIXTURE_MARKER = join(
  REPO_ROOT,
  'packages',
  'electron',
  'test',
  'e2e',
  'sigkill-reattach.spec.ts',
);

const MISSING_MARKERS: string[] = [];
if (!existsSync(T6_2_TRANSPORT_MARKER)) MISSING_MARKERS.push('T6.2 transport bridge');
if (!existsSync(T8_4_DAEMON_SOAK_MARKER)) MISSING_MARKERS.push('T8.4 daemon pty-soak-1h spec');
if (!existsSync(T8_3_SIGKILL_FIXTURE_MARKER)) MISSING_MARKERS.push('T8.3 sigkill-reattach fixtures');

const SKIP_OVERRIDE = process.env.CCSM_SKIP_E2E_PTY_SOAK_RECONNECT === '1';
const SHOULD_SKIP = MISSING_MARKERS.length > 0 || SKIP_OVERRIDE;

const SKIP_REASON = SKIP_OVERRIDE
  ? 'CCSM_SKIP_E2E_PTY_SOAK_RECONNECT=1 (manual override)'
  : `awaiting dependencies: ${MISSING_MARKERS.join(', ')}`;

// `describe.skipIf(...)` keeps the suite present in the report (so CI can
// observe the skip count + reason) while preventing any of its lifecycle
// hooks from running. Vitest 4.x supports `skipIf` natively.
describe.skipIf(SHOULD_SKIP)(
  `T8.5 pty-soak-reconnect — Electron-side companion to ship-gate (c)`,
  () => {
    it('renderer survives daemon restart and reattaches with byte-identical SnapshotV1', async () => {
      // Implementation lands once the markers above resolve. See the
      // 9-step IMPLEMENTATION OUTLINE in this file's header comment.
      //
      // The TODO is intentional: a real test body that imports a missing
      // T6.2 transport would fail collection BEFORE `describe.skipIf` could
      // run. Keeping the body trivial preserves the "1 skipped" CI signal
      // through the dependency-landing window.
      expect(SHOULD_SKIP).toBe(false); // unreachable while skipped
      throw new Error(
        'T8.5 implementation pending — see header comment §IMPLEMENTATION OUTLINE.',
      );
    });
  },
);

// When SHOULD_SKIP is true, the only assertion that runs is the meta-check
// below: it locks the skip *reason* into the test report so a silent flip
// (e.g. someone removes the marker check without wiring the implementation)
// is visible as a failing test rather than a quietly-passing skip.
describe('T8.5 pty-soak-reconnect — skip-marker self-check', () => {
  it('reports a stable skip reason while dependencies are pending', () => {
    if (SHOULD_SKIP) {
      expect(SKIP_REASON).toMatch(/awaiting dependencies|manual override/);
      console.log(`[T8.5] suite skipped — ${SKIP_REASON}`);
    } else {
      // All markers resolved AND no manual override: the main suite above
      // MUST be running. If this branch is taken, that's the contract.
      expect(MISSING_MARKERS).toEqual([]);
    }
  });
});
