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
  deferHeadlessWrite: boolean;
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
    // Mirror @xterm/headless's `write(data, callback?)` signature so tests
    // can exercise PR-C backpressure (we count pending writes by deferring
    // the callback until the test fires it).
    write = (data: unknown, callback?: () => void) => {
      bus().headlessWrite(data, callback);
      // By default invoke synchronously (legacy behavior). Tests that need
      // to model "pending" writes flip `bus().deferHeadlessWrite = true` and
      // capture callbacks via the spy.
      if (callback && !bus().deferHeadlessWrite) callback();
    };
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
      deferHeadlessWrite: false,
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
    // PR-C (#863): headless.write is now invoked with a backpressure callback.
    expect(b.headlessWrite).toHaveBeenCalledWith('hello', expect.any(Function));
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

// L4 PR-C (#863): the onData handler is now an extracted, named
// `dispatchPtyChunk(entry, chunk)` so the headless-write + broadcast
// double-write is explicit (and a hook point for PR-D/E). These tests
// pin its contract directly without going through node-pty.
describe('entryFactory.dispatchPtyChunk', () => {
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
      deferHeadlessWrite: false,
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

  it('double-writes each chunk to headless AND broadcasts pty:data with monotonic seq', async () => {
    const mod = await import('../entryFactory');
    const entry = mod.makeEntry('sid-DW', '/work', '/bin/claude', 80, 24, { onExit: vi.fn() });
    const sent: Array<{ chunk: string; seq: number }> = [];
    const wc = {
      isDestroyed: () => false,
      send: (_ch: string, payload: { sid: string; chunk: string; seq: number }) => {
        sent.push({ chunk: payload.chunk, seq: payload.seq });
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry.attached.set(1, wc as any);

    mod.dispatchPtyChunk('sid-DW', entry, 'a');
    mod.dispatchPtyChunk('sid-DW', entry, 'b');
    mod.dispatchPtyChunk('sid-DW', entry, 'c');

    const b = bus();
    expect(b.headlessWrite).toHaveBeenCalledTimes(3);
    expect(b.headlessWrite.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    expect(sent).toEqual([
      { chunk: 'a', seq: 1 },
      { chunk: 'b', seq: 2 },
      { chunk: 'c', seq: 3 },
    ]);
    expect(entry.seq).toBe(3);
    // dataFanout must also receive every chunk (notify pipeline depends on it).
    expect(b.emitData).toHaveBeenCalledTimes(3);
  });

  it('warns once when pending headless writes cross BACKPRESSURE_WARN_THRESHOLD, no data dropped', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../entryFactory');
    const entry = mod.makeEntry('sid-BP', '/work', '/bin/claude', 80, 24, { onExit: vi.fn() });

    // Defer write callbacks so writes stay "pending" until we manually drain.
    bus().deferHeadlessWrite = true;
    const threshold = mod.BACKPRESSURE_WARN_THRESHOLD;

    // Fire `threshold + 1` chunks: the (threshold+1)-th increments the
    // pending counter past the threshold and must trigger the warn.
    for (let i = 0; i < threshold + 1; i++) {
      mod.dispatchPtyChunk('sid-BP', entry, `c${i}`);
    }

    // All chunks must have been forwarded to headless.write — backpressure
    // is observe-only, never drops.
    expect(bus().headlessWrite).toHaveBeenCalledTimes(threshold + 1);
    // Warn fired (at least once) for the over-threshold condition.
    const bpWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('backpressure'),
    );
    expect(bpWarns.length).toBeGreaterThanOrEqual(1);

    // Drain: invoke each captured callback to clear pending, and verify a
    // subsequent over-threshold burst can warn again (re-arm semantics).
    const captured = bus().headlessWrite.mock.calls
      .map((c) => c[1] as (() => void) | undefined)
      .filter((cb): cb is () => void => typeof cb === 'function');
    for (const cb of captured) cb();
    warnSpy.mockClear();
    for (let i = 0; i < threshold + 1; i++) {
      mod.dispatchPtyChunk('sid-BP', entry, `d${i}`);
    }
    const bpWarns2 = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('backpressure'),
    );
    expect(bpWarns2.length).toBeGreaterThanOrEqual(1);
  });

  it('skips destroyed webContents but still writes to headless and bumps seq', async () => {
    const mod = await import('../entryFactory');
    const entry = mod.makeEntry('sid-DEAD', '/work', '/bin/claude', 80, 24, { onExit: vi.fn() });
    const aliveSent: Array<number> = [];
    const dead = { isDestroyed: () => true, send: vi.fn() };
    const alive = {
      isDestroyed: () => false,
      send: (_ch: string, payload: { seq: number }) => aliveSent.push(payload.seq),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry.attached.set(1, dead as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry.attached.set(2, alive as any);

    mod.dispatchPtyChunk('sid-DEAD', entry, 'x');
    expect(dead.send).not.toHaveBeenCalled();
    expect(aliveSent).toEqual([1]);
    expect(bus().headlessWrite).toHaveBeenCalledWith('x', expect.any(Function));
    expect(entry.seq).toBe(1);
  });
});
