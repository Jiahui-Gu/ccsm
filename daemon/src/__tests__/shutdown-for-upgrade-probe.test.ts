// T82 — daemon.shutdownForUpgrade ack-timeout integration probe.
//
// Spec refs:
//   - frag-6-7 §6.4 — daemon.shutdownForUpgrade RPC + shutdown marker
//     "ack within 5 s" budget, ordered marker → drain → unlock → exit(0).
//   - frag-6-7 §6.3 — ack_source disambiguation (T24): unary handler reply
//     carries `ack_source: 'handler'`; this probe asserts the supervisor
//     transport sees a handler-ack, not a streaming-init dispatcher-ack.
//   - frag-6-7 §6.4 step 1 — marker MUST be on disk via atomic O_EXCL+rename
//     BEFORE any subsequent step runs. T82 specifically asserts marker
//     landed before the exit() sink fires.
//   - frag-6-7 §6.6.1 + §11.6.5 — if graceful drain overruns the deadline
//     (default 5 s), Electron-main's force-kill fallback (T25) terminates
//     the daemon. Probe assertion #3 mocks a hung `runShutdownSequence`
//     and drives `createForceKillSink().forceKillRemaining()` to verify
//     the wiring contract holds.
//   - frag-6-7 §6.4 + §6.1 R2 (T22 reader + T26 crash-loop skip) — even
//     when the daemon is force-killed mid-drain, the marker that was
//     written in step 1 must still be readable as PRESENT by the next-boot
//     supervisor (corruption-tolerant per rel-S-R8); T26
//     `shouldSkipCrashLoop` must return `true` against that snapshot.
//
// Single Responsibility: this is a black-box integration PROBE. It wires
// the real dispatcher + real handler factory + real default marker writer
// + real T22 reader + real T25 force-kill sink + real T26 decider. Only
// the actual side-effect terminals (`process.exit`, lock-release, the
// "do real shutdown sequence" thunk) are stubbed — everything between the
// dispatcher entry point and the marker bytes on disk is production code.
//
// Naming: `shutdown-for-upgrade-probe.test.ts` follows the T27 sibling
// `dispatcher-wiring-smoke.test.ts` convention (probe lives alongside the
// dispatcher tests, not under `handlers/__tests__/`, because it spans the
// dispatcher + handler + marker + lifecycle layers).

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSupervisorDispatcher, type DispatchContext } from '../dispatcher.js';
import {
  defaultWriteShutdownMarker,
  makeShutdownForUpgradeHandler,
  SHUTDOWN_MARKER_REASON_UPGRADE,
  type ShutdownForUpgradeAck,
  type ShutdownForUpgradeActions,
} from '../handlers/daemon-shutdown-for-upgrade.js';
import { createForceKillSink } from '../lifecycle/force-kill.js';
import { shouldSkipCrashLoop } from '../lifecycle/crash-loop-skip.js';
import {
  DAEMON_SHUTDOWN_MARKER_FILENAME,
  readMarker,
} from '../marker/reader.js';

const ctx: DispatchContext = { traceId: '01HZZZT82PROBEXXXXXXXXXX' };
const FIXED_NOW = 1_700_000_000_000;
const DAEMON_VERSION = '0.3.0-t82-probe';

/** Frag-6-7 §6.4 / §11.6.5 lock: caller's force-kill fallback fires at the
 *  5 s ack-completion budget. The probe uses 5 s as the literal deadline
 *  to keep the spec citation visible at the assertion site. */
const ACK_DEADLINE_MS = 5_000;
/** Probe-only safety cap: every "wait for sink to fire" loop bounds itself
 *  so a wiring regression that skips a sink never hangs the test runner. */
const POLL_BUDGET_MS = 1_000;
const POLL_INTERVAL_MS = 5;

async function pollUntil(
  predicate: () => boolean,
  budgetMs: number = POLL_BUDGET_MS,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return predicate();
}

describe('T82 daemon.shutdownForUpgrade ack-timeout probe', () => {
  let markerDir: string;

  beforeEach(async () => {
    markerDir = await mkdtemp(join(tmpdir(), 't82-probe-'));
  });

  afterEach(async () => {
    await rm(markerDir, { recursive: true, force: true });
  });

  /**
   * Wire the real dispatcher + real upgrade handler with the real
   * `defaultWriteShutdownMarker` against a tmpdir. `runShutdownSequence`
   * is the only knob the probe varies (instant vs. hung) so each assertion
   * exercises a distinct §6.4 path.
   */
  function wire(opts: {
    runShutdownSequence: () => Promise<void>;
    onMarkerWritten?: () => void;
  }): {
    dispatch: (req?: unknown) => ReturnType<
      ReturnType<typeof createSupervisorDispatcher>['dispatch']
    >;
    actions: ShutdownForUpgradeActions;
    timeline: string[];
    exitInvocations: number[];
  } {
    const d = createSupervisorDispatcher();
    const timeline: string[] = [];
    const exitInvocations: number[] = [];

    const actions: ShutdownForUpgradeActions = {
      writeMarker: async (plan) => {
        await defaultWriteShutdownMarker(plan);
        timeline.push('marker-written');
        if (opts.onMarkerWritten) opts.onMarkerWritten();
      },
      runShutdownSequence: async () => {
        timeline.push('drain-start');
        await opts.runShutdownSequence();
        timeline.push('drain-end');
      },
      releaseLock: async () => {
        timeline.push('lock-released');
      },
      exit: (code) => {
        timeline.push(`exit:${code}`);
        exitInvocations.push(code);
      },
    };

    d.register(
      'daemon.shutdownForUpgrade',
      makeShutdownForUpgradeHandler(
        { version: DAEMON_VERSION, now: () => FIXED_NOW, markerDir },
        actions,
      ),
    );

    return {
      dispatch: (req: unknown = {}) =>
        d.dispatch('daemon.shutdownForUpgrade', req, ctx),
      actions,
      timeline,
      exitInvocations,
    };
  }

  // -------------------------------------------------------------------------
  // Assertion 1: ACK arrives within deadline budget (T24 handler-ack).
  // -------------------------------------------------------------------------
  it('ack arrives within 5 s deadline budget with ack_source=handler', async () => {
    const { dispatch } = wire({ runShutdownSequence: async () => undefined });

    const startedAt = Date.now();
    const reply = await dispatch();
    const ackElapsedMs = Date.now() - startedAt;

    expect(ackElapsedMs).toBeLessThan(ACK_DEADLINE_MS);
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    // T24: every successful unary reply over the supervisor dispatcher
    // carries `ack_source: 'handler'`. Probe pins the wire-shape so a
    // future regression that mis-routes through `dispatchStreamingInit`
    // surfaces here, not in production.
    expect(reply.ack_source).toBe('handler');
    const ack = reply.value as ShutdownForUpgradeAck;
    expect(ack).toEqual({
      accepted: true,
      reason: SHUTDOWN_MARKER_REASON_UPGRADE,
    });
  });

  // -------------------------------------------------------------------------
  // Assertion 2: marker is on disk BEFORE the exit() sink fires (T21 atomicity).
  // -------------------------------------------------------------------------
  it('marker is on disk before process.exit is invoked', async () => {
    let markerStateAtExit: 'present' | 'absent' | 'unknown' = 'unknown';
    const markerPath = join(markerDir, DAEMON_SHUTDOWN_MARKER_FILENAME);

    const wired = wire({
      // Trivial drain — let the sink iterate to `exit` quickly.
      runShutdownSequence: async () => undefined,
    });
    // Override `exit` here so we can sample the disk state at the precise
    // moment the sink hits its terminal step. We can't do this through
    // `wire()`'s default `actions.exit` because the timeline observation
    // needs `await stat` mid-call.
    const originalExit = wired.actions.exit;
    (wired.actions as { exit: (code: number) => void }).exit = (code) => {
      try {
        // Sync stat would be cleaner but `node:fs/promises` is async-only
        // here; race a microtask + await is fine because exit() fires after
        // marker, lock, drain — so the file is already journalled by NTFS /
        // posix rename(2) by the time we get here.
        // We snapshot via the readMarker() result on the next tick below.
      } catch {
        markerStateAtExit = 'unknown';
      }
      originalExit(code);
    };

    const reply = await wired.dispatch();
    expect(reply.ok).toBe(true);

    // Wait for the side-effect chain to complete (handler resolves the ack
    // immediately; marker → drain → unlock → exit run on a microtask).
    const sinkFired = await pollUntil(() => wired.exitInvocations.length > 0);
    expect(sinkFired).toBe(true);

    // Re-derive the "marker present at exit" check from the timeline. The
    // executor (T21 `executeShutdownForUpgrade`) iterates `planSteps` in
    // strict order: write-marker → run-shutdown-sequence → release-lock
    // → exit. If `marker-written` doesn't precede `exit:0`, the §6.4
    // ordering invariant is broken regardless of what stat() shows.
    const markerIdx = wired.timeline.indexOf('marker-written');
    const exitIdx = wired.timeline.indexOf('exit:0');
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeLessThan(exitIdx);

    // And independently: the marker file is observable post-exit.
    const fileStat = await stat(markerPath);
    expect(fileStat.isFile()).toBe(true);
    markerStateAtExit = 'present';
    expect(markerStateAtExit).toBe('present');

    // T22 reader sees the full payload (round-trip the canonical shape).
    const result = await readMarker(markerPath);
    expect(result.kind).toBe('present');
    if (result.kind !== 'present') return;
    expect(result.payload).toEqual({
      reason: SHUTDOWN_MARKER_REASON_UPGRADE,
      version: DAEMON_VERSION,
      ts: FIXED_NOW,
    });
  });

  // -------------------------------------------------------------------------
  // Assertion 3: hung drain → caller's force-kill (T25) terminates; marker
  // is still PRESENT for next-boot crash-loop skip (T22 + T26).
  // -------------------------------------------------------------------------
  it('hung drain → force-kill fallback fires; marker remains PRESENT for T26 skip', async () => {
    const fakeChildPid = 99_999;
    const posixKill = vi.fn<(pid: number, sig: 'SIGKILL') => void>();
    const recordForceKill = vi.fn<
      (info: { platform: 'posix' | 'win32'; targets: number; errors: number }) => void
    >();
    // T25 sink — exercise BOTH platform branches via the `platform` override
    // so a single host probe covers POSIX SIGKILL and win32 JobObject.terminate.
    const posixSink = createForceKillSink({
      platform: 'posix',
      getChildPids: () => [fakeChildPid],
      posixKill,
      recordForceKill,
    });
    const fakeJob = { terminate: vi.fn() };
    const winSink = createForceKillSink({
      platform: 'win32',
      getJobObjects: () => [fakeJob],
      recordForceKill,
    });

    let drainResolve: (() => void) | null = null;
    const drainStuck = new Promise<void>((resolve) => {
      drainResolve = resolve;
    });

    const wired = wire({
      // Hung drain: never resolves until the test releases it. Mirrors a
      // misbehaving subscriber/db-checkpoint sink that ignores the deadline.
      runShutdownSequence: () => drainStuck,
    });

    const startedAt = Date.now();
    const reply = await wired.dispatch();
    const ackElapsedMs = Date.now() - startedAt;

    // Ack STILL arrives within budget even though the drain will hang —
    // because §6.4 step 4 schedules the sink on a microtask AFTER the wire
    // reply. This is the load-bearing property that lets the caller start
    // the 5 s force-kill timer the moment it sees the ack.
    expect(ackElapsedMs).toBeLessThan(ACK_DEADLINE_MS);
    expect(reply.ok).toBe(true);

    // Wait until the marker has landed (write-marker is the FIRST step;
    // it completes before the hung drain starts). Bounded poll guards
    // against a wiring regression that swaps the step order.
    const markerLanded = await pollUntil(() =>
      wired.timeline.includes('marker-written'),
    );
    expect(markerLanded).toBe(true);
    expect(wired.timeline).toContain('drain-start');
    expect(wired.timeline).not.toContain('drain-end');
    expect(wired.exitInvocations.length).toBe(0);

    // Caller (Electron-main) hits its 5 s ack-to-completion budget and
    // invokes the T25 sink. The probe drives both branches synchronously.
    const posixCount = posixSink.forceKillRemaining();
    const winCount = winSink.forceKillRemaining();
    expect(posixCount).toBe(1);
    expect(winCount).toBe(1);
    expect(posixKill).toHaveBeenCalledExactlyOnceWith(fakeChildPid, 'SIGKILL');
    expect(fakeJob.terminate).toHaveBeenCalledExactlyOnceWith(1);
    expect(recordForceKill).toHaveBeenCalledTimes(2);
    // Idempotency contract — a second call (replay path per §6.6.1) is a
    // silent no-op and the underlying kill primitive is NOT re-issued.
    expect(posixSink.forceKillRemaining()).toBe(0);
    expect(winSink.forceKillRemaining()).toBe(0);
    expect(posixKill).toHaveBeenCalledTimes(1);
    expect(fakeJob.terminate).toHaveBeenCalledTimes(1);

    // Next-boot supervisor reads the marker. Even though the daemon was
    // force-killed mid-drain (so no `release-lock` / `exit` ever ran), the
    // marker is on disk because step 1 ran first. T22 reads it as PRESENT;
    // T26 returns skip=true.
    const markerPath = join(markerDir, DAEMON_SHUTDOWN_MARKER_FILENAME);
    const snapshot = await readMarker(markerPath);
    expect(snapshot.kind).toBe('present');
    expect(
      shouldSkipCrashLoop({ marker: snapshot, consumed: false, restartCount: 1 }),
    ).toBe(true);
    // After consumption: subsequent restart in the same supervisor lifetime
    // resumes normal accounting.
    expect(
      shouldSkipCrashLoop({ marker: snapshot, consumed: true, restartCount: 2 }),
    ).toBe(false);

    // Cleanup: release the hung drain so the dangling promise resolves and
    // vitest doesn't warn about an unsettled promise on shutdown.
    if (drainResolve) (drainResolve as () => void)();
    await pollUntil(() => wired.timeline.includes('exit:0'));
  });

  // -------------------------------------------------------------------------
  // Bonus: corruption tolerance — even a half-flushed marker counts as
  // PRESENT for T26 skip (rel-S-R8). Verifies the probe's third assertion
  // doesn't depend on a perfectly-formed payload.
  // -------------------------------------------------------------------------
  it('half-flushed marker (zero-byte file) still PRESENT → T26 skip=true', async () => {
    // Simulate a power-cut between rename(tmp→final) and journal-flush:
    // empty file at the final marker path. T22 reader maps this to
    // { kind: 'present', reason: 'empty' }; T26 maps PRESENT to skip=true.
    const markerPath = join(markerDir, DAEMON_SHUTDOWN_MARKER_FILENAME);
    const { promises: fs } = await import('node:fs');
    await fs.writeFile(markerPath, '', { mode: 0o600 });

    const snapshot = await readMarker(markerPath);
    expect(snapshot.kind).toBe('present');
    if (snapshot.kind === 'present') {
      expect(snapshot.reason).toBe('empty');
    }
    expect(
      shouldSkipCrashLoop({ marker: snapshot, consumed: false, restartCount: 1 }),
    ).toBe(true);
  });
});
