import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mock child_process *before* importing the spawner. We use a
// hoisted holder so the test file can grab the same vi.fn() instance
// the spawner sees.
const { mockSpawnFn } = vi.hoisted(() => ({ mockSpawnFn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mockSpawnFn, default: { ...actual, spawn: mockSpawnFn } };
});
// Force the resolver path to never be hit (we always pass binaryPath).
vi.mock('../binary-resolver', () => ({
  resolveClaudeBinary: vi.fn(async () => '/should/not/be/called'),
}));

import { spawnClaude, buildSpawnArgs, buildSpawnEnv } from '../claude-spawner';

const mockedSpawn = mockSpawnFn;

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  ee.stdin = new PassThrough();
  ee.pid = 4242;
  ee.exitCode = null;
  ee.kill = vi.fn(() => true);
  return ee;
}

beforeEach(() => {
  mockedSpawn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildSpawnArgs', () => {
  it('always includes stream-json IO and verbose, in the documented order', () => {
    const args = buildSpawnArgs({});
    expect(args.slice(0, 5)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
    ]);
  });

  it('appends --resume <id> when resumeId is set', () => {
    const args = buildSpawnArgs({ resumeId: 'sess_abc' });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess_abc');
  });

  it('appends --permission-mode and --model when provided', () => {
    const args = buildSpawnArgs({
      permissionMode: 'acceptEdits',
      model: 'sonnet',
    });
    expect(args.join(' ')).toContain('--permission-mode acceptEdits');
    expect(args.join(' ')).toContain('--model sonnet');
  });

  it('omits optional flags when not provided', () => {
    const args = buildSpawnArgs({});
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--model');
  });
});

describe('buildSpawnEnv', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    // Restore anything we mutated below.
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it('preserves PATH and drops NODE_OPTIONS / ELECTRON_RUN_AS_NODE', () => {
    process.env.PATH = '/usr/local/bin:/usr/bin';
    process.env.NODE_OPTIONS = '--max-old-space-size=8192';
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.SOME_RANDOM_PARENT_VAR = 'leak';

    const env = buildSpawnEnv({ configDir: '/tmp/cfg' });
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    // Deny-by-default: untrusted parent vars do not leak.
    expect(env.SOME_RANDOM_PARENT_VAR).toBeUndefined();
  });

  it('injects CLAUDE_CONFIG_DIR and CLAUDE_CODE_ENTRYPOINT', () => {
    const env = buildSpawnEnv({ configDir: '/tmp/cfg' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/cfg');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('agentory-desktop');
  });

  it('passes through envOverrides (auth / base url) and lets them win over baseline', () => {
    const env = buildSpawnEnv({
      configDir: '/tmp/cfg',
      envOverrides: {
        ANTHROPIC_BASE_URL: 'https://gw.example.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-test',
        CLAUDE_CODE_SKIP_AUTH_LOGIN: 'true',
        CLAUDE_CODE_ENTRYPOINT: 'agentory-test',
      },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.example.com');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
    expect(env.CLAUDE_CODE_SKIP_AUTH_LOGIN).toBe('true');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('agentory-test');
  });

  it('strips NODE_OPTIONS even if smuggled in via envOverrides', () => {
    const env = buildSpawnEnv({
      configDir: '/tmp/cfg',
      envOverrides: { NODE_OPTIONS: '--inspect' },
    });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});

describe('spawnClaude', () => {
  it('refuses to spawn without configDir', async () => {
    await expect(
      // @ts-expect-error - intentionally missing configDir
      spawnClaude({ cwd: '/work', binaryPath: '/x/claude' })
    ).rejects.toThrow(/configDir is required/);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('spawns with the documented argv, windowsHide, no shell, all-pipe stdio', async () => {
    mockedSpawn.mockImplementation(() => makeFakeChild());

    await spawnClaude({
      cwd: '/work',
      configDir: '/tmp/cfg',
      binaryPath: '/usr/local/bin/claude',
      resumeId: 'sess_xyz',
      permissionMode: 'plan',
      model: 'sonnet',
    });

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = mockedSpawn.mock.calls[0];
    expect(bin).toBe('/usr/local/bin/claude');
    const argvJoined = (argv as string[]).join(' ');
    expect(argvJoined).toContain('--output-format stream-json');
    expect(argvJoined).toContain('--verbose');
    expect(argvJoined).toContain('--input-format stream-json');
    expect(argvJoined).toContain('--resume sess_xyz');
    expect(argvJoined).toContain('--permission-mode plan');
    expect(argvJoined).toContain('--model sonnet');
    expect(opts).toMatchObject({
      cwd: '/work',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
  });

  it('builds env with overrides + CLAUDE_CONFIG_DIR + drops NODE_OPTIONS', async () => {
    process.env.NODE_OPTIONS = '--inspect';
    process.env.PATH = process.env.PATH ?? '/usr/bin';
    mockedSpawn.mockImplementation(() => makeFakeChild());

    await spawnClaude({
      cwd: '/work',
      configDir: '/tmp/cfg',
      binaryPath: '/x/claude',
      envOverrides: { ANTHROPIC_BASE_URL: 'https://gw' },
    });

    const opts = mockedSpawn.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/tmp/cfg');
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://gw');
    expect(opts.env.NODE_OPTIONS).toBeUndefined();
    expect(opts.env.PATH).toBeTruthy();

    delete process.env.NODE_OPTIONS;
  });

  it('exposes pid + stdio streams on the returned ClaudeProcess', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockImplementation(() => fake);

    const cp = await spawnClaude({
      cwd: '/work',
      configDir: '/tmp/cfg',
      binaryPath: '/x/claude',
    });
    expect(cp.pid).toBe(fake.pid);
    expect(cp.stdout).toBe(fake.stdout);
    expect(cp.stderr).toBe(fake.stderr);
    expect(cp.stdin).toBe(fake.stdin);
  });

  it('wait() resolves with the exit code/signal, never rejects', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockImplementation(() => fake);

    const cp = await spawnClaude({
      cwd: '/w',
      configDir: '/c',
      binaryPath: '/x/claude',
    });
    setImmediate(() => fake.emit('exit', 0, null));
    await expect(cp.wait()).resolves.toEqual({ code: 0, signal: null });
  });

  it('wait() yields code -1 when child errors before exit', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockImplementation(() => fake);

    const cp = await spawnClaude({
      cwd: '/w',
      configDir: '/c',
      binaryPath: '/x/claude',
    });
    setImmediate(() => fake.emit('error', new Error('ENOENT')));
    await expect(cp.wait()).resolves.toEqual({ code: -1, signal: null });
  });

  it('AbortSignal triggers SIGTERM, then SIGKILL after the grace period', async () => {
    vi.useFakeTimers();
    const fake = makeFakeChild();
    mockedSpawn.mockImplementation(() => fake);

    const ac = new AbortController();
    const cp = await spawnClaude({
      cwd: '/w',
      configDir: '/c',
      binaryPath: '/x/claude',
      signal: ac.signal,
      killGracePeriodMs: 100,
    });
    expect(cp).toBeTruthy();

    ac.abort();
    // The microtask queue needs to drain for the abort handler to fire.
    await Promise.resolve();
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');

    // Child still alive after grace period -> SIGKILL.
    vi.advanceTimersByTime(150);
    expect(fake.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kill() is idempotent after exit', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockImplementation(() => fake);

    const cp = await spawnClaude({
      cwd: '/w',
      configDir: '/c',
      binaryPath: '/x/claude',
    });
    fake.emit('exit', 0, null);
    await cp.wait();
    cp.kill('SIGTERM');
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it('aborting an already-aborted signal still kills the child', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockImplementation(() => fake);

    const ac = new AbortController();
    ac.abort();
    await spawnClaude({
      cwd: '/w',
      configDir: '/c',
      binaryPath: '/x/claude',
      signal: ac.signal,
    });
    // queueMicrotask is used in the impl; flush it.
    await Promise.resolve();
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
