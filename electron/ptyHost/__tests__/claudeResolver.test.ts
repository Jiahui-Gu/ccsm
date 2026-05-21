// Pure decider tests for claudeResolver.
//
// Pins the platform branch (Windows tries `claude.cmd` first then `claude`,
// POSIX tries `claude` only), the success-cache, the `force: true` bypass,
// and the failure-mode contract (returns null when both lookups fail — never
// the literal string "claude" — so the IPC channel can surface a clean
// `available: false` for the renderer's ClaudeMissingGuide).
//
// Resolver is async (#PERF: original spawnSync blocked the main process
// event loop on Windows cold start). Tests await each call and the
// `spawn` mock returns an EventEmitter-like child whose stdout pushes
// scripted bytes then emits `exit` with a scripted code on the next tick.

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted module-level state the spawn mock reads. Tests rewrite
// `__bus` between cases; the mock factory captures `globalThis` lazily.
interface SpawnCall {
  cmd: string;
  args: readonly string[];
}
interface SpawnFakeBus {
  results: Map<string, { status: number; stdout: string }>;
  calls: SpawnCall[];
  shouldThrow: boolean;
}
function bus(): SpawnFakeBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).__claudeResolverBus as SpawnFakeBus;
}

vi.mock('node:child_process', () => {
  const spawn = (cmd: string, args: readonly string[]) => {
    const b = bus();
    b.calls.push({ cmd, args });
    if (b.shouldThrow) throw new Error('spawn EPERM');
    const key = `${cmd} ${args.join(' ')}`;
    const r = b.results.get(key) ?? { status: 1, stdout: '' };
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
    };
    const stdout = new Readable({ read() {} });
    child.stdout = stdout;
    // Push data on next microtask so the resolver's `'data'` listener
    // (attached synchronously after spawn returns) receives it. Emit
    // `exit` on the FOLLOWING tick — after the readable has drained the
    // pushed buffer to the listener — so the resolver doesn't snapshot
    // an empty stdout buffer before the data event fires.
    queueMicrotask(() => {
      if (r.stdout) stdout.push(Buffer.from(r.stdout, 'utf8'));
      stdout.push(null);
      setImmediate(() => child.emit('exit', r.status));
    });
    return child;
  };
  return {
    default: { spawn },
    spawn,
  };
});

// Import AFTER vi.mock so the resolver picks up the mocked spawn.
import { __resetClaudeResolverForTest, resolveClaude } from '../claudeResolver';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__claudeResolverBus = {
    results: new Map(),
    calls: [],
    shouldThrow: false,
  } satisfies SpawnFakeBus;
  __resetClaudeResolverForTest();
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  __resetClaudeResolverForTest();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__claudeResolverBus;
  vi.restoreAllMocks();
});

describe('resolveClaude on Windows', () => {
  beforeEach(() => setPlatform('win32'));

  it('returns the path from `where claude.cmd` when present', async () => {
    bus().results.set('where claude.cmd', {
      status: 0,
      stdout: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd\r\n',
    });
    expect(await resolveClaude()).toBe('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd');
    expect(bus().calls.map((c) => c.args[0])).toEqual(['claude.cmd']);
  });

  it('falls back to `where claude` when claude.cmd lookup fails', async () => {
    bus().results.set('where claude.cmd', { status: 1, stdout: '' });
    bus().results.set('where claude', {
      status: 0,
      stdout: 'C:\\tools\\claude\n',
    });
    expect(await resolveClaude()).toBe('C:\\tools\\claude');
    expect(bus().calls.map((c) => c.args[0])).toEqual(['claude.cmd', 'claude']);
  });

  it('returns null (never the literal "claude") when both lookups fail', async () => {
    expect(await resolveClaude()).toBeNull();
    expect(bus().calls).toHaveLength(2);
  });

  it('takes the FIRST line of multi-line where output (PATH may have dupes)', async () => {
    bus().results.set('where claude.cmd', {
      status: 0,
      stdout: 'C:\\first\\claude.cmd\r\nC:\\second\\claude.cmd\r\n',
    });
    expect(await resolveClaude()).toBe('C:\\first\\claude.cmd');
  });

  it('treats blank-stdout success as not-found (status==0 but no path)', async () => {
    bus().results.set('where claude.cmd', { status: 0, stdout: '\r\n  \r\n' });
    bus().results.set('where claude', { status: 0, stdout: 'C:\\fallback\\claude' });
    expect(await resolveClaude()).toBe('C:\\fallback\\claude');
  });
});

describe('resolveClaude on POSIX', () => {
  beforeEach(() => setPlatform('linux'));

  it('uses `which claude` (single lookup)', async () => {
    bus().results.set('which claude', { status: 0, stdout: '/usr/local/bin/claude\n' });
    expect(await resolveClaude()).toBe('/usr/local/bin/claude');
    expect(bus().calls).toEqual([{ cmd: 'which', args: ['claude'] }]);
  });

  it('returns null when `which claude` fails', async () => {
    expect(await resolveClaude()).toBeNull();
    expect(bus().calls).toHaveLength(1);
  });

  it('returns null when spawn itself throws', async () => {
    bus().shouldThrow = true;
    expect(await resolveClaude()).toBeNull();
  });
});

describe('resolveClaude caching', () => {
  beforeEach(() => setPlatform('linux'));

  it('caches the resolved path — second call does not re-spawn', async () => {
    bus().results.set('which claude', { status: 0, stdout: '/bin/claude\n' });
    expect(await resolveClaude()).toBe('/bin/claude');
    expect(await resolveClaude()).toBe('/bin/claude');
    expect(bus().calls).toHaveLength(1);
  });

  it('caches the null result — second call does not re-spawn', async () => {
    expect(await resolveClaude()).toBeNull();
    expect(await resolveClaude()).toBeNull();
    expect(bus().calls).toHaveLength(1);
  });

  it('force:true bypasses the cache (re-check button on ClaudeMissingGuide)', async () => {
    expect(await resolveClaude()).toBeNull();
    bus().results.set('which claude', { status: 0, stdout: '/bin/claude\n' });
    expect(await resolveClaude({ force: true })).toBe('/bin/claude');
    expect(bus().calls).toHaveLength(2);
  });

  it('__resetClaudeResolverForTest clears the cache', async () => {
    bus().results.set('which claude', { status: 0, stdout: '/bin/claude\n' });
    expect(await resolveClaude()).toBe('/bin/claude');
    __resetClaudeResolverForTest();
    bus().results.clear();
    expect(await resolveClaude()).toBeNull();
  });

  it('dedups concurrent first-callers into a single in-flight spawn', async () => {
    bus().results.set('which claude', { status: 0, stdout: '/bin/claude\n' });
    // Fire two callers BEFORE awaiting — both should share the same
    // in-flight Promise rather than each spawning their own `where`.
    const [a, b] = await Promise.all([resolveClaude(), resolveClaude()]);
    expect(a).toBe('/bin/claude');
    expect(b).toBe('/bin/claude');
    expect(bus().calls).toHaveLength(1);
  });
});
