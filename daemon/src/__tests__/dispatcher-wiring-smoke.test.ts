// T27 — Dispatcher wiring smoke test (integration).
//
// End-to-end smoke wiring the supervisor-plane dispatcher with all merged
// handlers (T17 /healthz, T18 /stats, T19 daemon.hello, T20 daemon.shutdown,
// T21 daemon.shutdownForUpgrade) and driving one RPC of each through the real
// dispatch path. Side-effect sinks (process.exit, fs writes, force-kill, db
// close) are mocked via vi.fn(); dispatcher, allowlist, handler factories,
// and ack-source wiring are real. Spec refs: frag-3.4.1 §3.4.1.h (allowlist),
// frag-6-7 §6.3 (ack_source), §6.5 (healthz/stats), §6.4 + §6.6.1 (shutdown).

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
  HEALTHZ_VERSION,
  makeHealthzHandler,
  type HealthzReply,
} from '../handlers/healthz.js';
import {
  STATS_VERSION,
  makeStatsHandler,
  type StatsReply,
} from '../handlers/stats.js';
import {
  createDaemonHelloHandler,
  HELLO_METHOD_LITERAL,
  type HelloReplyPayload,
} from '../handlers/daemon-hello.js';
import {
  createDaemonShutdownHandler,
  DAEMON_SHUTDOWN_METHOD,
  SHUTDOWN_PLAN,
  type DaemonShutdownReply,
  type ShutdownActions,
  type ShutdownStep,
} from '../handlers/daemon-shutdown.js';
import {
  defaultWriteShutdownMarker,
  makeShutdownForUpgradeHandler,
  SHUTDOWN_MARKER_REASON_UPGRADE,
  type ShutdownForUpgradeAck,
  type ShutdownForUpgradeActions,
} from '../handlers/daemon-shutdown-for-upgrade.js';
import { encode as base64urlEncode } from '../envelope/base64url.js';
import { DAEMON_PROTOCOL_VERSION } from '../envelope/protocol-version.js';
import { readMarker } from '../marker/reader.js';

const ctx: DispatchContext = { traceId: '01HZZZWIRESMOKEXXXXXXXX' };
const FIXED_NOW = 1_700_000_000_000;
const SECRET = Buffer.alloc(32, 0xab);
const BOOT_NONCE = '01HZZZBOOTNONCEXXXXXXXX';
// 22-char base64url over 16 deterministic bytes — daemon.hello accepts.
const CLIENT_NONCE = base64urlEncode(Buffer.alloc(16, 0x01));

describe('T27 dispatcher wiring smoke (all merged supervisor handlers)', () => {
  let markerDir: string;

  beforeEach(async () => {
    markerDir = await mkdtemp(join(tmpdir(), 't27-smoke-'));
  });

  afterEach(async () => {
    await rm(markerDir, { recursive: true, force: true });
  });

  /** Wire dispatcher + return mocks so each test asserts without rebuilding. */
  function wire(opts?: { overrunMs?: number }) {
    const d = createSupervisorDispatcher();

    d.register(
      '/healthz',
      makeHealthzHandler({
        bootNonce: BOOT_NONCE,
        pid: 4242,
        version: '0.3.0-smoke',
        bootedAtMs: FIXED_NOW - 10_000,
        now: () => FIXED_NOW,
        getSessionCount: () => 3,
        getSubscriberCount: () => 7,
      }),
    );

    d.register(
      '/stats',
      makeStatsHandler({
        getMemoryUsage: () => ({ rss: 12_345_678, heapUsed: 9_876_543 }),
        getPtyBufferBytes: () => 1024,
        getOpenSockets: () => 2,
      }),
    );

    d.register(
      HELLO_METHOD_LITERAL,
      createDaemonHelloHandler({
        getSecret: () => SECRET,
        getBootNonce: () => BOOT_NONCE,
      }),
    );

    const shutdownMocks = {
      markDraining: vi.fn().mockResolvedValue(undefined),
      clearHeartbeats: vi.fn().mockResolvedValue(undefined),
      rejectPendingCalls: vi.fn().mockResolvedValue(undefined),
      drainSnapshotSemaphore: vi.fn().mockResolvedValue(undefined),
      windDownSessions: opts?.overrunMs
        ? vi.fn(async () => {
            await new Promise((r) => setTimeout(r, opts.overrunMs));
          })
        : vi.fn().mockResolvedValue(undefined),
      closeSubscribers: vi.fn().mockResolvedValue(undefined),
      finalizeLogger: vi.fn().mockResolvedValue(undefined),
      exitProcess: vi.fn().mockResolvedValue(undefined),
      recordStepError: vi.fn(),
      recordDeadlineOverrun: vi.fn(),
      forceKillRemaining: vi.fn(),
    } satisfies ShutdownActions & {
      recordDeadlineOverrun: ReturnType<typeof vi.fn>;
      forceKillRemaining: ReturnType<typeof vi.fn>;
    };
    const shutdownHandler = createDaemonShutdownHandler(shutdownMocks);
    d.register(DAEMON_SHUTDOWN_METHOD, (req, c) =>
      shutdownHandler.handle(req as undefined, c),
    );

    // Real marker writer against tmp dir — exercises T22 reader end-to-end.
    const upgradeMocks: ShutdownForUpgradeActions = {
      writeMarker: vi.fn(defaultWriteShutdownMarker),
      runShutdownSequence: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    };
    d.register(
      'daemon.shutdownForUpgrade',
      makeShutdownForUpgradeHandler(
        { version: '0.3.0-smoke', now: () => FIXED_NOW, markerDir },
        upgradeMocks,
      ),
    );

    return { d, shutdownMocks, shutdownHandler, upgradeMocks };
  }

  it('/healthz returns ok body + ack_source=handler', async () => {
    const { d } = wire();
    const r = await d.dispatch('/healthz', {}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ack_source).toBe('handler');
    const body = r.value as HealthzReply;
    expect(body.healthzVersion).toBe(HEALTHZ_VERSION);
    expect(body.bootNonce).toBe(BOOT_NONCE);
    expect(body.uptimeMs).toBe(10_000);
    expect(body.pid).toBe(4242);
    expect(body.sessionCount).toBe(3);
    expect(body.subscriberCount).toBe(7);
    expect(body.protocol.daemonProtocolVersion).toBe(DAEMON_PROTOCOL_VERSION);
  });

  it('/stats returns the stats shape + ack_source=handler', async () => {
    const { d } = wire();
    const r = await d.dispatch('/stats', {}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ack_source).toBe('handler');
    const body = r.value as StatsReply;
    expect(body.statsVersion).toBe(STATS_VERSION);
    expect(body.rss).toBe(12_345_678);
    expect(body.heapUsed).toBe(9_876_543);
    expect(body.ptyBufferBytes).toBe(1024);
    expect(body.openSockets).toBe(2);
  });

  it('daemon.hello returns helloNonceHmac + bootNonce + ack_source=handler', async () => {
    const { d } = wire();
    const req = {
      clientWire: 'v0.3-json-envelope',
      clientProtocolVersion: DAEMON_PROTOCOL_VERSION,
      clientFrameVersions: [0],
      clientFeatures: ['binary-frames'],
      clientHelloNonce: CLIENT_NONCE,
    };
    const r = await d.dispatch(HELLO_METHOD_LITERAL, req, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ack_source).toBe('handler');
    const reply = r.value as HelloReplyPayload;
    expect(reply.bootNonce).toBe(BOOT_NONCE);
    expect(reply.compatible).toBe(true);
    expect(reply.helloNonceHmac).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(reply.protocol.daemonProtocolVersion).toBe(DAEMON_PROTOCOL_VERSION);
  });

  it('daemon.shutdown invokes drain actions in spec order (no real exit)', async () => {
    const { d, shutdownMocks, shutdownHandler } = wire();
    const r = await d.dispatch(DAEMON_SHUTDOWN_METHOD, { reason: 'smoke-test' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ack_source).toBe('handler');
    const reply = r.value as DaemonShutdownReply;
    expect(reply.ack).toBe('ok');
    expect(reply.idempotency).toBe('first');
    expect(reply.planSteps).toEqual(SHUTDOWN_PLAN.map((s) => s.step));

    const ranSteps = await shutdownHandler.whenDrained();
    expect(ranSteps).toEqual<readonly ShutdownStep[]>([
      'mark-draining',
      'clear-heartbeats',
      'reject-pending',
      'drain-snapshot-semaphore',
      'wind-down-sessions',
      'close-subscribers',
      'finalize-logger',
      'exit-process',
    ]);
    expect(shutdownMocks.markDraining).toHaveBeenCalledTimes(1);
    expect(shutdownMocks.exitProcess).toHaveBeenCalledWith(0);
    expect(shutdownMocks.markDraining.mock.invocationCallOrder[0]!).toBeLessThan(
      shutdownMocks.exitProcess.mock.invocationCallOrder[0]!,
    );
    expect(shutdownMocks.recordDeadlineOverrun).not.toHaveBeenCalled();
    expect(shutdownMocks.forceKillRemaining).not.toHaveBeenCalled();
  });

  it('daemon.shutdown deadline overrun → recordDeadlineOverrun → forceKill → finalize → exit', async () => {
    const { d, shutdownMocks, shutdownHandler } = wire({ overrunMs: 80 });
    const r = await d.dispatch(
      DAEMON_SHUTDOWN_METHOD,
      { deadlineMs: 50, reason: 'smoke-overrun' },
      ctx,
    );
    expect(r.ok).toBe(true);
    await shutdownHandler.whenDrained();
    expect(shutdownMocks.recordDeadlineOverrun).toHaveBeenCalledTimes(1);
    expect(shutdownMocks.forceKillRemaining).toHaveBeenCalledTimes(1);
    const orderOverrun = shutdownMocks.recordDeadlineOverrun.mock.invocationCallOrder[0]!;
    const orderForce = shutdownMocks.forceKillRemaining.mock.invocationCallOrder[0]!;
    const orderFinal = shutdownMocks.finalizeLogger.mock.invocationCallOrder[0]!;
    const orderExit = shutdownMocks.exitProcess.mock.invocationCallOrder[0]!;
    expect(orderForce).toBeGreaterThan(orderOverrun);
    expect(orderFinal).toBeGreaterThan(orderForce);
    expect(orderExit).toBeGreaterThan(orderFinal);
  });

  it('daemon.shutdownForUpgrade lands a marker readable by T22 reader', async () => {
    const { d, upgradeMocks } = wire();
    const r = await d.dispatch('daemon.shutdownForUpgrade', {}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ack_source).toBe('handler');
    const ack = r.value as ShutdownForUpgradeAck;
    expect(ack).toEqual({ accepted: true, reason: SHUTDOWN_MARKER_REASON_UPGRADE });

    // Side-effect chain runs on a microtask + multiple async fs ops; bounded
    // poll until exit() fires (or until safety cap to avoid hung wiring bug).
    for (let i = 0; i < 50 && upgradeMocks.exit.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(upgradeMocks.writeMarker).toHaveBeenCalledTimes(1);
    expect(upgradeMocks.runShutdownSequence).toHaveBeenCalledTimes(1);
    expect(upgradeMocks.releaseLock).toHaveBeenCalledTimes(1);
    expect(upgradeMocks.exit).toHaveBeenCalledWith(0);

    const result = await readMarker(join(markerDir, 'daemon.shutdown'));
    expect(result.kind).toBe('present');
    if (result.kind !== 'present') return;
    expect(result.payload).toEqual({
      reason: SHUTDOWN_MARKER_REASON_UPGRADE,
      version: '0.3.0-smoke',
      ts: FIXED_NOW,
    });
    const raw = await readFile(join(markerDir, 'daemon.shutdown'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ reason: 'upgrade' });
  });

  it('non-allowlisted method returns NOT_ALLOWED (defence in depth)', async () => {
    const { d } = wire();
    const r = await d.dispatch('session.list', {}, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_ALLOWED');
    expect(r.error.method).toBe('session.list');
  });

  it('dispatchStreamingInit returns dispatcher ack without invoking handler', () => {
    const { d, shutdownMocks } = wire();
    const r = d.dispatchStreamingInit('/healthz');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ack_source).toBe('dispatcher');
    expect(r.value).toBeUndefined();
    expect(shutdownMocks.markDraining).not.toHaveBeenCalled();
  });

  it('dispatchStreamingInit rejects non-allowlisted method with NOT_ALLOWED', () => {
    const { d } = wire();
    const r = d.dispatchStreamingInit('session.list');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_ALLOWED');
  });

  it('every supervisor RPC carries ack_source=handler when wired', async () => {
    const { d, shutdownHandler, upgradeMocks } = wire();
    const helloReq = {
      clientWire: 'v0.3-json-envelope',
      clientProtocolVersion: DAEMON_PROTOCOL_VERSION,
      clientFrameVersions: [0],
      clientFeatures: [],
      clientHelloNonce: CLIENT_NONCE,
    };
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['/healthz', {}],
      ['/stats', {}],
      [HELLO_METHOD_LITERAL, helloReq],
      [DAEMON_SHUTDOWN_METHOD, { reason: 'sweep' }],
      ['daemon.shutdownForUpgrade', {}],
    ];
    for (const [method, req] of cases) {
      const r = await d.dispatch(method, req, ctx);
      expect(r.ok, `dispatch ${method}`).toBe(true);
      if (!r.ok) continue;
      expect(r.ack_source, `ack_source for ${method}`).toBe('handler');
    }
    await shutdownHandler.whenDrained();
    for (let i = 0; i < 50 && upgradeMocks.exit.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  });
});
