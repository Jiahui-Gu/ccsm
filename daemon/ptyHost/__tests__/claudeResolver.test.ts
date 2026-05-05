// Pure decider tests for claudeResolver.
//
// Pins the platform branch (Windows tries `claude.cmd` first then `claude`,
// POSIX tries `claude` only), the success-cache, the `force: true` bypass,
// and the failure-mode contract (returns null when both lookups fail — never
// the literal string "claude" — so the IPC channel can surface a clean
// `available: false` for the renderer's ClaudeMissingGuide).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted module-level state the spawnSync mock reads. Tests rewrite
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
  const spawnSync = (cmd: string, args: readonly string[]) => {
    const b = bus();
    b.calls.push({ cmd, args });
    if (b.shouldThrow) throw new Error('spawnSync EPERM');
    const key = `${cmd} ${args.join(' ')}`;
    const r = b.results.get(key);
    if (r) return { status: r.status, stdout: r.stdout, stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  return {
    default: { spawnSync },
    spawnSync,
  };
});

// Import AFTER vi.mock so the resolver picks up the mocked spawnSync.
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

  it('returns the path from `where claude.cmd` when present', () => {
    bus().results.set('where claude.cmd', {
      status: 0,
      stdout: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd\r\n',
    });
    expect(resolveClaude()).toBe('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd');
    expect(bus().calls.map((c) => c.args[0])).toEqual(['claude.cmd']);
  });

  it('falls back to `where claude` when claude.cmd lookup fails', () => {
    bus().results.set('where claude.cmd', { status: 1, stdout: '' });
    bus().results.set('where claude', {
      status: 0,
      stdout: 'C:\\tools\\claude\n',
    });
    expect(resolveClaude()).toBe('C:\\tools\\claude');
    expect(bus().calls.map((c) => c.args[0])).toEqual(['claude.cmd', 'claude']);
  });

  it('returns null (never the literal "claude") when both lookups fail', () => {
    expect(resolveClaude()).toBeNull();
    expect(bus().calls).toHaveLength(2);
  });

  it('takes the FIRST line of multi-line where output (PATH may have dupes)', () => {
    bus().results.set('where claude.cmd', {
      status: 0,
      stdout: 'C:\\first\\claude.cmd\r\nC:\\second\\claude.cmd\r\n',
    });
    expect(resolveClaude()).toBe('C:\\first\\claude.cmd');
  });

  it('treats blank-stdout success as not-found (status==0 but no path)', () => {
    bus().results.set('where claude.cmd', { status: 0, stdout: '\r\n  \r\n' });
    bus().results.set('where claude', { status: 0, stdout: 'C:\\fallback\\claude' });
    expect(resolveClaude()).toBe('C:\\fallback\\claude');
  });
});

describe('resolveClaude on POSIX', () => {
  beforeEach(() => setPlatform('linux'));

  it('uses `which claude` (single lookup)', () => {
    bus().results.set('which claude', { status: 0, stdout: '/usr/local/bin/claude\n' });
    expect(resolveClaude()).toBe('/usr/local/bin/claude');
    expect(bus().calls).toEqual([{ cmd: 'which', args: ['claude'] }]);
  });

  it('returns null when `which claude` fails', () => {
    expect(resolveClaude()).toBeNull();
    expect(bus().calls).toHaveLength(1);
  });

  it('returns null when spawnSync itself throws', () => {
    bus().shouldThrow = true;
    expect(resolveClaude()).toBeNull();
  });
});

describe('resolveClaude caching', () => {
  beforeEach(() => setPlatform('linux'));

  it('caches the resolved path — second call does not re-spawn', () => {
    bus().results.set('which claude', { status: 0, stdout: '/bin/claude\n' });
    expect(resolveClaude()).toBe('/bin/claude');
    expect(resolveClaude()).toBe('/bin/claude');
    expect(bus().calls).toHaveLength(1);
  });

  it('caches the null result — second call does not re-spawn', () => {
    expect(resolveClaude()).toBeNull();
    expect(resolveClaude()).toBeNull();
    expect(bus().calls).toHaveLength(1);
  });

  it('force:true bypasses the cache (re-check button on ClaudeMissingGuide)', () => {
    expect(resolveClaude()).toBeNull();
    bus().results.set('which claude', { status: 0, stdout: '/bin/claude\n' });
    expect(resolveClaude({ force: true })).toBe('/bin/claude');
    expect(bus().calls).toHaveLength(2);
  });

  it('__resetClaudeResolverForTest clears the cache', () => {
    bus().results.set('which claude', { status: 0, stdout: '/bin/claude\n' });
    expect(resolveClaude()).toBe('/bin/claude');
    __resetClaudeResolverForTest();
    bus().results.clear();
    expect(resolveClaude()).toBeNull();
  });
});
