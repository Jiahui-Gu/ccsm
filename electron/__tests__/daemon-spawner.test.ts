// Unit tests for electron/daemon-spawner.ts (Task #597 / spec PR-3).
//
// Coverage targets (4 cases per spec):
//   1. success — daemon prints `PORT=<n>\n`, spawnDaemon resolves with n.
//   2. timeout — daemon never prints; READY_TIMEOUT_MS elapses; reject
//      with DaemonSpawnError(kind: 'timeout') and child SIGKILL'd.
//   3. typed-err (bad-port-line) — daemon prints garbage on stdout;
//      reject with DaemonSpawnError(kind: 'bad-port-line').
//   4. kill-cleanup — killDaemon() sends SIGTERM, clears module state so
//      a follow-up spawnDaemon() returns a fresh promise.
//
// We mock `child_process.spawn` with an in-memory ChildProcess stub
// driven by EventEmitter + Readable streams (PassThrough). Real spawn
// would shell out to `node` / the daemon binary — too slow + flaky for
// UT; the contract we own is the parsing/timeout/typed-error logic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// --- spawn() mock ----------------------------------------------------------
//
// Each test pushes a fake ChildProcess onto `nextChild` before calling
// spawnDaemon(). The mock pops it, returns it, records the spawn call
// args. If nextChild is empty the mock throws — surfaces test wiring
// bugs rather than silently spawning a real process.

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

const spawnCalls: Array<{
  cmd: string;
  args: ReadonlyArray<string>;
  opts: Record<string, unknown>;
}> = [];
const nextChild: FakeChild[] = [];

vi.mock('child_process', () => {
  const fakeSpawn = (
    cmd: string,
    args: ReadonlyArray<string>,
    opts: Record<string, unknown>,
  ) => {
    spawnCalls.push({ cmd, args, opts });
    const fc = nextChild.shift();
    if (!fc) {
      throw new Error('test bug: no fake child queued');
    }
    return fc;
  };
  return {
    spawn: fakeSpawn,
    default: { spawn: fakeSpawn },
  };
});

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  // Use raw EventEmitters (not Readable streams) so test code can drive
  // `data` events synchronously via .emit() without depending on
  // setImmediate / process.nextTick — both of which behave differently
  // under vi.useFakeTimers().
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  // The production code calls stdout.removeListener('data', onStdout) and
  // re-attaches a passthrough; EventEmitter supports both.
  ee.kill = vi.fn(() => true);
  return ee;
}

// Defer require to AFTER the vi.mock call so the spawn mock is in place.
// We use dynamic import inside beforeEach to also reset module state via
// vi.resetModules() between cases — daemon-spawner has module-level
// `child / port / readyPromise` singletons.
let mod: typeof import('../daemon-spawner');

beforeEach(async () => {
  vi.useFakeTimers();
  spawnCalls.length = 0;
  nextChild.length = 0;
  vi.resetModules();
  mod = await import('../daemon-spawner');
  mod.__resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('spawnDaemon', () => {
  it('case 1: resolves with port when daemon emits PORT=<n>', async () => {
    const fc = makeFakeChild();
    nextChild.push(fc);

    const p = mod.spawnDaemon();
    // Daemon prints PORT line on the next microtask, after spawnDaemon
    // has wired up the .on('data') listener.
    await Promise.resolve();
    fc.stdout.emit('data', Buffer.from('PORT=54321\n', 'utf8'));

    const port = await p;
    expect(port).toBe(54321);
    expect(mod.getDaemonPort()).toBe(54321);
    // Verify spawn was called with our env contract.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].opts).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('case 2: rejects with kind=timeout + SIGKILLs child after READY_TIMEOUT_MS', async () => {
    const fc = makeFakeChild();
    nextChild.push(fc);

    const p = mod.spawnDaemon();
    // Don't emit anything on stdout. Advance fake timers past 10s.
    let caught: unknown = null;
    p.catch((e) => {
      caught = e;
    });

    await vi.advanceTimersByTimeAsync(mod.READY_TIMEOUT_MS + 50);
    // Microtask flush so the .catch above latches.
    await Promise.resolve();

    expect(caught).toBeInstanceOf(mod.DaemonSpawnError);
    const err = caught as InstanceType<typeof mod.DaemonSpawnError>;
    expect(err.kind).toBe('timeout');
    expect(err.detail.timeoutMs).toBe(mod.READY_TIMEOUT_MS);
    // Child must have been SIGKILL'd (not SIGTERM — wedged daemons may
    // not honor SIGTERM during startup).
    expect(fc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mod.getDaemonPort()).toBeNull();
  });

  it('case 3: rejects with typed DaemonSpawnError(kind=bad-port-line) on garbage stdout', async () => {
    const fc = makeFakeChild();
    nextChild.push(fc);

    const p = mod.spawnDaemon();
    // Capture rejection but don't await yet — we'll inspect after.
    const recorded = p.catch((e) => e);
    await Promise.resolve();
    fc.stdout.emit('data', Buffer.from('hello world\n', 'utf8'));

    const err = (await recorded) as InstanceType<typeof mod.DaemonSpawnError>;
    expect(err).toBeInstanceOf(mod.DaemonSpawnError);
    expect(err.kind).toBe('bad-port-line');
    expect(err.detail.line).toBe('hello world');
  });

  it('case 4: killDaemon() SIGTERMs child + resets module state so next spawn is fresh', async () => {
    // First spawn → success.
    const fc1 = makeFakeChild();
    nextChild.push(fc1);

    const p1 = mod.spawnDaemon();
    await Promise.resolve();
    fc1.stdout.emit('data', Buffer.from('PORT=12345\n', 'utf8'));
    await p1;
    expect(mod.getDaemonPort()).toBe(12345);

    // Kill — should SIGTERM and reset module state.
    mod.killDaemon();
    expect(fc1.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mod.getDaemonPort()).toBeNull();

    // Second spawn must NOT return the cached promise — it must spawn
    // a new child. We queue a new fake child and verify spawnCalls grew.
    const fc2 = makeFakeChild();
    nextChild.push(fc2);
    const p2 = mod.spawnDaemon();
    await Promise.resolve();
    fc2.stdout.emit('data', Buffer.from('PORT=23456\n', 'utf8'));
    const port2 = await p2;
    expect(port2).toBe(23456);
    expect(spawnCalls).toHaveLength(2);
  });

  // Task #639 — child exits non-zero before PORT line. This is the new
  // hard-fail path: a critical startup module (initDb in
  // daemon/startup/data.ts) threw, runStartup printed FATAL to stderr
  // and called process.exit(1) BEFORE binding the HTTP server. The
  // parent never sees PORT, so spawnDaemon must reject with the new
  // DaemonHardFailError carrying the exit code + stderr tail so the
  // electron host can render it inside the hard-fail startup screen.
  it('case 5 (Task #639): rejects with DaemonHardFailError when child exits non-zero before PORT, with stderr tail', async () => {
    const fc = makeFakeChild();
    nextChild.push(fc);

    const p = mod.spawnDaemon();
    const recorded = p.catch((e) => e);
    await Promise.resolve();
    // Daemon prints FATAL banner to stderr, then exits 1 — no PORT line.
    fc.stderr.emit(
      'data',
      Buffer.from('[daemon] FATAL: critical startup module 50-data.js threw\n', 'utf8'),
    );
    fc.stderr.emit(
      'data',
      Buffer.from('[daemon] FATAL reason: Error: CCSM_TEST_BREAK_DB=1 (forced)\n', 'utf8'),
    );
    fc.emit('exit', 1, null);

    const err = (await recorded) as InstanceType<typeof mod.DaemonHardFailError>;
    expect(err).toBeInstanceOf(mod.DaemonHardFailError);
    expect(err).toBeInstanceOf(mod.DaemonSpawnError);
    expect(err.kind).toBe('hard-fail');
    expect(err.exitCode).toBe(1);
    expect(err.stderrTail).toContain('FATAL');
    expect(err.stderrTail).toContain('CCSM_TEST_BREAK_DB');
    expect(mod.getDaemonPort()).toBeNull();
  });

  // Task #639 — distinguish timeout from hard-fail. A wedged daemon
  // (no exit, no PORT) is different from one that explicitly bailed
  // out — they need different UX. Pin the discriminator.
  it('case 6 (Task #639): timeout returns DaemonSpawnTimeoutError, NOT hard-fail', async () => {
    const fc = makeFakeChild();
    nextChild.push(fc);

    const p = mod.spawnDaemon();
    const recorded = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(mod.READY_TIMEOUT_MS + 50);
    await Promise.resolve();

    const err = (await recorded) as InstanceType<typeof mod.DaemonSpawnTimeoutError>;
    expect(err).toBeInstanceOf(mod.DaemonSpawnTimeoutError);
    expect(err).not.toBeInstanceOf(mod.DaemonHardFailError);
    expect(err.kind).toBe('timeout');
    expect(err.timeoutMs).toBe(mod.READY_TIMEOUT_MS);
  });

  // Task #639 — exit code 0 before PORT is NOT hard-fail (daemon shut
  // down cleanly without bringing up its HTTP server, which is weird
  // but not a critical-init failure). Stays as the legacy 'early-exit'
  // kind so callers can branch correctly.
  it('case 7 (Task #639): exit code 0 before PORT stays as early-exit, not hard-fail', async () => {
    const fc = makeFakeChild();
    nextChild.push(fc);

    const p = mod.spawnDaemon();
    const recorded = p.catch((e) => e);
    await Promise.resolve();
    fc.emit('exit', 0, null);

    const err = (await recorded) as InstanceType<typeof mod.DaemonSpawnError>;
    expect(err).toBeInstanceOf(mod.DaemonSpawnError);
    expect(err).not.toBeInstanceOf(mod.DaemonHardFailError);
    expect(err.kind).toBe('early-exit');
  });
});
