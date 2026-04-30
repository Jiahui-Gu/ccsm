// L4 PR-E (#864): pins the detach/reattach contract — a visible-xterm
// reattach must replay every PTY chunk that arrived while detached, fed
// from the headless authoritative buffer (PR-A) via getBufferSnapshot
// (PR-B), with NO request to the PTY for re-emission.
//
// What this proves end-to-end (main-process side):
//   1. While detached (`entry.attached.size === 0`), `dispatchPtyChunk`
//      keeps writing every chunk to the headless mirror — backlog
//      preserved.
//   2. While detached, the backpressure warn is suppressed (no human
//      consumer; would be log noise on long-running background sessions).
//      Re-attach restores normal threshold semantics.
//   3. Re-attach replays via `serialize.serialize()` snapshot (this is
//      the same path lifecycle.getBufferSnapshot uses) — captured atomically
//      with `entry.seq`. Live chunks delivered AFTER the snapshot can be
//      deduped by the renderer using `seq > snapSeq`.
//   4. Multiple detach/reattach/detach/reattach cycles preserve a
//      monotonic seq — no wrap, no decrement, no double-fanout.
//   5. The PTY is never asked to re-emit; the only `pty.write` calls
//      come from explicit user input (zero in this test).
//
// Out of scope (other PRs / dogfood): real Electron IPC roundtrip,
// renderer-side xterm.write, multi-window fanout collisions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface PtyFakeBus {
  onData: ((chunk: string) => void) | null;
  onExit: ((evt: { exitCode: number | null; signal: number | null }) => void) | null;
  ptySpawn: ReturnType<typeof vi.fn>;
  ptyWrite: ReturnType<typeof vi.fn>;
  headlessDispose: ReturnType<typeof vi.fn>;
  // We model the headless buffer as a plain string accumulator so the
  // test can compare "what was written into the buffer" to "what a
  // reattach snapshot replays" — full L4 contract.
  headlessBuffer: string;
  watcherStart: ReturnType<typeof vi.fn>;
  watcherStop: ReturnType<typeof vi.fn>;
  ensureJsonl: ReturnType<typeof vi.fn>;
  emitData: ReturnType<typeof vi.fn>;
  sourceJsonl: string | null;
  ensureCopied: boolean;
  // When true, headless.write defers its callback so tests can simulate
  // a slow main-thread / scrollback flush and check pending counters.
  deferHeadlessWrite: boolean;
  pendingCallbacks: Array<() => void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bus(): PtyFakeBus { return (globalThis as any).__pf as PtyFakeBus; }

vi.mock('node-pty', () => ({
  spawn: (...a: unknown[]) => {
    const b = bus();
    b.ptySpawn(...a);
    return {
      pid: 7777,
      onData: (cb: (chunk: string) => void) => { b.onData = cb; },
      onExit: (cb: (evt: { exitCode: number | null; signal: number | null }) => void) => {
        b.onExit = cb;
      },
      // Capture pty.write so we can assert NO re-emission was requested
      // during reattach — the whole point of L4 is "buffer replays, not pty".
      write: (...wa: unknown[]) => bus().ptyWrite(...wa),
      resize: vi.fn(),
      kill: vi.fn(),
    };
  },
}));

vi.mock('@xterm/headless', () => ({
  Terminal: class {
    write = (data: unknown, callback?: () => void) => {
      const b = bus();
      if (typeof data === 'string') b.headlessBuffer += data;
      if (callback) {
        if (b.deferHeadlessWrite) b.pendingCallbacks.push(callback);
        else callback();
      }
    };
    dispose = () => bus().headlessDispose();
    loadAddon = vi.fn();
    resize = vi.fn();
  },
}));

vi.mock('@xterm/addon-serialize', () => ({
  // The fake serializer returns whatever the headless buffer has
  // accumulated. This mirrors the real SerializeAddon.serialize() output
  // shape closely enough for the L4 contract (renderer just writes it
  // back into a fresh xterm).
  SerializeAddon: class {
    serialize = () => bus().headlessBuffer;
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

import { makeEntry, dispatchPtyChunk, BACKPRESSURE_WARN_THRESHOLD } from '../entryFactory';
import { getBufferSnapshot } from '../lifecycle';
import type { Entry } from '../entryFactory';

// Models a "visible xterm" attached webContents. Records every chunk it
// receives so we can compare to what the headless buffer accumulated
// (the L4 invariant: visible xterm sees exactly what headless saw,
// modulo the snapshot replay seam).
interface FakeWc {
  id: number;
  destroyed: boolean;
  received: Array<{ chunk: string; seq: number }>;
  isDestroyed: () => boolean;
  send: (ch: string, payload: { sid: string; chunk: string; seq: number }) => void;
}

function makeFakeWc(id: number): FakeWc {
  const wc: FakeWc = {
    id,
    destroyed: false,
    received: [],
    isDestroyed: () => wc.destroyed,
    send: (_ch, payload) => {
      wc.received.push({ chunk: payload.chunk, seq: payload.seq });
    },
  };
  return wc;
}

function freshBus(): PtyFakeBus {
  return {
    onData: null,
    onExit: null,
    ptySpawn: vi.fn(),
    ptyWrite: vi.fn(),
    headlessDispose: vi.fn(),
    headlessBuffer: '',
    watcherStart: vi.fn(),
    watcherStop: vi.fn(),
    ensureJsonl: vi.fn(),
    emitData: vi.fn(),
    sourceJsonl: null,
    ensureCopied: false,
    deferHeadlessWrite: false,
    pendingCallbacks: [],
  };
}

describe('L4 PR-E: detach/reattach via headless buffer (#864)', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__pf = freshBus();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__pf;
  });

  it('detached: PTY chunks accumulate in headless, no visible-xterm writes (no attached wc)', () => {
    const entry = makeEntry('sid-D', '/work', '/bin/claude', 80, 24, { onExit: vi.fn() });
    expect(entry.attached.size).toBe(0);

    // Drive PTY data while detached.
    bus().onData!('chunk-1');
    bus().onData!('chunk-2');
    bus().onData!('chunk-3');

    expect(bus().headlessBuffer).toBe('chunk-1chunk-2chunk-3');
    expect(entry.seq).toBe(3);
    // PTY must never be asked to re-emit. We only write input.
    expect(bus().ptyWrite).not.toHaveBeenCalled();
  });

  it('reattach: snapshot replays the entire detached backlog from headless (no PTY re-emit)', async () => {
    const sessions = new Map<string, Entry>();
    const entry = makeEntry('sid-R', '/work', '/bin/claude', 80, 24, { onExit: vi.fn() });
    sessions.set('sid-R', entry);

    // Background activity while no visible xterm is attached.
    bus().onData!('hello ');
    bus().onData!('world\n');
    bus().onData!('line-2\n');

    // Visible xterm appears (reattach). PR-B contract: caller calls
    // getBufferSnapshot, writes snapshot, then drains buffered chunks
    // with seq > snapSeq. Here we test the main-side: snapshot must
    // contain the full backlog, and seq must reflect entry.seq.
    const snap = await getBufferSnapshot(sessions, 'sid-R');
    expect(snap.snapshot).toBe('hello world\nline-2\n');
    expect(snap.seq).toBe(3);

    // Now register a wc (the freshly-mounted visible xterm).
    const wc = makeFakeWc(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry.attached.set(wc.id, wc as any);

    // A live chunk arrives strictly AFTER the snapshot — must be
    // delivered with seq > snapSeq so the renderer keeps it.
    bus().onData!('post-snap');
    expect(wc.received).toEqual([{ chunk: 'post-snap', seq: 4 }]);
    expect(wc.received[0].seq).toBeGreaterThan(snap.seq);

    // PTY was never asked to replay anything.
    expect(bus().ptyWrite).not.toHaveBeenCalled();
  });

  it('multi-cycle detach/reattach/detach/reattach: no data loss, monotonic seq, headless buffer is the SoT', async () => {
    const sessions = new Map<string, Entry>();
    const entry = makeEntry('sid-M', '/work', '/bin/claude', 80, 24, { onExit: vi.fn() });
    sessions.set('sid-M', entry);

    // Cycle 1: detached burst.
    bus().onData!('A1');
    bus().onData!('A2');
    let snap = await getBufferSnapshot(sessions, 'sid-M');
    expect(snap.snapshot).toBe('A1A2');
    expect(snap.seq).toBe(2);

    // Cycle 1 attach.
    const wc1 = makeFakeWc(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry.attached.set(wc1.id, wc1 as any);
    bus().onData!('A3');
    expect(wc1.received).toEqual([{ chunk: 'A3', seq: 3 }]);

    // Cycle 1 detach (visible xterm goes away — pane closed / sid switched).
    entry.attached.delete(wc1.id);
    expect(entry.attached.size).toBe(0);

    // Cycle 2: another detached burst (background session activity).
    bus().onData!('B1');
    bus().onData!('B2');
    bus().onData!('B3');
    expect(bus().headlessBuffer).toBe('A1A2A3B1B2B3');

    // Cycle 2 reattach: a NEW visible xterm (e.g. user navigated back
    // to this session) gets a snapshot covering everything so far.
    snap = await getBufferSnapshot(sessions, 'sid-M');
    expect(snap.snapshot).toBe('A1A2A3B1B2B3');
    expect(snap.seq).toBe(6);
    // seq strictly increased across cycles.
    expect(snap.seq).toBeGreaterThan(3);

    const wc2 = makeFakeWc(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry.attached.set(wc2.id, wc2 as any);
    bus().onData!('C1');
    expect(wc2.received).toEqual([{ chunk: 'C1', seq: 7 }]);
    // wc1 (already detached) MUST NOT have received C1.
    expect(wc1.received).toEqual([{ chunk: 'A3', seq: 3 }]);

    // Cycle 3: detach + reattach within the same wc id reuse (a Retry
    // flow in the renderer that recreates the visible xterm). seq still
    // monotonic from headless's POV.
    entry.attached.delete(wc2.id);
    bus().onData!('D1');
    bus().onData!('D2');
    snap = await getBufferSnapshot(sessions, 'sid-M');
    expect(snap.snapshot).toBe('A1A2A3B1B2B3C1D1D2');
    expect(snap.seq).toBe(9);

    const wc3 = makeFakeWc(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry.attached.set(wc3.id, wc3 as any);
    bus().onData!('E1');
    expect(wc3.received).toEqual([{ chunk: 'E1', seq: 10 }]);

    // Across all three cycles the PTY was never asked to replay.
    expect(bus().ptyWrite).not.toHaveBeenCalled();
  });

  it('snapshot replay round-trips byte-for-byte through a new visible xterm (drain seam holds)', async () => {
    // Simulates the exact PR-B renderer flow against the main-side
    // contract: install live listener (buffer chunks) → request snapshot
    // → write snapshot to "visible" → drain buffered with seq > snapSeq.
    const sessions = new Map<string, Entry>();
    const entry = makeEntry('sid-X', '/work', '/bin/claude', 80, 24, { onExit: vi.fn() });
    sessions.set('sid-X', entry);

    // Background activity.
    bus().onData!('past-1');
    bus().onData!('past-2');

    // Reattach: register wc THEN start the snapshot await. Live chunks
    // that arrive between the IPC-attach instant and the snapshot
    // landing in the renderer must be deduped — the renderer's listener
    // captures them with their seq and drops anything seq <= snapSeq.
    const wc = makeFakeWc(1);
    const liveBuffered: Array<{ chunk: string; seq: number }> = [];
    // Replace the wc.send so we can route to "buffered listener" before
    // snapshot, then to the visible terminal after.
    let snapSeq: number | null = null;
    const visibleTerminal: string[] = [];
    wc.send = (_ch, payload) => {
      if (snapSeq === null) {
        liveBuffered.push({ chunk: payload.chunk, seq: payload.seq });
      } else if (payload.seq > snapSeq) {
        visibleTerminal.push(payload.chunk);
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry.attached.set(wc.id, wc as any);

    // A live chunk arrives DURING the snapshot await; PR-B race window.
    const snapPromise = getBufferSnapshot(sessions, 'sid-X');
    bus().onData!('live-during');
    const snap = await snapPromise;

    // Renderer writes the snapshot and flips into "drain" mode.
    visibleTerminal.push(snap.snapshot);
    snapSeq = snap.seq;
    for (const b of liveBuffered) {
      if (b.seq > snapSeq) visibleTerminal.push(b.chunk);
    }

    // After this point all live chunks go straight in.
    bus().onData!('post-attach');

    // Visible terminal saw: snapshot (past-1 + past-2) + live-during +
    // post-attach. NO duplicate of past-1 / past-2.
    const visible = visibleTerminal.join('');
    expect(visible).toBe('past-1past-2live-duringpost-attach');
    // Sanity: the headless SoT matches.
    expect(bus().headlessBuffer).toBe('past-1past-2live-duringpost-attach');
  });

  it('backpressure warn is SUPPRESSED while detached, RESUMES once a visible xterm reattaches', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entry = makeEntry('sid-BP', '/work', '/bin/claude', 80, 24, { onExit: vi.fn() });
    bus().deferHeadlessWrite = true;
    const threshold = BACKPRESSURE_WARN_THRESHOLD;

    // Detached: dispatch threshold+1 chunks. Counter crosses the
    // threshold, but with no attached wc the warn must NOT fire (PR-E
    // suppression: no human consumer to warn for).
    for (let i = 0; i < threshold + 1; i++) {
      dispatchPtyChunk('sid-BP', entry, `det-${i}`);
    }
    const detachedWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('backpressure'),
    );
    expect(detachedWarns).toHaveLength(0);
    // ...and yet every chunk reached the headless buffer (no drop).
    expect(bus().headlessBuffer.startsWith('det-0det-1')).toBe(true);
    // Pending count crossed the threshold (we deferred all callbacks).
    expect(entry.pendingHeadlessWrites).toBe(threshold + 1);

    // Drain so the next burst starts from a clean counter.
    for (const cb of bus().pendingCallbacks) cb();
    bus().pendingCallbacks = [];
    expect(entry.pendingHeadlessWrites).toBe(0);

    // Reattach: register a wc, then dispatch another over-threshold burst.
    // Now the warn MUST fire (visible consumer is present and the lag
    // is real-user-affecting).
    const wc = makeFakeWc(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entry.attached.set(wc.id, wc as any);
    warnSpy.mockClear();
    for (let i = 0; i < threshold + 1; i++) {
      dispatchPtyChunk('sid-BP', entry, `att-${i}`);
    }
    const attachedWarns = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('backpressure'),
    );
    expect(attachedWarns.length).toBeGreaterThanOrEqual(1);
  });
});
