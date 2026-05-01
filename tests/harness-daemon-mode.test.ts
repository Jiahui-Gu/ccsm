// T68 — harness-daemon-mode helper unit tests.
//
// Strategy
// --------
// The helper spawns a real `tsx daemon/src/index.ts` child in production
// use, but for fast unit coverage we lean on the documented `spawnFn`
// test seam to drive an in-process EventEmitter that mimics a child
// process. This keeps the suite at < 1 s wall, covers all four
// settle paths (marker, exit-before-marker, spawn error, timeout) AND
// the shutdown/kill teardown, and stays honest because the helper code
// path under test is identical (the seam only swaps the spawn call).
//
// The smoke check at the bottom does invoke `bootDaemon` against a
// trivial node script (no daemon source compile) to verify the
// real-spawn happy path end-to-end.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Helper module is plain ESM JS; vitest resolves the .mjs extension fine
// via dynamic import. Type as `any` since it ships JSDoc only.
const helperPromise = import(
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- .mjs without companion .d.ts; runtime shape covered by tests.
  '../scripts/probe-helpers/harness-daemon-mode.mjs'
);

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((sig?: NodeJS.Signals) => {
    // Mimic real ChildProcess: emit `exit` shortly after kill, with
    // code=null + signal carried through. Use queueMicrotask so callers
    // that await `exit` after kill get scheduled deterministically.
    queueMicrotask(() => {
      child.exitCode = null;
      child.signalCode = (sig ?? 'SIGTERM') as NodeJS.Signals;
      child.emit('exit', null, sig ?? 'SIGTERM');
    });
    return true;
  });
  return child;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

describe('parseHarnessMode', () => {
  it('returns "daemon" when --mode=daemon in argv', async () => {
    const { parseHarnessMode } = (await helperPromise) as { parseHarnessMode: Function };
    expect(parseHarnessMode(['--mode=daemon'], {})).toBe('daemon');
  });

  it('returns "daemon" when HARNESS_MODE=daemon in env', async () => {
    const { parseHarnessMode } = (await helperPromise) as { parseHarnessMode: Function };
    expect(parseHarnessMode([], { HARNESS_MODE: 'daemon' })).toBe('daemon');
  });

  it('argv --mode=inline overrides env HARNESS_MODE=daemon', async () => {
    const { parseHarnessMode } = (await helperPromise) as { parseHarnessMode: Function };
    expect(parseHarnessMode(['--mode=inline'], { HARNESS_MODE: 'daemon' })).toBeUndefined();
  });

  it('returns undefined when neither set', async () => {
    const { parseHarnessMode } = (await helperPromise) as { parseHarnessMode: Function };
    expect(parseHarnessMode([], {})).toBeUndefined();
  });
});

describe('bootDaemon (spawnFn seam)', () => {
  it('resolves ready when stdout emits the canonical boot marker', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const handle = bootDaemon({
      spawnFn: () => fake as unknown as ChildProcess,
      bootTimeoutMs: 1_000,
    });
    // Push the marker on stdout after the listener is attached.
    setImmediate(() => fake.stdout.emit('data', Buffer.from(`{"msg":"${DEFAULT_READY_MARKER}"}\n`)));
    await expect(handle.ready).resolves.toBeUndefined();
    // Cleanup so the test process doesn't keep a dangling fake alive.
    fake.emit('exit', 0, null);
  });

  it('resolves ready when marker comes from stderr (pino default)', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.stderr.emit('data', Buffer.from(`level=info ${DEFAULT_READY_MARKER}\n`)));
    await expect(handle.ready).resolves.toBeUndefined();
    fake.emit('exit', 0, null);
  });

  it('rejects ready when child exits before the marker fires', async () => {
    const { bootDaemon } = (await helperPromise) as { bootDaemon: Function };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.emit('exit', 17, null));
    await expect(handle.ready).rejects.toThrow(/exited before ready marker.*code=17/);
  });

  it('rejects ready on spawn error', async () => {
    const { bootDaemon } = (await helperPromise) as { bootDaemon: Function };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.emit('error', new Error('ENOENT tsx not found')));
    await expect(handle.ready).rejects.toThrow(/failed to spawn daemon: ENOENT tsx not found/);
  });

  it('rejects ready when boot timeout elapses without marker', async () => {
    const { bootDaemon } = (await helperPromise) as { bootDaemon: Function };
    const fake = makeFakeChild();
    const handle = bootDaemon({
      spawnFn: () => fake as unknown as ChildProcess,
      bootTimeoutMs: 50,
    });
    await expect(handle.ready).rejects.toThrow(/did not emit ready marker.*within 50ms/);
    fake.emit('exit', 0, null);
  });

  it('shutdown() sends SIGTERM and resolves with exit code', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n')));
    await handle.ready;
    const code = await handle.shutdown();
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
    // Fake child reports null exitCode + SIGTERM signal — same shape a
    // real signal-terminated process surfaces.
    expect(code).toBeNull();
  });

  it('kill() sends SIGKILL', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n')));
    await handle.ready;
    await handle.kill();
    expect(fake.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('shutdown() is a no-op when child already exited', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n')));
    await handle.ready;
    fake.exitCode = 0;
    fake.emit('exit', 0, null);
    const code = await handle.shutdown();
    expect(code).toBe(0);
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it('onLog tap receives child output line-by-line', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const lines: string[] = [];
    const handle = bootDaemon({
      spawnFn: () => fake as unknown as ChildProcess,
      onLog: (l: string) => lines.push(l),
    });
    setImmediate(() => {
      fake.stdout.emit('data', Buffer.from('line-a\nline-b\n'));
      fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n'));
    });
    await handle.ready;
    fake.emit('exit', 0, null);
    expect(lines).toContain('line-a');
    expect(lines).toContain('line-b');
  });
});

describe('runWithDaemonMode', () => {
  it('passes daemon=null when mode is undefined and does NOT spawn', async () => {
    const { runWithDaemonMode } = (await helperPromise) as { runWithDaemonMode: Function };
    const spawnFn = vi.fn();
    const result = await runWithDaemonMode(undefined, async (ctx: { daemon: unknown }) => {
      expect(ctx.daemon).toBeNull();
      return 'ok';
    }, { spawnFn });
    expect(result).toBe('ok');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('boots + tears down when mode=daemon', async () => {
    const { runWithDaemonMode, DEFAULT_READY_MARKER } = (await helperPromise) as {
      runWithDaemonMode: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const spawnFn = vi.fn(() => fake as unknown as ChildProcess);
    setImmediate(() => fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n')));
    const result = await runWithDaemonMode('daemon', async (ctx: { daemon: { kill: Function } | null }) => {
      expect(ctx.daemon).not.toBeNull();
      return 42;
    }, { spawnFn });
    expect(result).toBe(42);
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('still tears down even when body throws', async () => {
    const { runWithDaemonMode, DEFAULT_READY_MARKER } = (await helperPromise) as {
      runWithDaemonMode: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const spawnFn = vi.fn(() => fake as unknown as ChildProcess);
    setImmediate(() => fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n')));
    await expect(
      runWithDaemonMode('daemon', async () => { throw new Error('boom'); }, { spawnFn }),
    ).rejects.toThrow('boom');
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

// ---------------------------------------------------------------------------
// Real-process smoke test — exercises the actual `child_process.spawn` path
// against a trivial node script that prints the ready marker, sleeps, then
// exits cleanly on SIGTERM. Skipped on environments where `node` is not on
// PATH (would only matter in pathological CI sandboxes).
// ---------------------------------------------------------------------------

describe('bootDaemon (real spawn smoke)', () => {
  it('boots, marker fires, shutdown() reaps the real child', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const dir = mkdtempSync(join(tmpdir(), 'harness-daemon-mode-test-'));
    tempDirs.push(dir);
    const script = join(dir, 'fake-daemon.cjs');
    // Deliberately use a CJS .cjs script so we can spawn `node` (always
    // available) instead of `tsx` (which requires the dev dep). Also
    // wires SIGTERM to a graceful exit so `shutdown()` returns a code.
    writeFileSync(script, `
      process.on('SIGTERM', () => process.exit(0));
      process.stdout.write(${JSON.stringify(DEFAULT_READY_MARKER)} + '\\n');
      setTimeout(() => process.exit(2), 30000);
    `);
    const handle = bootDaemon({
      spawnFn: (_cmd: string, _args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) =>
        // Drop shell:true from the helper's default opts — we're spawning
        // node.exe directly with a known absolute path, no shell parsing
        // needed (and on Windows shell:true mangles the script path
        // through cmd.exe quoting rules).
        spawn(process.execPath, [script], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      bootTimeoutMs: 5_000,
    });
    await handle.ready;
    const code = await handle.shutdown();
    // On Windows .kill('SIGTERM') maps to TerminateProcess so the
    // signal handler may not run; tolerate either a clean exit (POSIX)
    // or a signal-driven null exitCode (Windows).
    expect(code === 0 || code === null).toBe(true);
  }, 15_000);
});
