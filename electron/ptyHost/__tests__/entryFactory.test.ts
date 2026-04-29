// Pins entryFactory.makeEntry's wiring contract (Task #738 Phase B):
//   - Picks `--resume` when JSONL exists, `--session-id` when it doesn't.
//   - Resolves the spawn cwd through `resolveSpawnCwd` BEFORE spawning.
//   - Calls `onCwdRedirect(spawnCwd)` only when the import-resume helper
//     actually copied the JSONL (#603 Layer-1 fix).
//   - Wires pty.onExit to dispose the headless mirror, fan out `pty:exit`
//     to attached webContents, AND invoke `deps.onExit(sid)` so the caller
//     can drop the entry from its registry.
//
// All heavy native deps (node-pty, headless terminal, electron, sessionWatcher)
// are stubbed so the factory loads in jsdom without binaries. vi.mock factories
// are hoisted, so per-test state lives on globalThis (`__pf`) and the mocks
// read it lazily.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface PtyFakeBus {
  onData: ((chunk: string) => void) | null;
  onExit: ((evt: { exitCode: number | null; signal: number | null }) => void) | null;
  ptySpawn: ReturnType<typeof vi.fn>;
  headlessDispose: ReturnType<typeof vi.fn>;
  headlessWrite: ReturnType<typeof vi.fn>;
  watcherStart: ReturnType<typeof vi.fn>;
  watcherStop: ReturnType<typeof vi.fn>;
  ensureJsonl: ReturnType<typeof vi.fn>;
  emitData: ReturnType<typeof vi.fn>;
  sourceJsonl: string | null;
  ensureCopied: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bus(): PtyFakeBus { return (globalThis as any).__pf as PtyFakeBus; }

vi.mock('node-pty', () => ({
  spawn: (...a: unknown[]) => {
    const b = bus();
    b.ptySpawn(...a);
    return {
      pid: 4242,
      onData: (cb: (chunk: string) => void) => { b.onData = cb; },
      onExit: (cb: (evt: { exitCode: number | null; signal: number | null }) => void) => {
        b.onExit = cb;
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
  },
}));

vi.mock('@xterm/headless', () => ({
  Terminal: class {
    write = (...a: unknown[]) => bus().headlessWrite(...a);
    dispose = () => bus().headlessDispose();
    loadAddon = vi.fn();
    resize = vi.fn();
  },
}));

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    serialize = () => 'snap';
  },
}));

vi.mock('electron', () => ({}));

vi.mock('../../sessionWatcher', () => ({
  sessionWatcher: {
    on: vi.fn(),
    startWatching: (...a: unknown[]) => bus().watcherStart(...a),
    stopWatching: (...a: unknown[]) => bus().watcherStop(...a),
  },
}));

vi.mock('../jsonlResolver', () => ({
  toClaudeSid: (s: string) => s,
  findJsonlForSid: () => bus().sourceJsonl,
  resolveJsonlPath: () => '/tmp/live.jsonl',
  ensureResumeJsonlAtSpawnCwd: (...a: unknown[]) => {
    bus().ensureJsonl(...a);
    return { copied: bus().ensureCopied, targetPath: '/tmp/target.jsonl' };
  },
}));

vi.mock('../cwdResolver', () => ({
  resolveSpawnCwd: (cwd: string) => (cwd ? cwd : '/home/u'),
}));

vi.mock('../dataFanout', () => ({
  emitPtyData: (sid: string, chunk: string) => bus().emitData(sid, chunk),
}));

import { makeEntry } from '../entryFactory';

describe('entryFactory.makeEntry', () => {
  beforeEach(() => {
    const b: PtyFakeBus = {
      onData: null,
      onExit: null,
      ptySpawn: vi.fn(),
      headlessDispose: vi.fn(),
      headlessWrite: vi.fn(),
      watcherStart: vi.fn(),
      watcherStop: vi.fn(),
      ensureJsonl: vi.fn(),
      emitData: vi.fn(),
      sourceJsonl: null,
      ensureCopied: false,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__pf = b;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__pf;
  });

  it('uses --session-id when no JSONL exists for the sid', () => {
    bus().sourceJsonl = null;
    makeEntry('sid-A', '/work', '/bin/claude', 100, 30, { onExit: vi.fn() });
    const b = bus();
    expect(b.ptySpawn).toHaveBeenCalledTimes(1);
    const args = b.ptySpawn.mock.calls[0];
    expect(args[0]).toBe('/bin/claude');
    expect(args[1]).toEqual(['--session-id', 'sid-A']);
    // ensureResumeJsonlAtSpawnCwd is gated on sourceJsonl being truthy.
    expect(b.ensureJsonl).not.toHaveBeenCalled();
  });

  it('uses --resume when JSONL exists, and skips onCwdRedirect when no copy happened', () => {
    bus().sourceJsonl = '/old/proj/sid-B.jsonl';
    bus().ensureCopied = false;
    const onCwdRedirect = vi.fn();
    makeEntry('sid-B', '/work', '/bin/claude', 80, 24, { onExit: vi.fn(), onCwdRedirect });
    expect(bus().ptySpawn.mock.calls[0][1]).toEqual(['--resume', 'sid-B']);
    expect(bus().ensureJsonl).toHaveBeenCalledTimes(1);
    expect(onCwdRedirect).not.toHaveBeenCalled();
  });

  it('fires onCwdRedirect(spawnCwd) when the import-resume helper copied', () => {
    bus().sourceJsonl = '/old/proj/sid-C.jsonl';
    bus().ensureCopied = true;
    const onCwdRedirect = vi.fn();
    makeEntry('sid-C', '/work', '/bin/claude', 80, 24, { onExit: vi.fn(), onCwdRedirect });
    expect(onCwdRedirect).toHaveBeenCalledTimes(1);
    expect(onCwdRedirect).toHaveBeenCalledWith('/work');
  });

  it('falls back to homedir-style spawnCwd when cwd is empty (resolveSpawnCwd contract)', () => {
    makeEntry('sid-D', '', '/bin/claude', 80, 24, { onExit: vi.fn() });
    const opts = bus().ptySpawn.mock.calls[0][2] as { cwd: string };
    expect(opts.cwd).toBe('/home/u');
  });

  it('starts the JSONL tail-watcher with the spawn cwd', () => {
    makeEntry('sid-E', '/work', '/bin/claude', 80, 24, { onExit: vi.fn() });
    expect(bus().watcherStart).toHaveBeenCalledWith('sid-E', '/tmp/live.jsonl', '/work');
  });

  it('on pty exit: disposes headless, fires deps.onExit(sid), and stops the watcher', () => {
    const onExit = vi.fn();
    makeEntry('sid-F', '/work', '/bin/claude', 80, 24, { onExit });
    const b = bus();
    expect(b.onExit).toBeTypeOf('function');
    b.onExit!({ exitCode: 0, signal: null });
    expect(b.headlessDispose).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith('sid-F');
    expect(b.watcherStop).toHaveBeenCalledWith('sid-F');
  });

  it('forwards pty data into headless write AND emitPtyData fanout', () => {
    makeEntry('sid-G', '/work', '/bin/claude', 80, 24, { onExit: vi.fn() });
    const b = bus();
    expect(b.onData).toBeTypeOf('function');
    b.onData!('hello');
    expect(b.headlessWrite).toHaveBeenCalledWith('hello');
    expect(b.emitData).toHaveBeenCalledWith('sid-G', 'hello');
  });

  it('returns an Entry exposing the pid/cols/rows/cwd captured at spawn', () => {
    const e = makeEntry('sid-H', '/work', '/bin/claude', 100, 40, { onExit: vi.fn() });
    expect(e.pty.pid).toBe(4242);
    expect(e.cols).toBe(100);
    expect(e.rows).toBe(40);
    expect(e.cwd).toBe('/work');
    expect(e.attached.size).toBe(0);
  });
});
