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
// classifyInvocation is preserved from the real module so paths without
// .cmd/.exe suffixes pass through as `direct` invocations.
vi.mock('../binary-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../binary-resolver')>();
  return {
    ...actual,
    resolveClaudeBinary: vi.fn(async () => '/should/not/be/called'),
    resolveClaudeInvocation: vi.fn(async () => ({
      kind: 'direct' as const,
      path: '/should/not/be/called',
    })),
  };
});

import { spawnClaude, buildSpawnArgs, buildSpawnEnv, __test__ } from '../claude-spawner';

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

  it('always includes --permission-prompt-tool stdio so claude.exe delegates can_use_tool over the IPC bridge', () => {
    const args = buildSpawnArgs({});
    expect(args.join(' ')).toContain('--permission-prompt-tool stdio');
    // And the value is the literal "stdio" — that's the magic token the CLI
    // recognises (any other string would be treated as an MCP tool name and
    // make spawn fail at first use). Don't accidentally i18n / format this.
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
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
    const argvArr = argv as string[];
    const argvJoined = argvArr.join(' ');
    expect(argvJoined).toContain('--output-format stream-json');
    expect(argvJoined).toContain('--verbose');
    expect(argvJoined).toContain('--input-format stream-json');
    expect(argvJoined).toContain('--permission-prompt-tool stdio');
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

  it('does not call SIGKILL when the child exits cleanly inside the grace window', async () => {
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
    await Promise.resolve();
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');

    // Child exits on its own before the kill timer fires.
    fake.emit('exit', 0, 'SIGTERM');
    vi.advanceTimersByTime(500);
    expect(fake.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('captures the tail of stderr into an in-memory ring (~8KB cap)', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockImplementation(() => fake);

    const cp = await spawnClaude({
      cwd: '/w',
      configDir: '/c',
      binaryPath: '/x/claude',
    });

    // Write a small auth-error-shaped message and a much larger blob to
    // verify trimming.
    fake.stderr.write('error: invalid api key\n');
    const big = Buffer.alloc(__test__.STDERR_RING_BYTES * 3, 0x41); // 'A'
    fake.stderr.write(big);
    // Allow the data event to flush.
    await new Promise((r) => setImmediate(r));

    const tail = cp.getRecentStderr();
    expect(tail.length).toBeLessThanOrEqual(__test__.STDERR_RING_BYTES);
    // The most recent bytes should be the 'A' fill.
    expect(tail.endsWith('A')).toBe(true);
    // And the early auth-error message should have been evicted.
    expect(tail.includes('invalid api key')).toBe(false);
  });

  it('returns an empty stderr tail when the child wrote nothing', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockImplementation(() => fake);

    const cp = await spawnClaude({
      cwd: '/w',
      configDir: '/c',
      binaryPath: '/x/claude',
    });
    expect(cp.getRecentStderr()).toBe('');
  });

  it('multiple abort() calls on the same signal only fire SIGTERM once', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockImplementation(() => fake);

    const ac = new AbortController();
    await spawnClaude({
      cwd: '/w',
      configDir: '/c',
      binaryPath: '/x/claude',
      signal: ac.signal,
    });
    ac.abort();
    ac.abort(); // no-op on AbortController, but defend in any case
    await Promise.resolve();
    const sigtermCalls = fake.kill.mock.calls.filter((c) => c[0] === 'SIGTERM');
    expect(sigtermCalls).toHaveLength(1);
  });
});

describe('SAFE_ENV whitelist', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
  });

  // Windows iterates env with case-folded keys (`process.env.ComSpec` is
  // returned as `COMSPEC` in Object.entries on Win11). Since the env we
  // pass to the child preserves whatever case we got, we look up by ci
  // for cross-platform tests.
  const ci = (env: NodeJS.ProcessEnv, k: string): string | undefined => {
    const lk = k.toLowerCase();
    for (const [ek, ev] of Object.entries(env)) {
      if (ek.toLowerCase() === lk) return ev;
    }
    return undefined;
  };

  it('passes enterprise-required Windows env (HOMEDRIVE/HOMEPATH/USERDOMAIN/COMPUTERNAME)', () => {
    process.env.HOMEDRIVE = 'C:';
    process.env.HOMEPATH = '\\Users\\test';
    process.env.USERDOMAIN = 'CORP';
    process.env.COMPUTERNAME = 'WORKSTATION-1';
    const env = buildSpawnEnv({ configDir: '/cfg' });
    expect(ci(env, 'HOMEDRIVE')).toBe('C:');
    expect(ci(env, 'HOMEPATH')).toBe('\\Users\\test');
    expect(ci(env, 'USERDOMAIN')).toBe('CORP');
    expect(ci(env, 'COMPUTERNAME')).toBe('WORKSTATION-1');
  });

  it('passes nvm/fnm/volta toolchain env via prefix match', () => {
    process.env.NVM_DIR = '/home/u/.nvm';
    process.env.FNM_DIR = '/home/u/.fnm';
    process.env.FNM_MULTISHELL_PATH = '/tmp/fnm_multishell';
    process.env.VOLTA_HOME = '/home/u/.volta';
    const env = buildSpawnEnv({ configDir: '/cfg' });
    expect(ci(env, 'NVM_DIR')).toBe('/home/u/.nvm');
    expect(ci(env, 'FNM_DIR')).toBe('/home/u/.fnm');
    expect(ci(env, 'FNM_MULTISHELL_PATH')).toBe('/tmp/fnm_multishell');
    expect(ci(env, 'VOLTA_HOME')).toBe('/home/u/.volta');
  });

  it('passes the entire LC_* family via prefix match', () => {
    process.env.LC_MESSAGES = 'zh_CN.UTF-8';
    process.env.LC_TIME = 'en_US.UTF-8';
    process.env.LC_NUMERIC = 'C';
    const env = buildSpawnEnv({ configDir: '/cfg' });
    expect(ci(env, 'LC_MESSAGES')).toBe('zh_CN.UTF-8');
    expect(ci(env, 'LC_TIME')).toBe('en_US.UTF-8');
    expect(ci(env, 'LC_NUMERIC')).toBe('C');
  });

  it('passes npm config (NPM_CONFIG_* and npm_config_*) via prefix', () => {
    process.env.NPM_CONFIG_PREFIX = '/usr/local';
    process.env.npm_config_registry = 'https://registry.npmjs.org/';
    const env = buildSpawnEnv({ configDir: '/cfg' });
    expect(ci(env, 'NPM_CONFIG_PREFIX')).toBe('/usr/local');
    expect(ci(env, 'npm_config_registry')).toBe('https://registry.npmjs.org/');
  });

  it('passes proxy + SSL + SSH-agent env', () => {
    process.env.ALL_PROXY = 'socks://10.0.0.1:1080';
    process.env.all_proxy = 'socks://10.0.0.1:1080';
    process.env.SSL_CERT_FILE = '/etc/ssl/cert.pem';
    process.env.SSL_CERT_DIR = '/etc/ssl/certs';
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-XXX/agent.123';
    process.env.SSH_AGENT_PID = '12345';
    const env = buildSpawnEnv({ configDir: '/cfg' });
    expect(ci(env, 'ALL_PROXY')).toBe('socks://10.0.0.1:1080');
    expect(ci(env, 'all_proxy')).toBe('socks://10.0.0.1:1080');
    expect(ci(env, 'SSL_CERT_FILE')).toBe('/etc/ssl/cert.pem');
    expect(ci(env, 'SSL_CERT_DIR')).toBe('/etc/ssl/certs');
    expect(ci(env, 'SSH_AUTH_SOCK')).toBe('/tmp/ssh-XXX/agent.123');
    expect(ci(env, 'SSH_AGENT_PID')).toBe('12345');
  });

  it('passes Windows ProgramFiles* via prefix match', () => {
    process.env.ProgramFiles = 'C:\\Program Files';
    process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
    process.env.CommonProgramFiles = 'C:\\Program Files\\Common Files';
    const env = buildSpawnEnv({ configDir: '/cfg' });
    expect(ci(env, 'ProgramFiles')).toBe('C:\\Program Files');
    expect(ci(env, 'ProgramFiles(x86)')).toBe('C:\\Program Files (x86)');
    expect(ci(env, 'CommonProgramFiles')).toBe('C:\\Program Files\\Common Files');
  });

  it('still drops NODE_OPTIONS even when smuggled via process.env', () => {
    process.env.NODE_OPTIONS = '--inspect';
    const env = buildSpawnEnv({ configDir: '/cfg' });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('drops random parent vars not on the whitelist', () => {
    process.env.SOME_VENDOR_SECRET = 'leak';
    process.env.RANDOM_THING = 'no';
    const env = buildSpawnEnv({ configDir: '/cfg' });
    expect(env.SOME_VENDOR_SECRET).toBeUndefined();
    expect(env.RANDOM_THING).toBeUndefined();
  });

  it('forwards ANTHROPIC_* credentials + endpoint configuration from parent env', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com';
    process.env.ANTHROPIC_API_KEY = 'sk-parent-api';
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-parent-auth';
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'haiku-local';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'sonnet-local';
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'opus-local';
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'fast-local';
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Org: foo';
    const env = buildSpawnEnv({ configDir: '/cfg' });
    expect(ci(env, 'ANTHROPIC_BASE_URL')).toBe('https://gateway.example.com');
    expect(ci(env, 'ANTHROPIC_API_KEY')).toBe('sk-parent-api');
    expect(ci(env, 'ANTHROPIC_AUTH_TOKEN')).toBe('sk-parent-auth');
    expect(ci(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL')).toBe('haiku-local');
    expect(ci(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL')).toBe('sonnet-local');
    expect(ci(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL')).toBe('opus-local');
    expect(ci(env, 'ANTHROPIC_SMALL_FAST_MODEL')).toBe('fast-local');
    expect(ci(env, 'ANTHROPIC_CUSTOM_HEADERS')).toBe('X-Org: foo');
  });

  it('forwards CLAUDE_CODE_* runtime flags (Bedrock/Vertex) from parent env', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    process.env.CLAUDE_CODE_SKIP_AUTH_LOGIN = 'true';
    const env = buildSpawnEnv({ configDir: '/cfg' });
    expect(ci(env, 'CLAUDE_CODE_USE_BEDROCK')).toBe('1');
    expect(ci(env, 'CLAUDE_CODE_USE_VERTEX')).toBe('1');
    expect(ci(env, 'CLAUDE_CODE_SKIP_AUTH_LOGIN')).toBe('true');
  });

  it('always overwrites CLAUDE_CONFIG_DIR with the caller-provided path, even if parent sets one', () => {
    process.env.CLAUDE_CONFIG_DIR = '/home/user/.claude';
    const env = buildSpawnEnv({ configDir: '/explicit/cfg' });
    expect(ci(env, 'CLAUDE_CONFIG_DIR')).toBe('/explicit/cfg');
  });

  it('envOverrides still win over forwarded ANTHROPIC_* parent vars', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://from-parent';
    process.env.ANTHROPIC_API_KEY = 'sk-parent';
    const env = buildSpawnEnv({
      configDir: '/cfg',
      envOverrides: {
        ANTHROPIC_BASE_URL: 'https://from-override',
        ANTHROPIC_API_KEY: 'sk-override',
      },
    });
    expect(ci(env, 'ANTHROPIC_BASE_URL')).toBe('https://from-override');
    expect(ci(env, 'ANTHROPIC_API_KEY')).toBe('sk-override');
  });

  it('uses canonical Windows casing (ComSpec, not COMSPEC) for whitelist hits', () => {
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    const env = buildSpawnEnv({ configDir: '/cfg' });
    expect(ci(env, 'ComSpec')).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});

describe('spawnClaude (Windows shim dispatch)', () => {
  it('node-script invocation: spawns node with the script as argv[0]', async () => {
    mockedSpawn.mockImplementation(() => makeFakeChild());

    // Stub classifyInvocation to force the node-script branch.
    const resolver = await import('../binary-resolver');
    const spy = vi.spyOn(resolver, 'classifyInvocation').mockReturnValue({
      kind: 'node-script',
      node: 'C:/path/node.exe',
      script: 'C:/path/cli.js',
    });

    await spawnClaude({
      cwd: '/w',
      configDir: '/c',
      binaryPath: 'C:/path/claude.cmd',
    });
    const [bin, argv, opts] = mockedSpawn.mock.calls[0];
    expect(bin).toBe('C:/path/node.exe');
    expect((argv as string[])[0]).toBe('C:/path/cli.js');
    expect((argv as string[]).slice(1, 6)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
    ]);
    expect((opts as { shell: boolean }).shell).toBe(false);

    spy.mockRestore();
  });

  it('cmd-shell fallback: shell:true with cmd-quoted command line, no argv', async () => {
    mockedSpawn.mockImplementation(() => makeFakeChild());

    const resolver = await import('../binary-resolver');
    const spy = vi.spyOn(resolver, 'classifyInvocation').mockReturnValue({
      kind: 'cmd-shell',
      path: 'C:\\Program Files\\weird shim\\claude.cmd',
    });

    await spawnClaude({
      cwd: '/w',
      configDir: '/c',
      binaryPath: 'C:\\Program Files\\weird shim\\claude.cmd',
      // Pass a malicious-looking arg to verify it's quoted, not interpreted.
      resumeId: 'sess_a&b|c"d',
    });

    const [cmdline, argv, opts] = mockedSpawn.mock.calls[0];
    expect((opts as { shell: boolean }).shell).toBe(true);
    expect(argv).toEqual([]);
    // The full command line must contain the binary path quoted (with the
    // space) and the malicious arg both quoted AND caret-escaped.
    expect(cmdline as string).toContain('"C:\\Program Files\\weird shim\\claude.cmd"');
    // The shell metachars must be neutralized (caret-prefixed).
    expect(cmdline as string).not.toMatch(/[^^]&/);
    expect(cmdline as string).not.toMatch(/[^^]\|/);
    expect(cmdline as string).toContain('^&');
    expect(cmdline as string).toContain('^|');

    spy.mockRestore();
  });
});
