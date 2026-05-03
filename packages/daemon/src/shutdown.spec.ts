// Unit tests for the graceful shutdown orchestrator (T1.8).
//
// Covers spec ch02 §4:
//   - SIGTERM with in-flight RPC drained within budget → exit clean.
//   - SIGTERM with stuck RPC (5s budget exceeded) → orchestrator continues.
//   - SIGTERM with claude grandchildren → SIGKILL escalation after 3s.
//   - WAL TRUNCATE checkpoint runs and DB closes.
//   - Listener and supervisor close ordering (data plane first, supervisor last).
//   - Errors in any single step do not abort the sequence.
//
// The Listener / SupervisorServer / pty-host child handle / SQLite handle
// are all mocked through their public trait shapes (no real sockets / no
// real `child_process.fork`); this file is a pure unit test that runs in
// milliseconds. The cross-module integration story (a real Listener A
// instance + real pty-host child) is covered by the existing pty-soak +
// supervisor contract specs together with the handler interceptor wiring
// that lands in T2.x — keeping this file mock-only is deliberate.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CLAUDE_SIGKILL_MS,
  DEFAULT_INFLIGHT_BUDGET_MS,
  Shutdown,
  installShutdownHandlers,
  noopInFlightTracker,
  SHUTDOWN_SIGNALS,
  type InFlightTracker,
  type ShutdownContext,
  type ShutdownLogger,
  type ShutdownStepName,
} from './shutdown.js';
import type { Listener, BindDescriptor } from './listeners/types.js';
import type { PtyHostChildHandle } from './pty-host/index.js';
import type { ChildExit } from './pty-host/types.js';
import type { SupervisorServer } from './supervisor/server.js';
import type { SqliteDatabase } from './db/sqlite.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeListener(id: string, opts: { stopThrows?: boolean } = {}): Listener {
  return {
    id,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      if (opts.stopThrows) throw new Error(`${id} stop boom`);
    }),
    descriptor: (): BindDescriptor => ({ kind: 'loopbackTcp', host: '127.0.0.1', port: 0 }),
  };
}

function makeSupervisor(opts: { stopThrows?: boolean } = {}): SupervisorServer {
  return {
    address: () => '/tmp/sup.sock',
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      if (opts.stopThrows) throw new Error('supervisor stop boom');
    }),
  };
}

function makePtyHandle(
  sessionId: string,
  opts: {
    closeBehavior?: 'graceful' | 'sigkill' | 'throws';
    closeDelayMs?: number;
  } = {},
): PtyHostChildHandle {
  const exit: ChildExit =
    opts.closeBehavior === 'sigkill'
      ? { reason: 'crashed', code: null, signal: 'SIGKILL' }
      : { reason: 'graceful', code: 0, signal: null };
  const handle: PtyHostChildHandle = {
    sessionId,
    pid: 12345,
    claudeSpawnEnv: {},
    ready: () => Promise.resolve(),
    send: vi.fn(),
    exited: () => Promise.resolve(exit),
    messages: () => ({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.resolve({ value: undefined as never, done: true }) };
      },
    }),
    closeAndWait: vi.fn(async () => {
      if (opts.closeBehavior === 'throws') throw new Error('pty close boom');
      if (opts.closeDelayMs) {
        await new Promise((r) => setTimeout(r, opts.closeDelayMs));
      }
      return exit;
    }),
  };
  return handle;
}

function makeDb(opts: { pragmaThrows?: boolean } = {}): SqliteDatabase {
  // Minimal duck-typed stand-in. `walCheckpointTruncate` only calls
  // `db.pragma('wal_checkpoint(TRUNCATE)')`, and `db.close()` is the
  // other surface we hit. Cast through `unknown` to bypass the full
  // better-sqlite3 surface that we don't need.
  const pragma = vi.fn((sql: string) => {
    if (opts.pragmaThrows) throw new Error('pragma boom');
    if (sql.startsWith('wal_checkpoint')) {
      return [{ busy: 0, log: 0, checkpointed: 0 }];
    }
    return [];
  });
  const close = vi.fn();
  return { pragma, close } as unknown as SqliteDatabase;
}

function makeTracker(initialInFlight: number, drainAfterMs?: number): InFlightTracker {
  let count = initialInFlight;
  return {
    waitForInFlight(timeoutMs: number): Promise<number> {
      if (drainAfterMs !== undefined && drainAfterMs <= timeoutMs) {
        return new Promise((resolve) => {
          setTimeout(() => {
            count = 0;
            resolve(0);
          }, drainAfterMs);
        });
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve(count), timeoutMs);
      });
    },
  };
}

function makeRecordingLogger(): ShutdownLogger & { events: Array<[string, ShutdownStepName]> } {
  const events: Array<[string, ShutdownStepName]> = [];
  return {
    events,
    step(name) {
      events.push(['step', name]);
    },
    warn(name) {
      events.push(['warn', name]);
    },
  };
}

function baseCtx(over: Partial<ShutdownContext> = {}): ShutdownContext {
  return {
    listeners: [],
    supervisor: null,
    ptyHostChildren: [],
    db: null,
    inFlightTracker: noopInFlightTracker,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Shutdown.run() — ordered sequence', () => {
  it('returns clean result when nothing is wired (entrypoint pre-OPENING_DB failure path)', async () => {
    const sd = new Shutdown();
    const r = await sd.run(baseCtx());
    expect(r.errors).toHaveLength(0);
    expect(r.inFlightAtBudgetExpiry).toBe(0);
    expect(r.ptyExits).toHaveLength(0);
    expect(r.walCheckpointBusy).toBeNull();
    expect(sd.isDone()).toBe(true);
  });

  it('stops every listener and the supervisor (data-plane first, supervisor last)', async () => {
    const log = makeRecordingLogger();
    const lA = makeListener('listener-a');
    const sup = makeSupervisor();
    const sd = new Shutdown();
    await sd.run(baseCtx({ listeners: [lA], supervisor: sup, log }));
    expect(lA.stop).toHaveBeenCalledTimes(1);
    expect(sup.stop).toHaveBeenCalledTimes(1);
    // Step ordering: stop-accepting → drain-rpc → close-pty → wal/db → supervisor-close → done.
    const stepOrder = log.events.filter((e) => e[0] === 'step').map((e) => e[1]);
    const stopIdx = stepOrder.indexOf('stop-accepting');
    const supIdx = stepOrder.indexOf('supervisor-close');
    const doneIdx = stepOrder.indexOf('done');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(supIdx).toBeGreaterThan(stopIdx);
    expect(doneIdx).toBeGreaterThan(supIdx);
  });

  it('drains in-flight RPC within budget and reports zero', async () => {
    const tracker = makeTracker(3, /* drainAfterMs */ 20);
    const sd = new Shutdown();
    const r = await sd.run(baseCtx({ inFlightTracker: tracker, inFlightBudgetMs: 200 }));
    expect(r.inFlightAtBudgetExpiry).toBe(0);
    expect(r.errors).toHaveLength(0);
  });

  it('continues past stuck RPC when budget exceeded (5s spec budget)', async () => {
    // Tracker that never drains — promise resolves with the still-pending count.
    const tracker = makeTracker(2, /* drainAfterMs */ undefined);
    const sd = new Shutdown();
    const r = await sd.run(baseCtx({ inFlightTracker: tracker, inFlightBudgetMs: 30 }));
    expect(r.inFlightAtBudgetExpiry).toBe(2);
    // Sequence still completed.
    expect(sd.isDone()).toBe(true);
  });

  it('default budgets match spec ch02 §4 (5s + 3s)', () => {
    expect(DEFAULT_INFLIGHT_BUDGET_MS).toBe(5_000);
    expect(DEFAULT_CLAUDE_SIGKILL_MS).toBe(3_000);
  });
});

describe('Shutdown.run() — pty children (SIGTERM → SIGKILL after 3s)', () => {
  it('calls closeAndWait with the spec-locked claude SIGKILL window', async () => {
    const child = makePtyHandle('s1');
    const sd = new Shutdown();
    await sd.run(baseCtx({ ptyHostChildren: [child] }));
    expect(child.closeAndWait).toHaveBeenCalledWith(DEFAULT_CLAUDE_SIGKILL_MS);
  });

  it('honours a caller-supplied claudeSigkillMs override', async () => {
    const child = makePtyHandle('s1');
    const sd = new Shutdown();
    await sd.run(baseCtx({ ptyHostChildren: [child], claudeSigkillMs: 100 }));
    expect(child.closeAndWait).toHaveBeenCalledWith(100);
  });

  it('classifies a SIGKILL exit as reason=sigkill (not "crashed")', async () => {
    const child = makePtyHandle('s1', { closeBehavior: 'sigkill' });
    const sd = new Shutdown();
    const r = await sd.run(baseCtx({ ptyHostChildren: [child] }));
    expect(r.ptyExits).toEqual([
      { sessionId: 's1', reason: 'sigkill', code: null, signal: 'SIGKILL' },
    ]);
  });

  it('records per-child closeAndWait throws into errors array but continues', async () => {
    const c1 = makePtyHandle('s1', { closeBehavior: 'throws' });
    const c2 = makePtyHandle('s2');
    const sd = new Shutdown();
    const r = await sd.run(baseCtx({ ptyHostChildren: [c1, c2] }));
    expect(r.errors.some(([step]) => step === 'close-pty-children')).toBe(true);
    expect(c2.closeAndWait).toHaveBeenCalled();
    // s1 still appears in ptyExits as a synthesised crashed entry.
    const s1 = r.ptyExits.find((e) => e.sessionId === 's1');
    expect(s1?.reason).toBe('crashed');
  });

  it('fans out child closes in parallel (not sequentially)', async () => {
    const c1 = makePtyHandle('s1', { closeDelayMs: 40 });
    const c2 = makePtyHandle('s2', { closeDelayMs: 40 });
    const sd = new Shutdown();
    const t0 = Date.now();
    await sd.run(baseCtx({ ptyHostChildren: [c1, c2] }));
    const elapsed = Date.now() - t0;
    // Sequential would be ~80ms; parallel should finish well under 70ms.
    expect(elapsed).toBeLessThan(70);
  });
});

describe('Shutdown.run() — WAL checkpoint + DB close', () => {
  it('runs walCheckpointTruncate then db.close when a db is present', async () => {
    const db = makeDb();
    const sd = new Shutdown();
    const r = await sd.run(baseCtx({ db }));
    expect(db.pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(r.walCheckpointBusy).toBe(false);
  });

  it('skips checkpoint + close when db is null (pre-OPENING_DB failure path)', async () => {
    const sd = new Shutdown();
    const r = await sd.run(baseCtx({ db: null }));
    expect(r.walCheckpointBusy).toBeNull();
  });

  it('records pragma failure into errors but still attempts db.close()', async () => {
    const db = makeDb({ pragmaThrows: true });
    const sd = new Shutdown();
    const r = await sd.run(baseCtx({ db }));
    expect(r.errors.some(([s]) => s === 'wal-checkpoint')).toBe(true);
    expect(db.close).toHaveBeenCalledTimes(1);
  });
});

describe('Shutdown.run() — error containment + idempotency', () => {
  it('captures listener stop throws but proceeds through every later step', async () => {
    const lA = makeListener('listener-a', { stopThrows: true });
    const sup = makeSupervisor();
    const db = makeDb();
    const child = makePtyHandle('s1');
    const sd = new Shutdown();
    const r = await sd.run(baseCtx({ listeners: [lA], supervisor: sup, db, ptyHostChildren: [child] }));
    expect(r.errors.some(([s]) => s === 'stop-accepting')).toBe(true);
    expect(child.closeAndWait).toHaveBeenCalled();
    expect(db.close).toHaveBeenCalled();
    expect(sup.stop).toHaveBeenCalled();
  });

  it('captures supervisor stop throws into errors', async () => {
    const sup = makeSupervisor({ stopThrows: true });
    const sd = new Shutdown();
    const r = await sd.run(baseCtx({ supervisor: sup }));
    expect(r.errors.some(([s]) => s === 'supervisor-close')).toBe(true);
  });

  it('is idempotent: second concurrent run() returns the same result without re-firing side effects', async () => {
    const lA = makeListener('listener-a');
    const sd = new Shutdown();
    const ctx = baseCtx({ listeners: [lA] });
    const [r1, r2] = await Promise.all([sd.run(ctx), sd.run(ctx)]);
    expect(r1).toBe(r2);
    expect(lA.stop).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: third sequential run() also returns the cached result', async () => {
    const lA = makeListener('listener-a');
    const sd = new Shutdown();
    await sd.run(baseCtx({ listeners: [lA] }));
    await sd.run(baseCtx({ listeners: [lA] }));
    expect(lA.stop).toHaveBeenCalledTimes(1);
  });
});

describe('installShutdownHandlers', () => {
  // We mock process.exit during these cases — the handler's
  // second-signal escape hatch calls it, which would otherwise crash
  // the vitest worker. The mock is restored at the end of each case.
  function mockExit(): { restore: () => void; calls: number[] } {
    const calls: number[] = [];
    const orig = process.exit;
    (process as { exit: (code?: number) => never }).exit = ((code?: number): never => {
      calls.push(code ?? 0);
      return undefined as never;
    }) as never;
    return {
      calls,
      restore() {
        (process as { exit: typeof orig }).exit = orig;
      },
    };
  }

  it('triggers exactly once on first signal and is removable after dispose', async () => {
    const trigger = vi.fn(() => Promise.resolve());
    const dispose = installShutdownHandlers(trigger, undefined, ['SIGUSR2']);
    process.emit('SIGUSR2', 'SIGUSR2');
    await new Promise((r) => setImmediate(r));
    expect(trigger).toHaveBeenCalledTimes(1);
    // After dispose() the handler is gone — emit again to verify.
    dispose();
    process.emit('SIGUSR2', 'SIGUSR2');
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('reports first signal kind to the onSignal callback', async () => {
    const trigger = vi.fn(() => Promise.resolve());
    const onSignal = vi.fn();
    const dispose = installShutdownHandlers(trigger, onSignal, ['SIGUSR2']);
    process.emit('SIGUSR2', 'SIGUSR2');
    await new Promise((r) => setImmediate(r));
    expect(onSignal).toHaveBeenCalledWith('SIGUSR2', 'first');
    dispose();
  });

  it('reports second signal kind on a re-emit and forces exit(1)', async () => {
    const exitMock = mockExit();
    const trigger = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const onSignal = vi.fn();
    const dispose = installShutdownHandlers(trigger, onSignal, ['SIGUSR2']);
    process.emit('SIGUSR2', 'SIGUSR2');
    await new Promise((r) => setImmediate(r));
    process.emit('SIGUSR2', 'SIGUSR2');
    // Wait long enough for the 50ms grace timer to fire.
    await new Promise((r) => setTimeout(r, 80));
    expect(onSignal).toHaveBeenCalledWith('SIGUSR2', 'second');
    expect(exitMock.calls).toContain(1);
    dispose();
    exitMock.restore();
  });

  it('exports SIGTERM + SIGINT as the default shutdown signal set', () => {
    expect(SHUTDOWN_SIGNALS).toContain('SIGTERM' as NodeJS.Signals);
    expect(SHUTDOWN_SIGNALS).toContain('SIGINT' as NodeJS.Signals);
  });
});
