// Pure lifecycle ops over the Entry registry.
//
// Pins the contract for spawn / list / attach / detach / input / resize /
// kill / get / killAll. Heavy collaborators (entryFactory.makeEntry,
// processKiller.killProcessSubtree, sessionWatcher) are mocked — the
// registry-mutation logic and the cap/guard branches are what's under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePty {
  pid: number;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onExit: (cb: () => void) => { dispose: () => void };
  /** Test helper — fire the registered onExit listener. */
  __fireExit?: () => void;
  killShouldThrow?: boolean;
  writeShouldThrow?: boolean;
  resizeShouldThrow?: boolean;
}

interface FakeEntry {
  pty: FakePty;
  headless: { resize: ReturnType<typeof vi.fn> };
  serialize: { serialize: () => string };
  attached: Map<number, unknown>;
  cols: number;
  rows: number;
  cwd: string;
}

interface LifecycleBus {
  killCalls: Array<number | undefined>;
  watcherStopCalls: string[];
  watcherStopShouldThrow: boolean;
  makeEntry: ReturnType<typeof vi.fn>;
}

function bus(): LifecycleBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).__lcBus as LifecycleBus;
}

vi.mock('../processKiller', () => ({
  killProcessSubtree: (pid: number | undefined) => bus().killCalls.push(pid),
}));

vi.mock('../../sessionWatcher', () => ({
  sessionWatcher: {
    on: vi.fn(),
    startWatching: vi.fn(),
    stopWatching: (sid: string) => {
      bus().watcherStopCalls.push(sid);
      if (bus().watcherStopShouldThrow) throw new Error('stop boom');
    },
  },
}));

vi.mock('../entryFactory', () => ({
  DEFAULT_COLS: 120,
  DEFAULT_ROWS: 30,
  makeEntry: (...args: unknown[]) => bus().makeEntry(...args),
}));

// scrollback prefs transitively import `electron` (via `../db` → `app`).
// We don't exercise scrollback caps in these lifecycle tests — stub it.
vi.mock('../../prefs/scrollback', () => ({
  loadScrollbackLines: () => 1500,
}));

import * as L from '../lifecycle';

function makeFakePty(over: Partial<FakePty> = {}): FakePty {
  // Multi-listener onExit (mirrors node-pty's IEvent contract — see
  // node-pty.d.ts: `readonly onExit: IEvent<...>`). The lifecycle race fix
  // (#1277 review) registers a listener inside `kill()` to await entry
  // removal; entryFactory also registers one for the cleanup pump. Both
  // must fire on a single exit event.
  const listeners = new Set<() => void>();
  const pty: FakePty = {
    pid: 1234,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onExit: (cb: () => void) => {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    __fireExit: () => {
      // Snapshot listeners — a listener may dispose itself when fired.
      for (const cb of [...listeners]) cb();
    },
    ...over,
  };
  return pty;
}

function makeFakeEntry(over: Partial<FakeEntry> = {}): FakeEntry {
  return {
    pty: makeFakePty(),
    headless: { resize: vi.fn() },
    serialize: { serialize: () => 'snapshot' },
    attached: new Map(),
    cols: 80,
    rows: 24,
    cwd: '/work',
    ...over,
  };
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__lcBus = {
    killCalls: [],
    watcherStopCalls: [],
    watcherStopShouldThrow: false,
    makeEntry: vi.fn(),
  } satisfies LifecycleBus;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__lcBus;
  vi.restoreAllMocks();
});

// ─── spawn ────────────────────────────────────────────────────────────────

describe('lifecycle.spawn', () => {
  it('inserts a new Entry into the map and returns its info', () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry({ pty: makeFakePty({ pid: 9 }), cwd: '/picked' });
    bus().makeEntry.mockReturnValue(entry);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = L.spawn(sessions as any, 'sid-A', '/work', '/bin/claude');

    expect(sessions.get('sid-A')).toBe(entry);
    expect(info).toEqual({ sid: 'sid-A', pid: 9, cols: 80, rows: 24, cwd: '/picked' });
  });

  it('uses DEFAULT_COLS/ROWS when opts is omitted', () => {
    const sessions = new Map<string, FakeEntry>();
    bus().makeEntry.mockReturnValue(makeFakeEntry());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.spawn(sessions as any, 'sid', '/work', '/bin/claude');
    const args = bus().makeEntry.mock.calls[0];
    expect(args[3]).toBe(120); // cols
    expect(args[4]).toBe(30); // rows
  });

  it('passes through explicit cols/rows opts', () => {
    const sessions = new Map<string, FakeEntry>();
    bus().makeEntry.mockReturnValue(makeFakeEntry());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.spawn(sessions as any, 'sid', '/work', '/bin/claude', { cols: 200, rows: 50 });
    const args = bus().makeEntry.mock.calls[0];
    expect(args[3]).toBe(200);
    expect(args[4]).toBe(50);
  });

  it('is idempotent — second spawn for the same sid returns existing Entry, no makeEntry call', () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry({ pty: makeFakePty({ pid: 99 }) });
    sessions.set('sid-A', entry);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = L.spawn(sessions as any, 'sid-A', '/work2', '/bin/claude2');

    expect(bus().makeEntry).not.toHaveBeenCalled();
    expect(info.pid).toBe(99);
  });

  it('forwards onCwdRedirect to makeEntry deps', () => {
    const sessions = new Map<string, FakeEntry>();
    bus().makeEntry.mockReturnValue(makeFakeEntry());
    const onCwdRedirect = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.spawn(sessions as any, 'sid', '/work', '/bin/claude', { onCwdRedirect });
    const deps = bus().makeEntry.mock.calls[0][5] as { onCwdRedirect?: unknown };
    expect(deps.onCwdRedirect).toBe(onCwdRedirect);
  });

  it('the onExit deps callback removes the entry from the map', () => {
    const sessions = new Map<string, FakeEntry>();
    bus().makeEntry.mockReturnValue(makeFakeEntry());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.spawn(sessions as any, 'sid-A', '/work', '/bin/claude');
    expect(sessions.has('sid-A')).toBe(true);
    const deps = bus().makeEntry.mock.calls[0][5] as { onExit: (s: string) => void };
    deps.onExit('sid-A');
    expect(sessions.has('sid-A')).toBe(false);
  });
});

// ─── list / get ───────────────────────────────────────────────────────────

describe('lifecycle.list and get', () => {
  it('list returns one info per entry', () => {
    const sessions = new Map<string, FakeEntry>();
    sessions.set('a', makeFakeEntry({ cwd: '/a', pty: makeFakePty({ pid: 1 }) }));
    sessions.set('b', makeFakeEntry({ cwd: '/b', pty: makeFakePty({ pid: 2 }) }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = L.list(sessions as any);
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.sid).sort()).toEqual(['a', 'b']);
    const a = out.find((i) => i.sid === 'a')!;
    expect(a).toEqual({ sid: 'a', pid: 1, cols: 80, rows: 24, cwd: '/a' });
  });

  it('get returns null when sid is not in the map', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(L.get(new Map() as any, 'nope')).toBeNull();
  });

  it('get returns the info for an existing entry', () => {
    const sessions = new Map<string, FakeEntry>();
    sessions.set('s', makeFakeEntry({ cwd: '/c', pty: makeFakePty({ pid: 7 }) }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(L.get(sessions as any, 's')).toEqual({ sid: 's', pid: 7, cols: 80, rows: 24, cwd: '/c' });
  });
});

// ─── attach / detach ──────────────────────────────────────────────────────

describe('lifecycle.attach and detach', () => {
  it('attach returns null for an unknown sid', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(L.attach(new Map() as any, 'ghost')).toBeNull();
  });

  it('attach returns cols/rows/pid pulled from the entry (no snapshot — #888 follow-up)', () => {
    const sessions = new Map<string, FakeEntry>();
    const serializeSpy = vi.fn(() => 'painted');
    sessions.set('s', makeFakeEntry({
      cols: 99,
      rows: 33,
      pty: makeFakePty({ pid: 55 }),
      serialize: { serialize: serializeSpy },
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(L.attach(sessions as any, 's')).toEqual({
      cols: 99,
      rows: 33,
      pid: 55,
    });
    // #888 follow-up: attach MUST NOT serialize the headless buffer —
    // the renderer drives the paint via getBufferSnapshot (PR-B).
    expect(serializeSpy).not.toHaveBeenCalled();
  });

  it('detach is a no-op at the lifecycle layer (per-webContents cleanup is IPC concern)', () => {
    const sessions = new Map<string, FakeEntry>();
    sessions.set('s', makeFakeEntry());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => L.detach(sessions as any, 's')).not.toThrow();
    // entry not removed
    expect(sessions.has('s')).toBe(true);
  });
});

// ─── input ────────────────────────────────────────────────────────────────

describe('lifecycle.input', () => {
  it('writes the data through the pty', () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    sessions.set('s', entry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.input(sessions as any, 's', 'echo hi\n');
    expect(entry.pty.write).toHaveBeenCalledWith('echo hi\n');
  });

  it('is a silent no-op when sid is unknown', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => L.input(new Map() as any, 'ghost', 'x')).not.toThrow();
  });

  it('swallows pty.write throws (already-exited race)', () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.write = vi.fn(() => { throw new Error('EPIPE'); });
    sessions.set('s', entry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => L.input(sessions as any, 's', 'x')).not.toThrow();
  });
});

// ─── resize ───────────────────────────────────────────────────────────────

describe('lifecycle.resize', () => {
  it('resizes pty + headless and updates cached cols/rows', () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    sessions.set('s', entry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.resize(sessions as any, 's', 100, 40);
    expect(entry.pty.resize).toHaveBeenCalledWith(100, 40);
    expect(entry.headless.resize).toHaveBeenCalledWith(100, 40);
    expect(entry.cols).toBe(100);
    expect(entry.rows).toBe(40);
  });

  it('rejects degenerate sizes (cols<2 or rows<2) — neither pty nor headless touched', () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    sessions.set('s', entry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.resize(sessions as any, 's', 1, 40);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.resize(sessions as any, 's', 40, 1);
    expect(entry.pty.resize).not.toHaveBeenCalled();
    expect(entry.headless.resize).not.toHaveBeenCalled();
    // cached size unchanged
    expect(entry.cols).toBe(80);
    expect(entry.rows).toBe(24);
  });

  it('warns and survives when pty.resize throws', () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.resize = vi.fn(() => { throw new Error('boom'); });
    sessions.set('s', entry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => L.resize(sessions as any, 's', 100, 40)).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('resize s failed'),
    );
  });

  it('is a no-op when sid is unknown', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(L.resize(new Map() as any, 'ghost', 100, 40)).toBeUndefined();
  });
});

// ─── kill / killAll ───────────────────────────────────────────────────────

describe('lifecycle.kill', () => {
  it('resolves to false for an unknown sid (no side effects)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(L.kill(new Map() as any, 'ghost')).resolves.toBe(false);
    expect(bus().killCalls).toEqual([]);
    expect(bus().watcherStopCalls).toEqual([]);
  });

  it('captures pid BEFORE pty.kill (binding may zero pid post-kill)', async () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 4242;
    // simulate the binding zeroing pid on kill, then firing onExit (the
    // production race-fix path: kill() awaits onExit before resolving).
    entry.pty.kill = vi.fn(() => { entry.pty.pid = 0; entry.pty.__fireExit!(); });
    sessions.set('s', entry);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(L.kill(sessions as any, 's')).resolves.toBe(true);
    expect(bus().killCalls).toEqual([4242]);
  });

  it('always invokes killProcessSubtree even if pty.kill throws', async () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 7;
    entry.pty.kill = vi.fn(() => { throw new Error('already dead'); });
    sessions.set('s', entry);
    // pty.kill threw, no onExit fired → resolves false via timeout
    vi.useFakeTimers();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = L.kill(sessions as any, 's');
    expect(bus().killCalls).toEqual([7]);
    await vi.advanceTimersByTimeAsync(L.KILL_EXIT_TIMEOUT_MS + 10);
    await expect(p).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('always invokes sessionWatcher.stopWatching (belt-and-braces, swallows throws)', async () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    // Fire onExit synchronously inside kill so the promise resolves promptly.
    entry.pty.kill = vi.fn(() => entry.pty.__fireExit!());
    sessions.set('s', entry);
    bus().watcherStopShouldThrow = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(L.kill(sessions as any, 's')).resolves.toBe(true);
    expect(bus().watcherStopCalls).toEqual(['s']);
  });

  // ─── #1277 review race fix ─────────────────────────────────────────────

  it('awaits pty.onExit before resolving — renderer-attach race fix', async () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 100;
    // pty.kill() does NOT auto-fire onExit (the production node-pty contract:
    // kill dispatches a signal; onExit fires when the OS reaps the process).
    entry.pty.kill = vi.fn();
    sessions.set('s', entry);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = L.kill(sessions as any, 's');
    // pty.kill + processKiller already ran synchronously (kill signal dispatched).
    expect(entry.pty.kill).toHaveBeenCalled();
    expect(bus().killCalls).toEqual([100]);

    // But the promise must NOT have resolved yet — the renderer awaits this
    // before bumping reloadNonce, and the entry hasn't been removed.
    let resolved: boolean | 'pending' = 'pending';
    void p.then((v) => { resolved = v; });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe('pending');

    // Fire the OS-reap event. Now the kill promise should resolve.
    entry.pty.__fireExit!();
    await expect(p).resolves.toBe(true);
  });

  it('falls back to a 3s timeout when pty.onExit never fires (wedged kill)', async () => {
    vi.useFakeTimers();
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 200;
    // Simulates a wedged pty: kill signal dispatched but the process never
    // exits (onExit silent). Without the timeout the renderer would hang
    // forever on `await ccsmPty.kill(sid)`.
    entry.pty.kill = vi.fn();
    sessions.set('s', entry);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = L.kill(sessions as any, 's');
    let resolved: boolean | 'pending' = 'pending';
    void p.then((v) => { resolved = v; });

    // Advance just under the timeout — still pending.
    await vi.advanceTimersByTimeAsync(L.KILL_EXIT_TIMEOUT_MS - 100);
    expect(resolved).toBe('pending');

    // Cross the timeout — resolves false (entry-removed signal not observed),
    // letting the renderer's reloadNonce path proceed instead of hanging.
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('dedupes concurrent kills for the same sid — second call shares the first promise', async () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 300;
    entry.pty.kill = vi.fn();
    sessions.set('s', entry);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p1 = L.kill(sessions as any, 's');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p2 = L.kill(sessions as any, 's');
    // Same promise — second call is a no-op short-circuit, no extra
    // pty.kill / processKiller / stopWatching invocations.
    expect(p1).toBe(p2);
    expect(entry.pty.kill).toHaveBeenCalledTimes(1);
    expect(bus().killCalls).toEqual([300]);
    expect(bus().watcherStopCalls).toEqual(['s']);

    // Drain.
    entry.pty.__fireExit!();
    await expect(p1).resolves.toBe(true);
  });

  it('a fresh kill after the previous one completes is NOT deduped', async () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 400;
    entry.pty.kill = vi.fn(() => entry.pty.__fireExit!());
    sessions.set('s', entry);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await L.kill(sessions as any, 's');
    // Re-add the entry (simulating spawn-on-null fallback creating a new pty
    // for the same sid) and kill again — this must NOT short-circuit.
    sessions.set('s', entry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await L.kill(sessions as any, 's');
    expect(entry.pty.kill).toHaveBeenCalledTimes(2);
  });
});

describe('lifecycle.killAll', () => {
  it('kills every entry via the kill op', () => {
    const sessions = new Map<string, FakeEntry>();
    sessions.set('a', makeFakeEntry({ pty: makeFakePty({ pid: 1 }) }));
    sessions.set('b', makeFakeEntry({ pty: makeFakePty({ pid: 2 }) }));
    sessions.set('c', makeFakeEntry({ pty: makeFakePty({ pid: 3 }) }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.killAll(sessions as any);
    expect(bus().killCalls.sort()).toEqual([1, 2, 3]);
    expect(bus().watcherStopCalls.sort()).toEqual(['a', 'b', 'c']);
  });

  it('snapshots the keys before iterating — safe against concurrent mutation', () => {
    const sessions = new Map<string, FakeEntry>();
    sessions.set('a', makeFakeEntry());
    sessions.set('b', makeFakeEntry());
    // killAll calls kill() which doesn't itself mutate the map (the onExit
    // hook does, but it isn't wired in this test). The contract under test
    // is "iterates over a snapshot of keys".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.killAll(sessions as any);
    expect(bus().killCalls).toHaveLength(2);
  });

  it('killAll over an empty map is a no-op', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    L.killAll(new Map() as any);
    expect(bus().killCalls).toEqual([]);
  });
});
