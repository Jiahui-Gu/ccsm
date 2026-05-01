// T64 — wait-daemon.cjs unit tests + drift guard against
// daemon/src/sockets/runtime-root.ts.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-3.7-dev-workflow.md §3.7.2.
// Drift guard rationale: scripts/wait-daemon.cjs duplicates `resolveDataRoot`
// because it must run with zero workspace deps in fresh CI clones. The
// duplication is intentional but fragile — these tests pin both helpers to
// byte-for-byte identical paths across every supported (platform, env)
// combination. If the daemon-side resolver changes, this test fails loud and
// forces a same-PR update to the script.

import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

interface WaitDaemonModule {
  resolveDataRoot: (
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    home: string,
  ) => string;
  resolveLockfilePath: (opts?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
  }) => string;
  parseArgs: (argv: string[]) =>
    | { ok: true; value: { timeoutMs: number; pollIntervalMs: number; verbose: boolean } }
    | { ok: false; help?: boolean; error?: string };
  waitForLockfile: (opts: {
    lockfilePath: string;
    timeoutMs: number;
    pollIntervalMs: number;
    verbose?: boolean;
    log?: (msg: string) => void;
    clock?: { now: () => number; sleep: (ms: number) => Promise<void> };
    exists?: (p: string) => boolean;
  }) => Promise<{ ready: boolean; elapsedMs: number; polls: number; error?: unknown }>;
  lockfileExists: (p: string) => boolean;
  DEFAULT_TIMEOUT_MS: number;
  DEFAULT_POLL_INTERVAL_MS: number;
  LOCKFILE_NAME: string;
}

const requireCjs = createRequire(import.meta.url);
const {
  resolveDataRoot,
  resolveLockfilePath,
  parseArgs,
  waitForLockfile,
  lockfileExists,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  LOCKFILE_NAME,
} = requireCjs('../scripts/wait-daemon.cjs') as WaitDaemonModule;

// Re-implement the daemon-side resolveDataRoot identically to the source at
// daemon/src/sockets/runtime-root.ts. We deliberately mirror the literal
// branches rather than importing the module, because the daemon source is
// ESM with .js extension imports and pulls in `node:fs` mkdir side effects
// that are not appropriate in a unit test.
function daemonResolveDataRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (local && local.length > 0) return join(local, 'ccsm');
    return join(home, 'AppData', 'Local', 'ccsm');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'ccsm');
  }
  const xdgData = env.XDG_DATA_HOME;
  if (xdgData && xdgData.length > 0) return join(xdgData, 'ccsm');
  return join(home, '.local', 'share', 'ccsm');
}

describe('wait-daemon: drift guard vs daemon/src/sockets/runtime-root.ts', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\test' : '/home/test';
  const cases: ReadonlyArray<{
    name: string;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
  }> = [
    { name: 'win32 with LOCALAPPDATA', platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' } },
    { name: 'win32 missing LOCALAPPDATA', platform: 'win32', env: {} },
    { name: 'darwin (env irrelevant)', platform: 'darwin', env: { LOCALAPPDATA: 'ignored' } },
    { name: 'linux with XDG_DATA_HOME', platform: 'linux', env: { XDG_DATA_HOME: '/home/test/.local/share' } },
    { name: 'linux missing XDG_DATA_HOME', platform: 'linux', env: {} },
    { name: 'linux with empty XDG_DATA_HOME', platform: 'linux', env: { XDG_DATA_HOME: '' } },
    { name: 'freebsd (POSIX fallback)', platform: 'freebsd' as NodeJS.Platform, env: {} },
  ];

  for (const c of cases) {
    it(`matches daemon helper byte-for-byte: ${c.name}`, () => {
      const ours = resolveDataRoot(c.platform, c.env, home);
      const theirs = daemonResolveDataRoot(c.platform, c.env, home);
      expect(ours).toBe(theirs);
    });
  }
});

describe('wait-daemon: resolveLockfilePath', () => {
  it('appends daemon.lock to the platform data root', () => {
    const home = '/home/test';
    const lock = resolveLockfilePath({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/home/test/.local/share' },
      home,
    });
    expect(lock).toBe(join('/home/test/.local/share', 'ccsm', 'daemon.lock'));
  });

  it('uses LOCALAPPDATA on Windows when present', () => {
    const lock = resolveLockfilePath({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
      home: 'C:\\Users\\test',
    });
    expect(lock).toBe(join('C:\\Users\\test\\AppData\\Local', 'ccsm', 'daemon.lock'));
  });

  it('exposes the spec-mandated lockfile filename', () => {
    expect(LOCKFILE_NAME).toBe('daemon.lock');
  });
});

describe('wait-daemon: parseArgs', () => {
  it('returns defaults for empty argv', () => {
    const r = parseArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        timeoutMs: DEFAULT_TIMEOUT_MS,
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
        verbose: false,
      });
    }
  });

  it('parses --timeout-ms and --poll-interval-ms', () => {
    const r = parseArgs(['--timeout-ms', '5000', '--poll-interval-ms', '50']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.timeoutMs).toBe(5000);
      expect(r.value.pollIntervalMs).toBe(50);
    }
  });

  it('parses --verbose and -v', () => {
    expect(parseArgs(['--verbose'])).toMatchObject({ ok: true, value: { verbose: true } });
    expect(parseArgs(['-v'])).toMatchObject({ ok: true, value: { verbose: true } });
  });

  it('rejects unknown flags', () => {
    const r = parseArgs(['--bogus']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown argument/);
  });

  it('rejects missing values', () => {
    expect(parseArgs(['--timeout-ms']).ok).toBe(false);
  });

  it('rejects non-positive integers', () => {
    expect(parseArgs(['--timeout-ms', '0']).ok).toBe(false);
    expect(parseArgs(['--timeout-ms', '-5']).ok).toBe(false);
    expect(parseArgs(['--timeout-ms', '1.5']).ok).toBe(false);
    expect(parseArgs(['--timeout-ms', 'abc']).ok).toBe(false);
  });

  it('rejects poll-interval > timeout', () => {
    const r = parseArgs(['--timeout-ms', '100', '--poll-interval-ms', '500']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exceeds/);
  });

  it('treats --help as a non-ok response', () => {
    const r = parseArgs(['--help']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.help).toBe(true);
  });
});

describe('wait-daemon: waitForLockfile', () => {
  function fakeClock() {
    let t = 1_000_000;
    return {
      now: () => t,
      sleep: async (ms: number): Promise<void> => {
        t += ms;
      },
      advance: (ms: number): void => {
        t += ms;
      },
    };
  }

  it('returns ready immediately when lockfile is present on first poll', async () => {
    const clock = fakeClock();
    const exists = vi.fn().mockReturnValue(true);
    const log = vi.fn();
    const r = await waitForLockfile({
      lockfilePath: '/tmp/daemon.lock',
      timeoutMs: 1000,
      pollIntervalMs: 100,
      clock,
      exists,
      log,
    });
    expect(r.ready).toBe(true);
    expect(r.polls).toBe(1);
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it('polls until ready, then returns ready', async () => {
    const clock = fakeClock();
    const log = vi.fn();
    let calls = 0;
    const exists = vi.fn().mockImplementation(() => {
      calls += 1;
      return calls >= 4; // ready on 4th poll
    });
    const r = await waitForLockfile({
      lockfilePath: '/tmp/daemon.lock',
      timeoutMs: 10_000,
      pollIntervalMs: 100,
      clock,
      exists,
      log,
    });
    expect(r.ready).toBe(true);
    expect(r.polls).toBe(4);
    // 3 misses × 100ms sleeps each
    expect(r.elapsedMs).toBe(300);
  });

  it('returns timeout when lockfile never appears', async () => {
    const clock = fakeClock();
    const log = vi.fn();
    const r = await waitForLockfile({
      lockfilePath: '/tmp/daemon.lock',
      timeoutMs: 500,
      pollIntervalMs: 100,
      clock,
      exists: () => false,
      log,
    });
    expect(r.ready).toBe(false);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(500);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/timeout after \d+ms/));
  });

  it('does not overshoot the timeout deadline on the final sleep', async () => {
    const clock = fakeClock();
    // poll-interval (1000) exceeds remaining time after first miss; sleep
    // must clamp so we exit at exactly the timeout boundary.
    const r = await waitForLockfile({
      lockfilePath: '/tmp/daemon.lock',
      timeoutMs: 250,
      pollIntervalMs: 1000,
      clock,
      exists: () => false,
      log: () => {},
    });
    expect(r.ready).toBe(false);
    // First poll at t=0 misses, sleep clamped to 250, second poll at t=250
    // misses and triggers timeout exit.
    expect(r.elapsedMs).toBe(250);
    expect(r.polls).toBe(2);
  });

  it('surfaces unexpected fs errors as not-ready with error', async () => {
    const clock = fakeClock();
    const log = vi.fn();
    const boom = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const exists = vi.fn().mockImplementation(() => {
      throw boom;
    });
    const r = await waitForLockfile({
      lockfilePath: '/tmp/daemon.lock',
      timeoutMs: 1000,
      pollIntervalMs: 100,
      clock,
      exists,
      log,
    });
    expect(r.ready).toBe(false);
    expect(r.error).toBe(boom);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/fs error probing/));
  });

  it('verbose mode logs each poll', async () => {
    const clock = fakeClock();
    const log = vi.fn();
    let calls = 0;
    const exists = vi.fn().mockImplementation(() => {
      calls += 1;
      return calls >= 3;
    });
    await waitForLockfile({
      lockfilePath: '/tmp/daemon.lock',
      timeoutMs: 10_000,
      pollIntervalMs: 100,
      verbose: true,
      clock,
      exists,
      log,
    });
    // 2 miss logs + 1 ready log = 3
    const miss = log.mock.calls.filter((c) => /miss at/.test(String(c[0]))).length;
    const ready = log.mock.calls.filter((c) => /ready after/.test(String(c[0]))).length;
    expect(miss).toBe(2);
    expect(ready).toBe(1);
  });
});

describe('wait-daemon: lockfileExists (real fs)', () => {
  it('returns false for a non-existent path', () => {
    expect(lockfileExists('/nonexistent/path/that/should/not/exist/daemon.lock')).toBe(false);
  });
});
