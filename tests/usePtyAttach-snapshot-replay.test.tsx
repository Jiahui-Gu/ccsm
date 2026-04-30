// L4 PR-B (#865): visible xterm attach replays from headless via the new
// `pty:getBufferSnapshot` IPC, then transitions to live `pty:data` stream
// without dropping or duplicating chunks.
//
// Pins the snapshot-then-live contract:
//   1. After attach, usePtyAttach calls window.ccsmPty.getBufferSnapshot(sid).
//   2. The returned snapshot is written to the visible terminal.
//   3. Live chunks delivered BEFORE the snapshot resolves are buffered and
//      drained AFTER (filtered by seq > snapshot.seq) so nothing is lost.
//   4. Live chunks delivered AFTER the snapshot are written directly.
//   5. Re-attaching for a fresh sid (switch session) repeats the same flow
//      and the second snapshot lands without losing the interleaved chunk.
//
// We mock window.ccsmPty + the xterm singleton so no real PTY / xterm is
// constructed. The hook drives the state machine; we assert ordered writes
// against the mocked Terminal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePtyAttach } from '../src/terminal/usePtyAttach';
import * as singleton from '../src/terminal/xtermSingleton';

type DataCb = (e: { sid: string; chunk: string; seq: number }) => void;
type ExitCb = (e: { sessionId: string; code?: number | null; signal?: string | number | null }) => void;

interface MockState {
  writes: string[];
  attachCalls: string[];
  spawnCalls: Array<{ sid: string; cwd: string }>;
  detachCalls: string[];
  snapshotCalls: string[];
  resizeCalls: Array<{ sid: string; cols: number; rows: number }>;
  // Test-controlled snapshot resolver — caller awaits this Promise to
  // simulate the chunked-yield delay so we can fire live chunks DURING
  // the await.
  pendingSnapshot: { resolve: (v: { snapshot: string; seq: number }) => void; promise: Promise<{ snapshot: string; seq: number }> } | null;
  dataCbs: Set<DataCb>;
  exitCbs: Set<ExitCb>;
}

let M: MockState;

function freshState(): MockState {
  return {
    writes: [],
    attachCalls: [],
    spawnCalls: [],
    detachCalls: [],
    snapshotCalls: [],
    resizeCalls: [],
    pendingSnapshot: null,
    dataCbs: new Set(),
    exitCbs: new Set(),
  };
}

function newPendingSnapshot(): MockState['pendingSnapshot'] {
  let resolveFn!: (v: { snapshot: string; seq: number }) => void;
  const promise = new Promise<{ snapshot: string; seq: number }>((r) => { resolveFn = r; });
  return { resolve: resolveFn, promise };
}

function installMockTerminal(): void {
  const term = {
    write: (s: string) => { M.writes.push(s); },
    reset: () => { /* no-op for the mock */ },
    resize: (_c: number, _r: number) => { /* no-op */ },
    focus: () => { /* no-op */ },
    onData: (_cb: (data: string) => void) => ({ dispose: () => {} }),
    cols: 80,
    rows: 24,
  } as unknown as Parameters<typeof singleton.setActiveSid>[0] extends never ? never : ReturnType<typeof singleton.getTerm>;
  // The mock has only the surface usePtyAttach touches.
  vi.spyOn(singleton, 'getTerm').mockReturnValue(term as ReturnType<typeof singleton.getTerm>);
  vi.spyOn(singleton, 'getFit').mockReturnValue({
    proposeDimensions: () => ({ cols: 80, rows: 24 }),
    fit: () => {},
  } as unknown as ReturnType<typeof singleton.getFit>);
}

function installCcsmPty(): void {
  const ccsmPty = {
    list: vi.fn(),
    spawn: vi.fn(async (sid: string, cwd: string) => {
      M.spawnCalls.push({ sid, cwd });
      return { ok: true as const, sid, pid: 1234, cols: 80, rows: 24 };
    }),
    attach: vi.fn(async (sid: string) => {
      M.attachCalls.push(sid);
      // PR-B: attach IPC return value is no longer load-bearing for snapshot;
      // we keep the legacy shape because usePtyAttach still reads cols/rows
      // but the snapshot field is now ignored in favour of getBufferSnapshot.
      return { snapshot: '', cols: 80, rows: 24, pid: 1234 };
    }),
    detach: vi.fn(async (sid: string) => { M.detachCalls.push(sid); }),
    input: vi.fn(),
    resize: vi.fn(async (sid: string, cols: number, rows: number) => {
      M.resizeCalls.push({ sid, cols, rows });
    }),
    kill: vi.fn(),
    get: vi.fn(),
    getBufferSnapshot: vi.fn(async (sid: string) => {
      M.snapshotCalls.push(sid);
      const pending = M.pendingSnapshot;
      if (!pending) {
        // Synchronous default: empty buffer at seq 0.
        return { snapshot: '', seq: 0 };
      }
      return pending.promise;
    }),
    onData: (cb: DataCb) => {
      M.dataCbs.add(cb);
      return () => { M.dataCbs.delete(cb); };
    },
    onExit: (cb: ExitCb) => {
      M.exitCbs.add(cb);
      return () => { M.exitCbs.delete(cb); };
    },
    clipboard: {
      readText: () => '',
      writeText: () => {},
    },
    checkClaudeAvailable: vi.fn(),
  };
  (window as unknown as { ccsmPty: typeof ccsmPty }).ccsmPty = ccsmPty;
}

function emitData(sid: string, chunk: string, seq: number): void {
  for (const cb of M.dataCbs) {
    cb({ sid, chunk, seq });
  }
}

describe('usePtyAttach — snapshot-then-live replay (L4 PR-B)', () => {
  beforeEach(() => {
    M = freshState();
    installMockTerminal();
    installCcsmPty();
    singleton.setActiveSid(null);
    singleton.setUnsubscribeData(null);
    singleton.setInputDisposable(null);
    singleton.setSnapshotReplay(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
  });

  it('calls getBufferSnapshot after attach and writes the snapshot to the visible terminal', async () => {
    M.pendingSnapshot = newPendingSnapshot();
    const { result } = renderHook(() => usePtyAttach('sid-A', '/tmp'));

    // The attach IPC fires synchronously; getBufferSnapshot is called with
    // the same sid right after.
    await waitFor(() => {
      expect(M.attachCalls).toContain('sid-A');
      expect(M.snapshotCalls).toContain('sid-A');
    });

    // Snapshot still pending — visible terminal must not have written
    // anything yet (we ignore the legacy attach.snapshot field).
    expect(M.writes).toEqual([]);

    await act(async () => {
      M.pendingSnapshot!.resolve({ snapshot: 'SNAPSHOT_BYTES', seq: 5 });
    });

    await waitFor(() => {
      expect(M.writes[0]).toBe('SNAPSHOT_BYTES');
      expect(result.current.state.kind).toBe('ready');
    });
  });

  it('buffers live chunks delivered DURING snapshot resolution and drains them after, in order, with seq > snapSeq', async () => {
    M.pendingSnapshot = newPendingSnapshot();
    renderHook(() => usePtyAttach('sid-B', '/tmp'));

    await waitFor(() => {
      expect(M.snapshotCalls).toContain('sid-B');
    });

    // Live chunks arrive WHILE snapshot is pending. Some have seq <= the
    // snapshot's captured seq (already baked in) and must be dropped;
    // others have seq > snapSeq and must be replayed.
    emitData('sid-B', 'OLD_CHUNK_3', 3);
    emitData('sid-B', 'OLD_CHUNK_5', 5);
    emitData('sid-B', 'NEW_CHUNK_6', 6);
    emitData('sid-B', 'NEW_CHUNK_7', 7);

    // Nothing should be on screen yet — snapshot has not landed.
    expect(M.writes).toEqual([]);

    await act(async () => {
      M.pendingSnapshot!.resolve({ snapshot: 'SNAP', seq: 5 });
    });

    await waitFor(() => {
      // Snapshot first, then only chunks with seq > 5, in arrival order.
      expect(M.writes).toEqual(['SNAP', 'NEW_CHUNK_6', 'NEW_CHUNK_7']);
    });
  });

  it('writes live chunks directly (no buffering) once snapshot has resolved', async () => {
    M.pendingSnapshot = newPendingSnapshot();
    renderHook(() => usePtyAttach('sid-C', '/tmp'));

    await waitFor(() => expect(M.snapshotCalls).toContain('sid-C'));

    await act(async () => {
      M.pendingSnapshot!.resolve({ snapshot: 'SNAP_C', seq: 1 });
    });
    await waitFor(() => expect(M.writes[0]).toBe('SNAP_C'));

    // Post-snapshot: chunk arrives with seq > 1 and must land immediately.
    emitData('sid-C', 'LIVE_2', 2);
    emitData('sid-C', 'LIVE_3', 3);

    expect(M.writes).toEqual(['SNAP_C', 'LIVE_2', 'LIVE_3']);
  });

  it('switching sessions tears down the previous data subscription and runs snapshot+live for the new sid', async () => {
    // Round 1: sid-X
    M.pendingSnapshot = newPendingSnapshot();
    const { rerender } = renderHook(({ sid }) => usePtyAttach(sid, '/tmp'), {
      initialProps: { sid: 'sid-X' },
    });
    await waitFor(() => expect(M.snapshotCalls).toContain('sid-X'));
    await act(async () => {
      M.pendingSnapshot!.resolve({ snapshot: 'SNAP_X', seq: 0 });
    });
    await waitFor(() => expect(M.writes).toEqual(['SNAP_X']));

    // Round 2: switch to sid-Y. usePtyAttach must detach sid-X then run
    // attach + getBufferSnapshot for sid-Y.
    M.pendingSnapshot = newPendingSnapshot();
    rerender({ sid: 'sid-Y' });

    await waitFor(() => {
      expect(M.detachCalls).toContain('sid-X');
      expect(M.snapshotCalls).toContain('sid-Y');
    });

    // While snapshot for Y is pending, an interleaved chunk arrives.
    emitData('sid-Y', 'NEW_Y_2', 2);

    await act(async () => {
      M.pendingSnapshot!.resolve({ snapshot: 'SNAP_Y', seq: 1 });
    });

    await waitFor(() => {
      // sid-X snapshot first (round 1), then sid-Y snapshot, then the
      // interleaved chunk (seq 2 > captured seq 1).
      expect(M.writes).toEqual(['SNAP_X', 'SNAP_Y', 'NEW_Y_2']);
    });
  });

  // L4 PR-D (#866): after attach, the hook must install a snapshot-replay
  // handler on the singleton so `useTerminalResize` can re-render the
  // visible xterm from the reflowed headless buffer post-SIGWINCH. The
  // handler re-runs steps 2-5 (buffer / snapshot / reset+write / drain)
  // against the SAME data subscription so live chunks during the replay
  // window aren't duplicated or lost.
  it('PR-D: installs a snapshot-replay handler on the singleton after attach', async () => {
    M.pendingSnapshot = newPendingSnapshot();
    renderHook(() => usePtyAttach('sid-D', '/tmp'));
    await waitFor(() => expect(M.snapshotCalls).toContain('sid-D'));
    await act(async () => {
      M.pendingSnapshot!.resolve({ snapshot: 'SNAP_D', seq: 5 });
    });
    await waitFor(() => expect(M.writes).toEqual(['SNAP_D']));

    // Replay handler must be installed.
    const replay = singleton.getSnapshotReplay();
    expect(typeof replay).toBe('function');

    // Invoking the replay should request a fresh snapshot and write it.
    const replaySnap = newPendingSnapshot();
    M.pendingSnapshot = replaySnap;
    const replayPromise = replay!();
    await waitFor(() => expect(M.snapshotCalls.filter((s) => s === 'sid-D').length).toBe(2));

    // Live chunks DURING the replay snapshot await must be buffered, not written.
    emitData('sid-D', 'OLD_REPLAY_4', 4);
    emitData('sid-D', 'NEW_REPLAY_8', 8);
    expect(M.writes).toEqual(['SNAP_D']);

    await act(async () => {
      replaySnap.resolve({ snapshot: 'REFLOWED_SNAP', seq: 6 });
      await replayPromise;
    });

    await waitFor(() => {
      // After replay: original snapshot, reflowed snapshot, then only the
      // chunk with seq > 6 (drain dedupe).
      expect(M.writes).toEqual(['SNAP_D', 'REFLOWED_SNAP', 'NEW_REPLAY_8']);
    });
  });

  it('PR-D: replay handler is replaced (not stacked) on session switch', async () => {
    M.pendingSnapshot = newPendingSnapshot();
    const { rerender } = renderHook(({ sid }) => usePtyAttach(sid, '/tmp'), {
      initialProps: { sid: 'sid-E' },
    });
    await waitFor(() => expect(M.snapshotCalls).toContain('sid-E'));
    await act(async () => {
      M.pendingSnapshot!.resolve({ snapshot: 'SNAP_E', seq: 0 });
    });
    await waitFor(() => expect(singleton.getSnapshotReplay()).not.toBeNull());
    const firstReplay = singleton.getSnapshotReplay();

    // Switch.
    M.pendingSnapshot = newPendingSnapshot();
    rerender({ sid: 'sid-F' });
    await waitFor(() => expect(M.detachCalls).toContain('sid-E'));
    await act(async () => {
      M.pendingSnapshot!.resolve({ snapshot: 'SNAP_F', seq: 0 });
    });
    await waitFor(() => {
      const replay = singleton.getSnapshotReplay();
      expect(replay).not.toBeNull();
      expect(replay).not.toBe(firstReplay);
    });
  });
});
