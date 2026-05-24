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
  (globalThis as any).__lcBus = {
    killCalls: [],
    watcherStopCalls: [],
    watcherStopShouldThrow: false,
    makeEntry: vi.fn(),
  } satisfies LifecycleBus;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete (globalThis as any).__lcBus;
  vi.restoreAllMocks();
});

// ─── spawn ────────────────────────────────────────────────────────────────

describe('lifecycle.spawn', () => {
  it('inserts a new Entry into the map and returns its info', () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry({ pty: makeFakePty({ pid: 9 }), cwd: '/picked' });
    bus().makeEntry.mockReturnValue(entry);

    const info = L.spawn(sessions as any, 'sid-A', '/work', '/bin/claude');

    expect(sessions.get('sid-A')).toBe(entry);
    expect(info).toEqual({ sid: 'sid-A', pid: 9, cols: 80, rows: 24, cwd: '/picked' });
  });

  it('uses DEFAULT_COLS/ROWS when opts is omitted', () => {
    const sessions = new Map<string, FakeEntry>();
    bus().makeEntry.mockReturnValue(makeFakeEntry());
    L.spawn(sessions as any, 'sid', '/work', '/bin/claude');
    const args = bus().makeEntry.mock.calls[0];
    expect(args[3]).toBe(120); // cols
    expect(args[4]).toBe(30); // rows
  });

  it('passes through explicit cols/rows opts', () => {
    const sessions = new Map<string, FakeEntry>();
    bus().makeEntry.mockReturnValue(makeFakeEntry());
    L.spawn(sessions as any, 'sid', '/work', '/bin/claude', { cols: 200, rows: 50 });
    const args = bus().makeEntry.mock.calls[0];
    expect(args[3]).toBe(200);
    expect(args[4]).toBe(50);
  });

  it('is idempotent — second spawn for the same sid returns existing Entry, no makeEntry call', () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry({ pty: makeFakePty({ pid: 99 }) });
    sessions.set('sid-A', entry);

    const info = L.spawn(sessions as any, 'sid-A', '/work2', '/bin/claude2');

    expect(bus().makeEntry).not.toHaveBeenCalled();
    expect(info.pid).toBe(99);
  });

  it('forwards onCwdRedirect to makeEntry deps', () => {
    const sessions = new Map<string, FakeEntry>();
    bus().makeEntry.mockReturnValue(makeFakeEntry());
    const onCwdRedirect = vi.fn();
    L.spawn(sessions as any, 'sid', '/work', '/bin/claude', { onCwdRedirect });
    const deps = bus().makeEntry.mock.calls[0][5] as { onCwdRedirect?: unknown };
    expect(deps.onCwdRedirect).toBe(onCwdRedirect);
  });

  it('the onExit deps callback removes the entry from the map', () => {
    const sessions = new Map<string, FakeEntry>();
    bus().makeEntry.mockReturnValue(makeFakeEntry());
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

    const out = L.list(sessions as any);
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.sid).sort()).toEqual(['a', 'b']);
    const a = out.find((i) => i.sid === 'a')!;
    expect(a).toEqual({ sid: 'a', pid: 1, cols: 80, rows: 24, cwd: '/a' });
  });

  it('get returns null when sid is not in the map', () => {
    expect(L.get(new Map() as any, 'nope')).toBeNull();
  });

  it('get returns the info for an existing entry', () => {
    const sessions = new Map<string, FakeEntry>();
    sessions.set('s', makeFakeEntry({ cwd: '/c', pty: makeFakePty({ pid: 7 }) }));
    expect(L.get(sessions as any, 's')).toEqual({ sid: 's', pid: 7, cols: 80, rows: 24, cwd: '/c' });
  });
});

// ─── attach / detach ──────────────────────────────────────────────────────

describe('lifecycle.attach and detach', () => {
  it('attach returns null for an unknown sid', () => {
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
    L.input(sessions as any, 's', 'echo hi\n');
    expect(entry.pty.write).toHaveBeenCalledWith('echo hi\n');
  });

  it('is a silent no-op when sid is unknown', () => {
    expect(() => L.input(new Map() as any, 'ghost', 'x')).not.toThrow();
  });

  it('swallows pty.write throws (already-exited race)', () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.write = vi.fn(() => { throw new Error('EPIPE'); });
    sessions.set('s', entry);
    expect(() => L.input(sessions as any, 's', 'x')).not.toThrow();
  });
});

// ─── resize ───────────────────────────────────────────────────────────────

describe('lifecycle.resize', () => {
  it('resizes pty + headless and updates cached cols/rows', () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    sessions.set('s', entry);
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
    L.resize(sessions as any, 's', 1, 40);
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
    expect(() => L.resize(sessions as any, 's', 100, 40)).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('resize s failed'),
    );
  });

  it('is a no-op when sid is unknown', () => {
    expect(L.resize(new Map() as any, 'ghost', 100, 40)).toBeUndefined();
  });
});

// ─── kill / killAll ───────────────────────────────────────────────────────

describe('lifecycle.kill', () => {
  it('resolves to false for an unknown sid (no side effects)', async () => {
    await expect(L.kill(new Map() as any, 'ghost')).resolves.toBe(false);
    expect(bus().killCalls).toEqual([]);
    expect(bus().watcherStopCalls).toEqual([]);
  });

  it('writes \\x03 (Ctrl+C) to the pty as the soft signal — NOT pty.kill() on the graceful path', async () => {
    // Root-cause fix for context-loss on reload: on Windows ConPTY,
    // `pty.kill()` becomes TerminateProcess and claude never runs its
    // SIGINT handler → 100 ms buffered JSONL writes are lost. We send
    // `\x03` instead, which ConPTY translates to CTRL_C_EVENT → SIGINT,
    // letting claude's flush (2 s budget) drain before exit.
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 111;
    // Fire onExit synchronously to simulate claude exiting promptly after SIGINT.
    entry.pty.write = vi.fn(() => entry.pty.__fireExit!());
    sessions.set('s', entry);

    await expect(L.kill(sessions as any, 's')).resolves.toBe(true);
    expect(entry.pty.write).toHaveBeenCalledWith('\x03');
    // Hard kill MUST NOT have been called on the graceful path — that
    // defeats the soft-signal strategy and tears down claude mid-flush.
    expect(entry.pty.kill).not.toHaveBeenCalled();
  });

  it('graceful path: onExit before timeout — processKiller NOT called, subtree left alone', async () => {
    // The whole point of the soft signal: if claude exits cleanly within
    // the flush budget, we MUST NOT walk the process tree (killing it
    // mid-flush would defeat the purpose).
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 4242;
    entry.pty.write = vi.fn(() => { entry.pty.__fireExit!(); });
    sessions.set('s', entry);

    await expect(L.kill(sessions as any, 's')).resolves.toBe(true);
    expect(bus().killCalls).toEqual([]);
    // Watcher still stopped (idempotent, doesn't interfere with claude's writes).
    expect(bus().watcherStopCalls).toEqual(['s']);
  });

  it('still resolves cleanly when pty.write throws (already-exited race)', async () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 7;
    entry.pty.write = vi.fn(() => { throw new Error('EPIPE'); });
    sessions.set('s', entry);
    // write threw, no onExit fired → resolves false via timeout (and
    // escalates to hard kill in the timer branch).
    vi.useFakeTimers();
    const p = L.kill(sessions as any, 's');
    await vi.advanceTimersByTimeAsync(L.KILL_EXIT_TIMEOUT_MS + 10);
    await expect(p).resolves.toBe(false);
    // Hard fallback fired the subtree walk.
    expect(bus().killCalls).toEqual([7]);
    vi.useRealTimers();
  });

  it('always invokes sessionWatcher.stopWatching (belt-and-braces, swallows throws)', async () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    // Fire onExit synchronously on the soft signal so the promise resolves promptly.
    entry.pty.write = vi.fn(() => entry.pty.__fireExit!());
    sessions.set('s', entry);
    bus().watcherStopShouldThrow = true;
    await expect(L.kill(sessions as any, 's')).resolves.toBe(true);
    expect(bus().watcherStopCalls).toEqual(['s']);
  });

  it('registers pty.onExit BEFORE writing \\x03 — regression guard for sync-onExit mocks', async () => {
    // If a future refactor swaps the order, a synchronous onExit fired
    // from inside pty.write (test fakes do this; the real binding can do
    // similar tricks under fast-exit races) would land before the
    // listener was registered → settle never runs → the kill promise
    // either times out (3 s wedge) or worse, the renderer hangs. Lock
    // the order with an explicit call-order assertion.
    const sessions = new Map<string, FakeEntry>();
    const calls: string[] = [];
    const entry = makeFakeEntry();
    entry.pty.pid = 800;
    // Wrap onExit so we record registration order alongside writes.
    const realOnExit = entry.pty.onExit;
    entry.pty.onExit = (cb: () => void) => {
      calls.push('onExit');
      return realOnExit(cb);
    };
    entry.pty.write = vi.fn(() => {
      calls.push('write');
      entry.pty.__fireExit!();
    });
    sessions.set('s', entry);

    await expect(L.kill(sessions as any, 's')).resolves.toBe(true);
    expect(calls[0]).toBe('onExit');
    expect(calls[1]).toBe('write');
  });

  // ─── #1277 review race fix ─────────────────────────────────────────────

  it('awaits pty.onExit before resolving — renderer-attach race fix', async () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 100;
    // pty.write dispatches the soft signal but does NOT auto-fire onExit
    // (claude is still flushing).
    entry.pty.write = vi.fn();
    sessions.set('s', entry);

    const p = L.kill(sessions as any, 's');
    // Soft signal sent synchronously, watcher stopped — but the hard
    // kill / subtree walk MUST NOT have run yet (graceful path).
    expect(entry.pty.write).toHaveBeenCalledWith('\x03');
    expect(entry.pty.kill).not.toHaveBeenCalled();
    expect(bus().killCalls).toEqual([]);

    // The promise must NOT have resolved yet — the renderer awaits this
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
    // Simulates a wedged pty: soft signal sent but the process never exits
    // (claude hung in flush, or the SIGINT was lost). Without the timeout
    // the renderer would hang forever on `await ccsmPty.kill(sid)`.
    entry.pty.write = vi.fn();
    sessions.set('s', entry);

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

  it('wedged fallback: timeout escalates to pty.kill(SIGKILL) + killProcessSubtree', async () => {
    // When the graceful flush budget elapses without onExit, we escalate
    // to the hard kill path: pty.kill('SIGKILL') AND processKiller subtree
    // walk (ConPTY emulates signals, so the subtree walk is what actually
    // reaps claude.exe + its grandchildren on Windows).
    vi.useFakeTimers();
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 500;
    entry.pty.write = vi.fn();
    sessions.set('s', entry);

    const p = L.kill(sessions as any, 's');

    // Before timeout: no hard kill yet, no subtree walk.
    expect(entry.pty.kill).not.toHaveBeenCalled();
    expect(bus().killCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(L.KILL_EXIT_TIMEOUT_MS + 10);
    await expect(p).resolves.toBe(false);

    // Hard escalation fired.
    expect(entry.pty.kill).toHaveBeenCalledWith('SIGKILL');
    expect(bus().killCalls).toEqual([500]);
    // Zombie removed from registry — attach now returns null, letting the
    // renderer's reloadNonce → spawn-on-null fallback create a fresh PTY.
    expect(sessions.has('s')).toBe(false);
    expect(L.attach(sessions as any, 's')).toBeNull();
    vi.useRealTimers();
  });

  it('swallows SIGKILL throws on timeout (still evicts the zombie + walks subtree + logs)', async () => {
    // On Windows node-pty emulates signals; SIGKILL may throw. The timeout
    // path must still delete the entry from the map (else the zombie blocks
    // spawn-on-null forever), still walk the subtree, and not propagate.
    vi.useFakeTimers();
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 600;
    entry.pty.write = vi.fn();
    entry.pty.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') throw new Error('signal not supported');
    });
    sessions.set('s', entry);

    const p = L.kill(sessions as any, 's');
    await vi.advanceTimersByTimeAsync(L.KILL_EXIT_TIMEOUT_MS + 10);
    await expect(p).resolves.toBe(false);

    expect(entry.pty.kill).toHaveBeenCalledWith('SIGKILL');
    // Subtree walk still happens — it's what actually reaps the tree on Windows.
    expect(bus().killCalls).toEqual([600]);
    expect(sessions.has('s')).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('SIGKILL also failed'),
    );
    vi.useRealTimers();
  });

  it('dedupes concurrent kills for the same sid — second call shares the first promise', async () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 300;
    entry.pty.write = vi.fn();
    sessions.set('s', entry);

    const p1 = L.kill(sessions as any, 's');
    const p2 = L.kill(sessions as any, 's');
    // Same promise — second call is a no-op short-circuit, no extra
    // soft-signal writes or watcher-stop calls.
    expect(p1).toBe(p2);
    expect(entry.pty.write).toHaveBeenCalledTimes(1);
    expect(entry.pty.write).toHaveBeenCalledWith('\x03');
    expect(bus().watcherStopCalls).toEqual(['s']);

    // Drain.
    entry.pty.__fireExit!();
    await expect(p1).resolves.toBe(true);
  });

  it('a fresh kill after the previous one completes is NOT deduped', async () => {
    const sessions = new Map<string, FakeEntry>();
    const entry = makeFakeEntry();
    entry.pty.pid = 400;
    entry.pty.write = vi.fn(() => entry.pty.__fireExit!());
    sessions.set('s', entry);

    await L.kill(sessions as any, 's');
    // Re-add the entry (simulating spawn-on-null fallback creating a new pty
    // for the same sid) and kill again — this must NOT short-circuit.
    sessions.set('s', entry);
    await L.kill(sessions as any, 's');
    expect(entry.pty.write).toHaveBeenCalledTimes(2);
  });
});

describe('lifecycle.killAll', () => {
  it('sends the soft signal to every entry and returns a Promise that resolves when all kills settle', async () => {
    const sessions = new Map<string, FakeEntry>();
    const a = makeFakeEntry({ pty: makeFakePty({ pid: 1 }) });
    const b = makeFakeEntry({ pty: makeFakePty({ pid: 2 }) });
    const c = makeFakeEntry({ pty: makeFakePty({ pid: 3 }) });
    // Fire onExit synchronously inside the soft-signal write so every per-sid
    // kill resolves promptly — the killAll Promise should resolve after
    // ALL of them settle.
    a.pty.write = vi.fn(() => a.pty.__fireExit!());
    b.pty.write = vi.fn(() => b.pty.__fireExit!());
    c.pty.write = vi.fn(() => c.pty.__fireExit!());
    sessions.set('a', a);
    sessions.set('b', b);
    sessions.set('c', c);

    const result = L.killAll(sessions as any);
    // killAll must return a Promise (before-quit awaits it to give claude
    // time to flush before Electron tears down — see appLifecycle.ts).
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();

    // Each pty received the Ctrl+C soft signal.
    expect(a.pty.write).toHaveBeenCalledWith('\x03');
    expect(b.pty.write).toHaveBeenCalledWith('\x03');
    expect(c.pty.write).toHaveBeenCalledWith('\x03');
    // Watcher stopped synchronously for each sid.
    expect(bus().watcherStopCalls.sort()).toEqual(['a', 'b', 'c']);
    // No hard kill / subtree walk — graceful path completed for all.
    expect(bus().killCalls).toEqual([]);
  });

  it('killAll Promise does NOT resolve until every per-session kill settles', async () => {
    const sessions = new Map<string, FakeEntry>();
    const fast = makeFakeEntry({ pty: makeFakePty({ pid: 10 }) });
    const slow = makeFakeEntry({ pty: makeFakePty({ pid: 11 }) });
    // fast exits immediately; slow stays wedged until we manually fire onExit.
    fast.pty.write = vi.fn(() => fast.pty.__fireExit!());
    slow.pty.write = vi.fn();
    sessions.set('fast', fast);
    sessions.set('slow', slow);

    const p = L.killAll(sessions as any);
    let resolved: 'pending' | 'done' = 'pending';
    void p.then(() => { resolved = 'done'; });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe('pending');

    slow.pty.__fireExit!();
    await expect(p).resolves.toBeUndefined();
    expect(resolved).toBe('done');
  });

  it('snapshots the keys before iterating — safe against concurrent mutation', async () => {
    const sessions = new Map<string, FakeEntry>();
    const a = makeFakeEntry();
    const b = makeFakeEntry();
    a.pty.write = vi.fn(() => a.pty.__fireExit!());
    b.pty.write = vi.fn(() => b.pty.__fireExit!());
    sessions.set('a', a);
    sessions.set('b', b);
    await L.killAll(sessions as any);
    expect(bus().watcherStopCalls).toHaveLength(2);
  });

  it('killAll over an empty map resolves immediately with no side effects', async () => {
    await expect(L.killAll(new Map() as any)).resolves.toBeUndefined();
    expect(bus().killCalls).toEqual([]);
    expect(bus().watcherStopCalls).toEqual([]);
  });
});
