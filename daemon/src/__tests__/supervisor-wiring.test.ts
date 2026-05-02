// Tests for `wireSupervisorDispatcher` (Task #100).
//
// Asserts that the wiring helper:
//   1. Registers /healthz, /stats, daemon.shutdownForUpgrade against a fresh
//      supervisor dispatcher (replacing the NOT_IMPLEMENTED stubs from
//      `createSupervisorDispatcher`).
//   2. Each registered handler returns a real, schema-versioned reply with
//      ack_source='handler' on the wire.
//   3. Methods deliberately NOT wired here (daemon.hello, daemon.shutdown)
//      remain at their pre-wiring posture — `daemon.hello` keeps the
//      NOT_IMPLEMENTED stub (HMAC keystore is a separate slice per Task
//      #100 constraint), `daemon.shutdown` is owned by the daemon shell
//      because it binds the per-subsystem shutdown sinks.
//   4. Non-allowlisted methods still receive NOT_ALLOWED (defence in depth —
//      verifies the wiring did not accidentally widen the supervisor plane
//      surface beyond SUPERVISOR_RPCS).
//   5. shutdownForUpgrade actions execute in the spec §6.4 step order
//      (write-marker → run-shutdown-sequence → release-lock → exit), with
//      onError invoked when writeMarker rejects.
//
// Uses an in-memory marker dir per test so the real `defaultWriteShutdownMarker`
// can run end-to-end without touching the user's runtime root.

import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSupervisorDispatcher,
  type DispatchContext,
} from '../dispatcher.js';
import {
  WIRED_SUPERVISOR_METHODS,
  wireSupervisorDispatcher,
} from '../supervisor-wiring.js';
import { HEALTHZ_VERSION, type HealthzReply } from '../handlers/healthz.js';
import { STATS_VERSION, type StatsReply } from '../handlers/stats.js';
import {
  SHUTDOWN_MARKER_REASON_UPGRADE,
  type ShutdownForUpgradeAck,
  type ShutdownForUpgradeActions,
} from '../handlers/daemon-shutdown-for-upgrade.js';
import { SUPERVISOR_RPCS } from '../envelope/supervisor-rpcs.js';

const ctx: DispatchContext = { traceId: '01HZZZWIRE100XXXXXXXXXXX' };
const FIXED_NOW = 1_700_000_000_000;

function buildShutdownForUpgradeActions(): ShutdownForUpgradeActions & {
  callOrder: string[];
} {
  const callOrder: string[] = [];
  return {
    callOrder,
    writeMarker: vi.fn(async () => {
      callOrder.push('write-marker');
    }),
    runShutdownSequence: vi.fn(async () => {
      callOrder.push('run-shutdown-sequence');
    }),
    releaseLock: vi.fn(async () => {
      callOrder.push('release-lock');
    }),
    exit: vi.fn(() => {
      callOrder.push('exit');
    }),
  };
}

describe('wireSupervisorDispatcher (Task #100)', () => {
  let markerDir: string;

  beforeEach(async () => {
    markerDir = await mkdtemp(join(tmpdir(), 't100-wire-'));
  });

  afterEach(async () => {
    await rm(markerDir, { recursive: true, force: true });
  });

  function wire(opts: { upgradeActions?: ShutdownForUpgradeActions; onError?: (err: unknown) => void } = {}) {
    const dispatcher = createSupervisorDispatcher();
    const actions = opts.upgradeActions ?? buildShutdownForUpgradeActions();
    const result = wireSupervisorDispatcher(dispatcher, {
      healthz: {
        bootNonce: '01HZZZBOOT100XXXXXXXXXXX',
        pid: 4242,
        version: '0.3.0-task100',
        bootedAtMs: FIXED_NOW - 5_000,
        now: () => FIXED_NOW,
        getSessionCount: () => 2,
        getSubscriberCount: () => 9,
      },
      stats: {
        getMemoryUsage: () => ({ rss: 1_111, heapUsed: 222 }),
        getPtyBufferBytes: () => 333,
        getOpenSockets: () => 4,
      },
      shutdownForUpgrade: {
        ctx: {
          version: '0.3.0-task100',
          now: () => FIXED_NOW,
          markerDir,
        },
        actions,
        ...(opts.onError ? { onError: opts.onError } : {}),
      },
    });
    return { dispatcher, actions, result };
  }

  it('returns a manifest listing every wired supervisor method', () => {
    const { result } = wire();
    expect(result.registered).toEqual([...WIRED_SUPERVISOR_METHODS]);
    expect(result.schemaVersions.healthzVersion).toBe(HEALTHZ_VERSION);
    expect(result.schemaVersions.statsVersion).toBe(STATS_VERSION);
  });

  it('registers /healthz with the real handler (not NOT_IMPLEMENTED)', async () => {
    const { dispatcher } = wire();
    const r = await dispatcher.dispatch('/healthz', {}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ack_source).toBe('handler');
    const body = r.value as HealthzReply;
    expect(body.healthzVersion).toBe(HEALTHZ_VERSION);
    expect(body.bootNonce).toBe('01HZZZBOOT100XXXXXXXXXXX');
    expect(body.pid).toBe(4242);
    expect(body.uptimeMs).toBe(5_000);
    expect(body.sessionCount).toBe(2);
    expect(body.subscriberCount).toBe(9);
    expect(body.swapInProgress).toBe(false);
    expect(body.migrationState).toBe('absent');
  });

  it('registers /stats with the real handler', async () => {
    const { dispatcher } = wire();
    const r = await dispatcher.dispatch('/stats', {}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ack_source).toBe('handler');
    const body = r.value as StatsReply;
    expect(body.statsVersion).toBe(STATS_VERSION);
    expect(body.rss).toBe(1_111);
    expect(body.heapUsed).toBe(222);
    expect(body.ptyBufferBytes).toBe(333);
    expect(body.openSockets).toBe(4);
  });

  it('/stats falls back to process.memoryUsage() when no provider is supplied', async () => {
    const dispatcher = createSupervisorDispatcher();
    wireSupervisorDispatcher(dispatcher, {
      healthz: {
        bootNonce: 'nonce',
        pid: 1,
        version: 'v',
        bootedAtMs: FIXED_NOW,
        now: () => FIXED_NOW,
      },
      stats: {},
      shutdownForUpgrade: {
        ctx: { version: 'v', now: () => FIXED_NOW, markerDir },
        actions: buildShutdownForUpgradeActions(),
      },
    });
    const r = await dispatcher.dispatch('/stats', {}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value as StatsReply;
    expect(body.rss).toBeGreaterThan(0);
    expect(body.heapUsed).toBeGreaterThan(0);
    expect(body.ptyBufferBytes).toBe(0);
    expect(body.openSockets).toBe(0);
  });

  it('registers daemon.shutdownForUpgrade with the real handler + ack', async () => {
    const { dispatcher, actions } = wire();
    const r = await dispatcher.dispatch('daemon.shutdownForUpgrade', {}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ack_source).toBe('handler');
    const ack = r.value as ShutdownForUpgradeAck;
    expect(ack).toEqual({ accepted: true, reason: SHUTDOWN_MARKER_REASON_UPGRADE });

    // The handler schedules side effects on a microtask + awaits async fs ops
    // (when defaultWriteShutdownMarker is used). The injected mock writeMarker
    // resolves immediately so a bounded poll suffices.
    for (let i = 0; i < 50 && (actions as { exit: ReturnType<typeof vi.fn> }).exit.mock.calls.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 5));
    }
    expect((actions as ReturnType<typeof buildShutdownForUpgradeActions>).callOrder).toEqual([
      'write-marker',
      'run-shutdown-sequence',
      'release-lock',
      'exit',
    ]);
    expect(actions.exit).toHaveBeenCalledWith(0);
  });

  it('forwards writeMarker errors to the onError sink', async () => {
    const onError = vi.fn();
    const failingActions: ShutdownForUpgradeActions = {
      writeMarker: vi.fn(async () => {
        throw new Error('disk full');
      }),
      runShutdownSequence: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    };
    const { dispatcher } = wire({ upgradeActions: failingActions, onError });
    const r = await dispatcher.dispatch('daemon.shutdownForUpgrade', {}, ctx);
    expect(r.ok).toBe(true); // ack returns BEFORE the side effects run
    for (let i = 0; i < 50 && onError.mock.calls.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('disk full');
    // Subsequent steps MUST NOT run after writeMarker fails (spec invariant —
    // a failed marker write means "no upgrade marker" → next-boot supervisor
    // applies normal crash-loop accounting).
    expect(failingActions.runShutdownSequence).not.toHaveBeenCalled();
    expect(failingActions.releaseLock).not.toHaveBeenCalled();
    expect(failingActions.exit).not.toHaveBeenCalled();
  });

  it('leaves daemon.hello at NOT_IMPLEMENTED (HMAC decoupled per Task #100 constraint)', async () => {
    const { dispatcher } = wire();
    const r = await dispatcher.dispatch('daemon.hello', { foo: 1 }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_IMPLEMENTED');
    expect(r.error.method).toBe('daemon.hello');
  });

  it('leaves daemon.shutdown at NOT_IMPLEMENTED (shell wires it with subsystem sinks)', async () => {
    const { dispatcher } = wire();
    const r = await dispatcher.dispatch('daemon.shutdown', {}, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('non-allowlisted methods still get NOT_ALLOWED (no surface widening)', async () => {
    const { dispatcher } = wire();
    const r = await dispatcher.dispatch('session.list', {}, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_ALLOWED');
    expect(r.error.method).toBe('session.list');
  });

  it('every wired method is a member of the canonical SUPERVISOR_RPCS allowlist', () => {
    for (const m of WIRED_SUPERVISOR_METHODS) {
      expect(SUPERVISOR_RPCS).toContain(m);
    }
  });

  it('end-to-end: defaultWriteShutdownMarker against a real tmp dir lands a readable marker', async () => {
    // Use the production writeMarker against the tmp dir so we cover the
    // O_CREAT|O_EXCL → fsync → rename code path the supervisor reader (T22)
    // depends on. This is a real fs round-trip — proves the wiring is not
    // just routing into a mock.
    const realActions: ShutdownForUpgradeActions = {
      writeMarker: (await import('../handlers/daemon-shutdown-for-upgrade.js')).defaultWriteShutdownMarker,
      runShutdownSequence: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    };
    const { dispatcher } = wire({ upgradeActions: realActions });
    await dispatcher.dispatch('daemon.shutdownForUpgrade', {}, ctx);
    for (let i = 0; i < 50 && (realActions.exit as ReturnType<typeof vi.fn>).mock.calls.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 5));
    }
    const raw = await readFile(join(markerDir, 'daemon.shutdown'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      reason: 'upgrade',
      version: '0.3.0-task100',
      ts: FIXED_NOW,
    });
    void Buffer; // keep import marker for editor — Buffer is referenced via Node fs
  });
});
