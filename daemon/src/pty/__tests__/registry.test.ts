// Tests for the daemon-side PTY registry singleton (Task #108).
//
// The registry is exercised against a stub `pty.spawn` so the tests do
// not actually fork a child. Behaviour pinned:
//   - spawn() seats the entry, populates fanout, calls registerChildPid.
//   - input() / resize() forward to the IPty (and, for resize, to the
//     headless mirror).
//   - get() / list() / size() / getChildPids() / getState() report
//     accurate snapshots.
//   - kill() flips shuttingDown + drives the FSM running → shutting_down
//     and invokes killGracefully exactly once per call.
//   - PTY data chunks fan out to subscribers with monotonic seq + the
//     headless mirror writes (proven via serialize().length growing).
//   - PTY exit drains fan-out subscribers and unregisters the PID.
//   - windDown SIGTERMs everyone, awaits per-child deadline, escalates
//     to terminal-kill for survivors, and FSM-pauses any non-exited
//     entry (frag-3.5.1 §3.5.1.2 step 8).
//   - closeAllSubscribers drains every session entry on the fanout.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as pty from 'node-pty';
import { createPtyRegistry } from '../registry.js';
import type { PtySubscribeFrame } from '../../handlers/pty-subscribe.js';

// ---------------------------------------------------------------------------
// Stub IPty — emits whatever the test pushes into `emitData` / `emitExit`.
// ---------------------------------------------------------------------------

interface StubIPty extends pty.IPty {
  /** Test seam — push a chunk through the onData pump. */
  emitData(chunk: string): void;
  /** Test seam — fire onExit. */
  emitExit(exitCode: number, signal?: number): void;
  /** Test introspection. */
  readonly _killCalls: Array<string | undefined>;
  readonly _writeCalls: string[];
  readonly _resizeCalls: Array<{ cols: number; rows: number }>;
}

let nextStubPid = 10000;

function makeStubPty(): StubIPty {
  let dataCb: ((s: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  const killCalls: Array<string | undefined> = [];
  const writeCalls: string[] = [];
  const resizeCalls: Array<{ cols: number; rows: number }> = [];
  const stub = {
    pid: nextStubPid++,
    cols: 120,
    rows: 30,
    process: 'stub',
    handleFlowControl: false,
    onData: (cb: (s: string) => void) => {
      dataCb = cb;
      return { dispose: () => undefined };
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitCb = cb;
      return { dispose: () => undefined };
    },
    write: (s: string) => {
      writeCalls.push(s);
    },
    resize: (cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
    },
    kill: (signal?: string) => {
      killCalls.push(signal);
    },
    pause: () => undefined,
    resume: () => undefined,
    clear: () => undefined,
    emitData: (chunk: string) => {
      dataCb?.(chunk);
    },
    emitExit: (exitCode: number, signal?: number) => {
      exitCb?.({
        exitCode,
        ...(signal !== undefined ? { signal } : {}),
      });
    },
    _killCalls: killCalls,
    _writeCalls: writeCalls,
    _resizeCalls: resizeCalls,
  } as unknown as StubIPty;
  return stub;
}

interface Harness {
  registry: ReturnType<typeof createPtyRegistry>;
  pids: number[];
  unregistered: Array<{ sid: string; pid: number }>;
  killGraceful: ReturnType<typeof vi.fn>;
  killTerminal: ReturnType<typeof vi.fn>;
  pendingStubs: Map<string, StubIPty>;
}

function makeHarness(): Harness {
  const pids: number[] = [];
  const unregistered: Array<{ sid: string; pid: number }> = [];
  const killGraceful = vi.fn();
  const killTerminal = vi.fn();
  const pendingStubs = new Map<string, StubIPty>();

  const registry = createPtyRegistry({
    registerChildPid: (_sid, pid) => pids.push(pid),
    unregisterChildPid: (sid, pid) => unregistered.push({ sid, pid }),
    killGracefully: killGraceful,
    killTerminally: killTerminal,
    spawn: (_command, _args, _opts) => {
      // Pull the next stub the test pre-allocated for THIS spawn. The
      // test scope passes sid via _opts.env so we can pair them.
      const sid = (_opts as { env: { TEST_SID: string } }).env.TEST_SID;
      const stub = pendingStubs.get(sid);
      if (!stub) {
        throw new Error(`no pending stub for sid ${sid}`);
      }
      pendingStubs.delete(sid);
      return stub;
    },
  });

  return {
    registry,
    pids,
    unregistered,
    killGraceful,
    killTerminal,
    pendingStubs,
  };
}

function spawnStub(h: Harness, sid: string, cwd = '/tmp'): StubIPty {
  const stub = makeStubPty();
  h.pendingStubs.set(sid, stub);
  h.registry.spawn({
    sid,
    command: 'fake-claude',
    args: ['--session-id', sid],
    cwd,
    cols: 80,
    rows: 24,
    env: { TEST_SID: sid } as NodeJS.ProcessEnv,
  });
  return stub;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('pty/registry', () => {
  it('spawn seats entry, registers PID, FSM running', () => {
    const h = makeHarness();
    const stub = spawnStub(h, 'sid-A');
    const e = h.registry.get('sid-A');
    expect(e).toBeDefined();
    expect(e?.pid).toBe(stub.pid);
    expect(h.pids).toEqual([stub.pid]);
    expect(h.registry.size()).toBe(1);
    expect(h.registry.getState('sid-A')).toBe('running');
    expect(h.registry.getChildPids()).toEqual([stub.pid]);
  });

  it('refuses double-spawn for same sid', () => {
    const h = makeHarness();
    spawnStub(h, 'sid-A');
    expect(() => spawnStub(h, 'sid-A')).toThrow(/already registered/);
  });

  it('input forwards to pty.write; resize forwards + bumps headless', () => {
    const h = makeHarness();
    const stub = spawnStub(h, 'sid-A');
    h.registry.input('sid-A', 'echo hi\n');
    expect(stub._writeCalls).toEqual(['echo hi\n']);
    h.registry.resize('sid-A', 100, 40);
    expect(stub._resizeCalls).toEqual([{ cols: 100, rows: 40 }]);
    const e = h.registry.get('sid-A')!;
    expect(e.cols).toBe(100);
    expect(e.rows).toBe(40);
  });

  it('resize ignores invalid dimensions (no throw)', () => {
    const h = makeHarness();
    const stub = spawnStub(h, 'sid-A');
    h.registry.resize('sid-A', 0, 24);
    h.registry.resize('sid-A', 80, -1);
    h.registry.resize('sid-A', 80.5, 24);
    expect(stub._resizeCalls).toEqual([]);
  });

  it('input/resize on unknown sid is a no-op', () => {
    const h = makeHarness();
    expect(() => h.registry.input('nope', 'x')).not.toThrow();
    expect(() => h.registry.resize('nope', 80, 24)).not.toThrow();
  });

  it('PTY data fans out with monotonic seq + writes to headless', () => {
    const h = makeHarness();
    const stub = spawnStub(h, 'sid-A');

    const received: PtySubscribeFrame[] = [];
    h.registry.fanout.subscribe('sid-A', {
      deliver: (f) => received.push(f),
      close: () => undefined,
    });

    stub.emitData('hello');
    stub.emitData('world');

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ kind: 'delta', seq: 1 });
    expect(received[1]).toMatchObject({ kind: 'delta', seq: 2 });
    expect(Buffer.from((received[0] as { data: Uint8Array }).data).toString('utf8')).toBe('hello');

    const e = h.registry.get('sid-A')!;
    expect(e.seq).toBe(2);
    // Snapshot reflects what was written.
    return h.registry.snapshot('sid-A').then((snap) => {
      expect(snap).not.toBeNull();
      expect(snap!.seq).toBe(2);
      expect(snap!.buffer).toContain('helloworld');
    });
  });

  it('PTY exit drains subscribers + unregisters PID + drops entry', () => {
    const h = makeHarness();
    const stub = spawnStub(h, 'sid-A');

    const closes: Array<{ kind: string }> = [];
    h.registry.fanout.subscribe('sid-A', {
      deliver: () => undefined,
      close: (r) => closes.push({ kind: r.kind }),
    });

    stub.emitExit(0);

    expect(closes).toEqual([{ kind: 'pty-exit' }]);
    expect(h.unregistered).toEqual([{ sid: 'sid-A', pid: stub.pid }]);
    expect(h.registry.get('sid-A')).toBeUndefined();
    expect(h.registry.size()).toBe(0);
  });

  it('non-zero exit code drains as pty-crashed', () => {
    const h = makeHarness();
    const stub = spawnStub(h, 'sid-A');
    const closes: Array<{ kind: string }> = [];
    h.registry.fanout.subscribe('sid-A', {
      deliver: () => undefined,
      close: (r) => closes.push({ kind: r.kind }),
    });
    stub.emitExit(1, 15);
    expect(closes).toEqual([{ kind: 'pty-crashed' }]);
  });

  it('kill() flips shuttingDown + invokes killGracefully exactly once', () => {
    const h = makeHarness();
    const stub = spawnStub(h, 'sid-A');
    expect(h.registry.kill('sid-A')).toBe(true);
    expect(h.killGraceful).toHaveBeenCalledTimes(1);
    // Repeat is a no-op.
    expect(h.registry.kill('sid-A')).toBe(false);
    expect(h.killGraceful).toHaveBeenCalledTimes(1);
    expect(h.registry.getState('sid-A')).toBe('shutting_down');
    void stub;
  });

  it('windDown: clean exit within deadline → no terminal-kill', async () => {
    const h = makeHarness();
    const stub = spawnStub(h, 'sid-A');
    h.killGraceful.mockImplementation((entry) => {
      // Simulate the PTY honoring SIGTERM right away.
      void entry;
      queueMicrotask(() => stub.emitExit(0));
    });

    await h.registry.windDown({ perChildDeadlineMs: 200 });

    expect(h.killGraceful).toHaveBeenCalledTimes(1);
    expect(h.killTerminal).not.toHaveBeenCalled();
    expect(h.registry.size()).toBe(0);
  });

  it('windDown: hung child → terminal-kill + FSM pause', async () => {
    const h = makeHarness();
    const stub = spawnStub(h, 'sid-A');
    // killGracefully does nothing — child hangs through the deadline.
    await h.registry.windDown({ perChildDeadlineMs: 50 });
    expect(h.killGraceful).toHaveBeenCalledTimes(1);
    expect(h.killTerminal).toHaveBeenCalledTimes(1);
    // Entry survives because no exit fired; FSM is paused per
    // §3.5.1.2 step 8.
    expect(h.registry.getState('sid-A')).toBe('paused');
    expect(h.registry.size()).toBe(1);
    void stub;
  });

  it('windDown across many entries: parallel + per-child deadline honoured', async () => {
    const h = makeHarness();
    const stubs = ['a', 'b', 'c'].map((sid) => spawnStub(h, sid));
    // Two of three exit cleanly; one hangs.
    h.killGraceful.mockImplementation((entry) => {
      if (entry.sid === 'a' || entry.sid === 'b') {
        queueMicrotask(() => {
          const stub = stubs.find((s) => s.pid === entry.pid)!;
          stub.emitExit(0);
        });
      }
    });

    const t0 = Date.now();
    await h.registry.windDown({ perChildDeadlineMs: 80 });
    const dt = Date.now() - t0;

    // Per-child runs in parallel; total wall-time should not greatly
    // exceed one perChildDeadlineMs window. Generous upper bound for
    // CI variance.
    expect(dt).toBeLessThan(800);
    expect(h.killTerminal).toHaveBeenCalledTimes(1);
    expect(h.registry.size()).toBe(1); // only the hung one survives
    expect(h.registry.getState('c')).toBe('paused');
  });

  it('closeAllSubscribers drains every session entry, returns count', () => {
    const h = makeHarness();
    spawnStub(h, 'sid-A');
    spawnStub(h, 'sid-B');
    const closeA = vi.fn();
    const closeB1 = vi.fn();
    const closeB2 = vi.fn();
    h.registry.fanout.subscribe('sid-A', { deliver: () => undefined, close: closeA });
    h.registry.fanout.subscribe('sid-B', { deliver: () => undefined, close: closeB1 });
    h.registry.fanout.subscribe('sid-B', { deliver: () => undefined, close: closeB2 });

    const n = h.registry.closeAllSubscribers({ kind: 'daemon-shutdown' });

    expect(n).toBe(3);
    expect(closeA).toHaveBeenCalledWith({ kind: 'daemon-shutdown' });
    expect(closeB1).toHaveBeenCalled();
    expect(closeB2).toHaveBeenCalled();
  });

  it('killAll fires terminal-kill on every non-exited entry', () => {
    const h = makeHarness();
    spawnStub(h, 'sid-A');
    spawnStub(h, 'sid-B');
    h.registry.killAll();
    expect(h.killTerminal).toHaveBeenCalledTimes(2);
  });

  it('list/getChildPids reflect live state', () => {
    const h = makeHarness();
    const a = spawnStub(h, 'sid-A', '/work/a');
    const b = spawnStub(h, 'sid-B', '/work/b');
    const list = h.registry.list();
    expect(list).toHaveLength(2);
    const sids = list.map((s) => s.sid).sort();
    expect(sids).toEqual(['sid-A', 'sid-B']);
    const pids = h.registry.getChildPids().slice().sort();
    expect(pids).toEqual([a.pid, b.pid].sort());
  });
});
