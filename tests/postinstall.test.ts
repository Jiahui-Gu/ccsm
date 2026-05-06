// Unit tests for scripts/postinstall-helpers.mjs (Task #641 Layer 1).

import { describe, it, expect } from 'vitest';
import { rebuildWithRetry } from '../scripts/postinstall-helpers.mjs';

interface FakeSpawnResult {
  status: number | null;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

/** Build a spawn stub that returns a predefined queue of results. */
function queueSpawn(results: FakeSpawnResult[]) {
  const calls: Array<{ bin: string; args: string[]; opts: object }> = [];
  return {
    calls,
    spawn: (bin: string, args: string[], opts: object): FakeSpawnResult => {
      calls.push({ bin, args, opts });
      const next = results.shift();
      if (!next) throw new Error('spawn called more times than queued results');
      return next;
    },
  };
}

const noopSleep = () => { /* tests don't need to actually sleep */ };

describe('rebuildWithRetry', () => {
  it('returns immediately on first-try success', () => {
    const { spawn, calls } = queueSpawn([{ status: 0 }]);
    const r = rebuildWithRetry({
      rebuildBin: '/x/electron-rebuild',
      moduleName: 'better-sqlite3',
      cwd: '/repo',
      isWindows: true,
      allowFailure: false,
      spawn,
      sleep: noopSleep,
    });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    // Shape sanity:
    expect(calls[0]?.args).toEqual([
      '-f',
      '-o',
      'better-sqlite3',
      '--build-from-source',
    ]);
  });

  it('retries once on Windows when first attempt exits non-zero (EPERM scenario)', () => {
    const { spawn, calls } = queueSpawn([
      { status: 1 }, // EPERM-ish first try
      { status: 0 }, // retry succeeds
    ]);
    let sleepCalls = 0;
    const r = rebuildWithRetry({
      rebuildBin: '/x/electron-rebuild.cmd',
      moduleName: 'better-sqlite3',
      cwd: '/repo',
      isWindows: true,
      allowFailure: false,
      retryDelayMs: 250,
      spawn,
      sleep: (_ms) => { sleepCalls += 1; },
    });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(sleepCalls).toBe(1);
  });

  it('does NOT retry on non-Windows even if first attempt fails', () => {
    const { spawn, calls } = queueSpawn([{ status: 1 }]);
    const r = rebuildWithRetry({
      rebuildBin: '/x/electron-rebuild',
      moduleName: 'better-sqlite3',
      cwd: '/repo',
      isWindows: false,
      allowFailure: false,
      spawn,
      sleep: noopSleep,
    });
    expect(r.status).toBe(1);
    expect(r.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('does NOT retry when allowFailure=true (node-pty path with prebuild fallback)', () => {
    const { spawn, calls } = queueSpawn([{ status: 1 }]);
    const r = rebuildWithRetry({
      rebuildBin: '/x/electron-rebuild.cmd',
      moduleName: 'node-pty',
      cwd: '/repo',
      isWindows: true,
      allowFailure: true,
      spawn,
      sleep: noopSleep,
    });
    expect(r.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('returns the second-attempt failure when both attempts fail', () => {
    const { spawn } = queueSpawn([
      { status: 1 },
      { status: 2 }, // distinct code so we can verify we report the LATEST result
    ]);
    const r = rebuildWithRetry({
      rebuildBin: '/x/electron-rebuild.cmd',
      moduleName: 'better-sqlite3',
      cwd: '/repo',
      isWindows: true,
      allowFailure: false,
      spawn,
      sleep: noopSleep,
    });
    expect(r.status).toBe(2);
    expect(r.attempts).toBe(2);
  });

  it('does NOT retry on spawn error (missing bin / OOM kill / ENOENT)', () => {
    const { spawn, calls } = queueSpawn([
      { status: null, error: new Error('ENOENT') },
    ]);
    const r = rebuildWithRetry({
      rebuildBin: '/missing',
      moduleName: 'better-sqlite3',
      cwd: '/repo',
      isWindows: true,
      allowFailure: false,
      spawn,
      sleep: noopSleep,
    });
    expect(r.error?.message).toBe('ENOENT');
    expect(r.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('does NOT retry when killed by signal (user ^C)', () => {
    const { spawn } = queueSpawn([{ status: null, signal: 'SIGINT' }]);
    const r = rebuildWithRetry({
      rebuildBin: '/x/electron-rebuild.cmd',
      moduleName: 'better-sqlite3',
      cwd: '/repo',
      isWindows: true,
      allowFailure: false,
      spawn,
      sleep: noopSleep,
    });
    expect(r.signal).toBe('SIGINT');
    expect(r.attempts).toBe(1);
  });
});
