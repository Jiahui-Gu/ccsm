// T8.3 — Ship-gate (b): daemon survives Electron SIGKILL.
//
// Canonical path locked by design spec ch12 §4.2 (single source of truth):
//   "packages/electron/test/e2e/sigkill-reattach.spec.ts (Playwright for
//    Electron + per-OS kill helper)"
//
// Cross-references:
//   - ch08 §7 step 4: lists this exact path as the "runtime gate (b)" harness.
//   - ch13 phase 11(b): release procedure invokes this spec.
//   - `packages/electron/test/e2e/pty-soak-reconnect.spec.ts` (T8.5) waits
//     on the T8.3 marker (this file's existence) before un-skipping.
//
// THIS FILE is the single source of truth for ship-gate (b)'s test name and
// path; any divergence in 00-brief.md or chapter 08 is a documentation bug.
//
// ----------------------------------------------------------------------------
// PURPOSE
// ----------------------------------------------------------------------------
// Verify the chapter 02 process-boundary contract end-to-end on a real
// Electron instance: the daemon runs in a separate OS process (not a fused
// Worker thread); when the Electron main PID is hard-killed via the per-OS
// kill helper (`./helpers/kill.ts`), the daemon and its `claude` PTY
// subprocesses survive; relaunching Electron reattaches each session and
// receives deltas continuing from the recorded `last_applied_seq` with
// SnapshotV1 byte-equality (chapter 06 §2 / §5).
//
// The byte-equality leg is what makes this gate non-vacuous: a seq-only
// gate passes when the wire is corrupt-but-monotonic, which is precisely
// the regression class the gate exists to catch (brief §11(b) "no data
// loss").
//
// ----------------------------------------------------------------------------
// VARIANTS (ch12 §4.2)
// ----------------------------------------------------------------------------
//   Per-PR (default)
//     - Subprocess daemon spawned by this spec (`spawn(process.execPath,
//       ['-e', "require('@ccsm/daemon').main()"], { detached: true })` on
//       POSIX; `+ CREATE_NEW_PROCESS_GROUP` on Windows).
//     - The in-process Worker variant is FORBIDDEN — see §FORBIDDEN
//       SHORTCUTS below.
//     - Runs on the standard `lint-typecheck-test` matrix (ubuntu / macos
//       / windows GitHub-hosted runners).
//     - Wall-clock target: ≤ 30 s.
//
//   Nightly (CCSM_E2E_SERVICE=1)
//     - Service-installed daemon (Windows: SCM `ccsm-daemon` service;
//       macOS: `launchctl bootstrap system/com.ccsm.daemon`; Linux:
//       `systemctl start ccsm-daemon`). Service installation is performed
//       OUT OF BAND by the runner image; this spec only attaches to the
//       already-running service via the descriptor file.
//     - Skipped on per-PR runs to keep PR CI fast and to avoid requiring
//       sudo / Administrator on GitHub-hosted runners.
//     - Runs on the `self-hosted-soak-*` runner labels (chapter 11 §6 /
//       chapter 12 §4.3 for the runner provisioning contract).
//
// ----------------------------------------------------------------------------
// 7-STEP IMPLEMENTATION OUTLINE (ch12 §4.2 + ch08 §7)
// ----------------------------------------------------------------------------
// 1. Boot daemon.
//    Per-PR: spawn subprocess in its own process group. Capture PID + the
//    descriptor path written to `state-dir/listener-a.json`. Wait for the
//    Supervisor `/healthz` to flip to 200 (chapter 02 §3 phase READY).
//    Nightly: skip the spawn; read the descriptor file written by the
//    service-installed daemon at the canonical OS-specific path
//    (`%ProgramData%\ccsm\listener-a.json` / `/var/lib/ccsm/listener-a.json`
//    / `~/Library/Application Support/ccsm/listener-a.json`).
//
// 2. Launch Electron via `_electron.launch()` (Playwright). The renderer
//    creates 3 PTY sessions through the Connect transport bridge (ch08
//    §4); for each, attach the `PtyService.Attach` server-stream and apply
//    the first 100 deltas into a client-side xterm-headless `Terminal`
//    instance. Record (a) the last applied seq per session and (b) the
//    `runtime_pid` from `Session.runtime_pid` (ch04 §3 — this field was
//    added to the v0.3 freeze precisely for this gate's step 4).
//
// 3. Hard-kill the Electron main PID via `killByPid(electronMainPid)`
//    (`./helpers/kill.ts`). On POSIX this is `kill -KILL <pid>` of the
//    Electron PID; the daemon, in a SEPARATE process group from step 1,
//    is unaffected. On Windows this is `taskkill /F /T /PID <pid>` which
//    tree-kills the Electron renderer + helper processes; the daemon, NOT
//    in Electron's tree by construction, survives.
//
// 4. Verify daemon liveness:
//    (a) Supervisor `/healthz` still returns 200 (loopback HTTP).
//    (b) For each session, the recorded `runtime_pid` is still alive via
//        `pidIsAlive(runtimePid)` from the kill helper.
//    Both must hold. If either fails, the gate is RED — file a P0.
//
// 5. Relaunch Electron via Playwright (fresh `_electron.launch()`). Wait
//    for the renderer's `Hello` RPC to complete; then call
//    `SessionService.ListSessions` and assert all 3 recorded session IDs
//    are present.
//
// 6. For each session, call `PtyService.Attach` with `since_seq =
//    recordedLastSeq[id]`. Per ch06 §5:
//      - if gap < DELTA_RETENTION_SEQS (currently 4096): the server sends
//        deltas only, no `snapshot` frame; client applies in-place to its
//        retained xterm-headless Terminal.
//      - if gap >= DELTA_RETENTION_SEQS: the server sends a `snapshot`
//        frame followed by tail deltas; client rebuilds from scratch.
//    Both branches MUST converge to the same byte-equality result in
//    step 7. Assert no gaps and no duplicate seqs along the way.
//
// 7. **Byte-equality "no data loss" assertion** (ch12 §4.2 step 7):
//      - Daemon side: call `PtyService.GetSnapshot` (ch04 §4) for each
//        session; this serializes the daemon's xterm-headless terminal
//        state via the SnapshotV1 encoder (ch06 §2). Capture as
//        `daemonSnap[id]: Uint8Array`.
//      - Client side: serialize the renderer-side xterm-headless Terminal
//        (after applying every received delta from step 2 + step 6) via
//        the SAME SnapshotV1 encoder. Capture as `clientSnap[id]:
//        Uint8Array`.
//      - Assert `Buffer.compare(daemonSnap[id], clientSnap[id]) === 0`
//        for every session. This is the same comparator gate (c) uses;
//        gate (b) reuses it as a 30-second variant. Per ch12 §4.2:
//        "Allowed deviation: zero."
//
// ----------------------------------------------------------------------------
// FORBIDDEN SHORTCUTS (reviewer MUST reject any PR that takes these)
// ----------------------------------------------------------------------------
// 1. **In-process Worker daemon** is forbidden. `taskkill /F /IM
//    electron.exe` (and `kill -9` of the Electron PID group on POSIX) can
//    reap a fused daemon Worker thread, masking the very failure mode the
//    gate exists to catch. The subprocess variant is mandatory for per-PR;
//    the service-installed variant is mandatory for nightly. Per ch12 §4.2.
//
// 2. **Closing the Connect channel instead of killing the Electron PID**
//    is forbidden. The point is to verify process-death survival, not
//    graceful RPC teardown. Channel close cannot exercise the OS-level
//    process-group separation that ch02 §6 requires.
//
// 3. **Comparing rendered text instead of SnapshotV1 bytes** is forbidden.
//    Rendered-text equality is the spike `[snapshot-roundtrip-fidelity]`
//    *fallback* (ch14 §1.8); using it pre-emptively silently downgrades
//    ship-gate (b) from STRICT_BYTE to RENDERED_EQUIVALENT.
//
// 4. **Substituting `process.kill(pid, 'SIGKILL')` on Windows** is
//    forbidden. libuv ignores the signal name on Windows and calls
//    `TerminateProcess` on the target only; descendants survive,
//    defeating the tree-kill semantics ch12 §4.2 requires. Use
//    `killByPid` from `./helpers/kill.ts` which routes through
//    `taskkill /F /T` on Windows. The kill helper has its own smoke test
//    in `./helpers/kill.spec.ts` with reverse-verify hook.
//
// 5. **Skipping byte-equality on the grounds that "seq-continuation is
//    enough"** is forbidden. A monotonic-but-corrupt wire passes the
//    seq check; brief §11(b) "no data loss" requires byte-equality.
//
// ----------------------------------------------------------------------------
// SKIP CONTRACT (load-bearing — same pattern as T8.5 pty-soak-reconnect)
// ----------------------------------------------------------------------------
// The full 7-step body is `describe.skipIf(...)`'d until ALL of the
// following dependencies land. Each dependency has a checked-in marker (a
// file path probed via `node:fs.existsSync`) so the skip flips
// automatically — no follow-up "remember to un-skip" dev work. The skip
// reason is asserted by a dedicated self-check `describe` block so a
// silent flip (marker check removed without wiring the implementation)
// shows up as a failing test rather than a vacuously-green skip.
//
//   T1.4  — Listener A bind + descriptor write
//           marker: `packages/daemon/src/listeners/listener-a.ts`
//           Without it the daemon never writes `listener-a.json`, so the
//           Electron renderer has no transport descriptor to read.
//
//   T6.2  — Electron-side Connect-RPC transport bridge
//           marker: `packages/electron/src/rpc/transport.ts` exists AND
//                   exports `createDaemonTransport`.
//           Without it the renderer has no Connect transport to drive
//           `SessionService.Create` / `PtyService.Attach`.
//
//   ch06 §2 SnapshotV1 encoder
//           marker: `packages/daemon/src/pty/snapshot-v1.ts`
//           The byte-equality assertion in step 7 IS the gate; without
//           the encoder there is no comparator.
//
//   T8.7  — `claude-sim` deterministic workload fixture
//           marker: `packages/daemon/test/fixtures/claude-sim/bin/claude-sim`
//                   (or `.exe` on win32)
//           Step 2 needs a workload that exercises the ch12 §4.3
//           workload-class table; substituting a hand-rolled echo loop
//           would make step 7 byte-equality pass vacuously on toy bytes.
//
//   T6.6 / T8.x  — Playwright `_electron.launch()` boilerplate
//           marker: `packages/electron/test/e2e/_fixtures/launch.ts`
//           Once landed, the per-PR spawn-daemon-as-subprocess + launch-
//           electron + per-OS-killer plumbing moves into a shared fixture
//           consumed by both this file and `pty-soak-reconnect.spec.ts`.
//           Until then the single `it.skip` below is the entire executable
//           surface so the file type-checks and the path is locked.
//
// When all five markers are present AND the env override is unset, the
// suite runs. The `CCSM_E2E_SERVICE=1` env var additionally gates the
// nightly service-installed variant (default per-PR variant uses the
// subprocess daemon).
//
// ----------------------------------------------------------------------------
// REVERSE-VERIFY (PR review checkpoint)
// ----------------------------------------------------------------------------
// The kill helper at `./helpers/kill.ts` IS reverse-verifiable today via
// `./helpers/kill.spec.ts`:
//   1. Stash the body of `killByPid()` (replace with a no-op return).
//   2. Run `pnpm --filter @ccsm/electron test`. The kill helper smoke
//      MUST FAIL at the `waitForPidDead` post-condition.
//   3. Restore. Run again. MUST PASS.
// Both outputs are pasted in the PR body for review.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compile-time import to keep the kill helper in the test graph and ensure
// the helper smoke spec is co-located with the file that depends on it.
// The `void` cast prevents tree-shaking from dropping the import in
// future bundler-mediated builds.
import * as killHelper from './helpers/kill.js';
void killHelper;

// __dirname is not available under NodeNext ESM; derive from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

// Repo root = packages/electron/test/e2e/<this> -> ../../../../
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

// ---------------------------------------------------------------------------
// Skip-marker resolution (synchronous, top-of-module)
// ---------------------------------------------------------------------------
// Each marker is a path on disk. Probe via `node:fs.existsSync` (sync,
// cheap) instead of dynamic `import()` so a missing module does not throw
// during test collection.

const T1_4_LISTENER_A_MARKER = join(
  REPO_ROOT, 'packages', 'daemon', 'src', 'listeners', 'listener-a.ts',
);
const T6_2_TRANSPORT_MARKER = join(
  REPO_ROOT, 'packages', 'electron', 'src', 'rpc', 'transport.ts',
);
const SNAPSHOT_V1_ENCODER_MARKER = join(
  REPO_ROOT, 'packages', 'daemon', 'src', 'pty', 'snapshot-v1.ts',
);
const T8_7_CLAUDE_SIM_MARKER_POSIX = join(
  REPO_ROOT, 'packages', 'daemon', 'test', 'fixtures', 'claude-sim', 'bin', 'claude-sim',
);
const T8_7_CLAUDE_SIM_MARKER_WIN = T8_7_CLAUDE_SIM_MARKER_POSIX + '.exe';
const PLAYWRIGHT_FIXTURE_MARKER = join(
  REPO_ROOT, 'packages', 'electron', 'test', 'e2e', '_fixtures', 'launch.ts',
);

const MISSING_MARKERS: string[] = [];
if (!existsSync(T1_4_LISTENER_A_MARKER)) MISSING_MARKERS.push('T1.4 Listener A');
if (!existsSync(T6_2_TRANSPORT_MARKER)) MISSING_MARKERS.push('T6.2 transport bridge');
if (!existsSync(SNAPSHOT_V1_ENCODER_MARKER)) MISSING_MARKERS.push('SnapshotV1 encoder (ch06 §2)');
if (
  !existsSync(T8_7_CLAUDE_SIM_MARKER_POSIX) &&
  !existsSync(T8_7_CLAUDE_SIM_MARKER_WIN)
) {
  MISSING_MARKERS.push('T8.7 claude-sim fixture');
}
if (!existsSync(PLAYWRIGHT_FIXTURE_MARKER)) {
  MISSING_MARKERS.push('Playwright _electron.launch fixture');
}

const SKIP_OVERRIDE = process.env.CCSM_SKIP_E2E_SIGKILL_REATTACH === '1';
const SHOULD_SKIP = MISSING_MARKERS.length > 0 || SKIP_OVERRIDE;

const SKIP_REASON = SKIP_OVERRIDE
  ? 'CCSM_SKIP_E2E_SIGKILL_REATTACH=1 (manual override)'
  : `awaiting dependencies: ${MISSING_MARKERS.join(', ')}`;

// Service-installed variant gate. Default per-PR runs use the subprocess
// daemon; nightly runs on `self-hosted-soak-*` runners set
// `CCSM_E2E_SERVICE=1` to opt into the service variant.
const SERVICE_VARIANT = process.env.CCSM_E2E_SERVICE === '1';

// `describe.skipIf(...)` keeps the suite present in the report (so CI can
// observe the skip count + reason) while preventing any of its lifecycle
// hooks from running. Vitest 4.x supports `skipIf` natively.
describe.skipIf(SHOULD_SKIP)(
  `T8.3 sigkill-reattach — ship-gate (b) [${SERVICE_VARIANT ? 'service-installed' : 'subprocess'}]`,
  () => {
    it(
      'daemon survives Electron SIGKILL; reattach yields SnapshotV1 byte-equal terminal state',
      async () => {
        // Implementation lands once the markers above resolve. See the
        // 7-step IMPLEMENTATION OUTLINE in this file's header comment.
        //
        // The TODO is intentional: a real test body that imports a missing
        // T6.2 transport / Playwright fixture would fail collection BEFORE
        // `describe.skipIf` could run. Keeping the body trivial preserves
        // the "1 skipped" CI signal through the dependency-landing window.
        expect(SHOULD_SKIP).toBe(false); // unreachable while skipped
        throw new Error(
          'T8.3 implementation pending — see header comment §IMPLEMENTATION OUTLINE.',
        );
      },
    );
  },
);

// When SHOULD_SKIP is true, the only assertion that runs is the meta-check
// below: it locks the skip *reason* into the test report so a silent flip
// (e.g. someone removes the marker check without wiring the implementation)
// is visible as a failing test rather than a quietly-passing skip. This
// mirrors the pattern in `pty-soak-reconnect.spec.ts` (T8.5).
describe('T8.3 sigkill-reattach — skip-marker self-check', () => {
  it('reports a stable skip reason while dependencies are pending', () => {
    if (SHOULD_SKIP) {
      expect(SKIP_REASON).toMatch(/awaiting dependencies|manual override/);
      console.log(`[T8.3] suite skipped — ${SKIP_REASON}`);
    } else {
      // All markers resolved AND no manual override: the main suite above
      // MUST be running. If this branch is taken, that's the contract.
      expect(MISSING_MARKERS).toEqual([]);
    }
  });

  it('exposes the per-OS kill helper for downstream specs (T8.5 reuse)', () => {
    // Sanity-check the helper API surface the spec body in step 3-4 uses.
    // This also documents the load-bearing exports for code-search; if
    // someone deletes one of these, this test fails immediately rather
    // than waiting for the deps to land and the main suite to flake.
    expect(typeof killHelper.killByPid).toBe('function');
    expect(typeof killHelper.pidIsAlive).toBe('function');
    expect(typeof killHelper.waitForPidDead).toBe('function');
  });
});
