import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Spy on the Terminal so usePtyAttach can call write/reset/resize/onData/focus.
const writeSpy = vi.fn();
const resetSpy = vi.fn();
const resizeSpy = vi.fn();
const focusSpy = vi.fn();
const inputDisposableDispose = vi.fn();
const onDataDisposable = { dispose: inputDisposableDispose };
const onDataSpy = vi.fn(() => onDataDisposable);
const fakeTerm = {
  write: writeSpy,
  reset: resetSpy,
  resize: resizeSpy,
  focus: focusSpy,
  onData: onDataSpy,
  cols: 80,
  rows: 24,
};
const fitFitSpy = vi.fn();
const proposeDimensionsSpy = vi.fn(() => ({ cols: 134, rows: 51 }));
const fakeFit = { fit: fitFitSpy, proposeDimensions: proposeDimensionsSpy };

// We bypass ensureTerminal by mocking the singleton module directly.
vi.mock('../../src/terminal/xtermSingleton', async () => {
  let activeSid: string | null = null;
  let unsub: (() => void) | null = null;
  let inDisp: { dispose: () => void } | null = null;
  let snapReplay: (() => Promise<void>) | null = null;
  return {
    ensureTerminal: vi.fn(),
    getTerm: vi.fn(() => fakeTerm),
    getFit: vi.fn(() => fakeFit),
    getActiveSid: vi.fn(() => activeSid),
    setActiveSid: vi.fn((s: string | null) => {
      activeSid = s;
    }),
    getUnsubscribeData: vi.fn(() => unsub),
    setUnsubscribeData: vi.fn((fn: (() => void) | null) => {
      unsub = fn;
    }),
    getInputDisposable: vi.fn(() => inDisp),
    setInputDisposable: vi.fn((d: { dispose: () => void } | null) => {
      inDisp = d;
    }),
    getSnapshotReplay: vi.fn(() => snapReplay),
    setSnapshotReplay: vi.fn((fn: (() => Promise<void>) | null) => {
      snapReplay = fn;
    }),
    __resetSingletonForTests: vi.fn(() => {
      activeSid = null;
      unsub = null;
      inDisp = null;
      snapReplay = null;
    }),
  };
});

// Mock store — _clearPtyExit is the only piece usePtyAttach reads.
const clearPtyExitSpy = vi.fn();
vi.mock('../../src/stores/store', () => ({
  useStore: (selector: (s: any) => any) => selector({ _clearPtyExit: clearPtyExitSpy }),
}));

import { usePtyAttach } from '../../src/terminal/usePtyAttach';
import {
  __resetSingletonForTests,
  getActiveSid,
} from '../../src/terminal/xtermSingleton';

type AttachResp = { snapshot: string; cols: number; rows: number; pid: number } | null;

function makePtyBridge(opts: { attach?: AttachResp; snapshot?: { snapshot: string; seq: number } } = {}) {
  const attachResp: AttachResp =
    opts.attach === undefined
      ? { snapshot: 'snap', cols: 80, rows: 24, pid: 1234 }
      : opts.attach;
  // L4 PR-B (#865): the snapshot the visible terminal actually paints
  // comes from `getBufferSnapshot`, NOT from `attach.snapshot` (which is
  // now only kept for cols/rows/pid). Default to the same string so
  // existing assertions (`writeSpy was called with 'snap'`) still pass.
  const snapshotResp: { snapshot: string; seq: number } =
    opts.snapshot ?? { snapshot: 'snap', seq: 0 };
  let onDataHandler: ((p: { sid: string; chunk: string; seq: number }) => void) | null = null;
  let onExitHandler:
    | ((evt: { sessionId: string; code?: number | null; signal?: string | number | null }) => void)
    | null = null;
  const detach = vi.fn(async (_sid: string) => undefined);
  const attach = vi.fn(async (_sid: string) => attachResp);
  const spawn = vi.fn(async (_sid: string, _cwd: string) => ({
    ok: true as const,
    sid: _sid,
    pid: 999,
    cols: 80,
    rows: 24,
  }));
  const input = vi.fn();
  const resize = vi.fn();
  const onDataUnsub = vi.fn();
  const onData = vi.fn((cb: (p: { sid: string; chunk: string; seq: number }) => void) => {
    onDataHandler = cb;
    return onDataUnsub;
  });
  const onExitUnsub = vi.fn();
  const onExit = vi.fn((cb: typeof onExitHandler) => {
    onExitHandler = cb;
    return onExitUnsub;
  });
  const getBufferSnapshot = vi.fn(async (_sid: string) => snapshotResp);
  return {
    bridge: { attach, detach, spawn, input, resize, onData, onExit, getBufferSnapshot },
    spies: { attach, detach, spawn, onData, onDataUnsub, onExit, onExitUnsub, input, resize, getBufferSnapshot },
    fire: {
      data: (p: { sid: string; chunk: string; seq: number }) => onDataHandler?.(p),
      exit: (e: Parameters<NonNullable<typeof onExitHandler>>[0]) => onExitHandler?.(e),
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const flushAll = async () => {
  await act(async () => {
    await flush();
    await flush();
    await flush();
  });
};

describe('usePtyAttach', () => {
  beforeEach(() => {
    __resetSingletonForTests();
    writeSpy.mockClear();
    resetSpy.mockClear();
    resizeSpy.mockClear();
    focusSpy.mockClear();
    onDataSpy.mockClear();
    inputDisposableDispose.mockClear();
    fitFitSpy.mockClear();
    proposeDimensionsSpy.mockClear();
    proposeDimensionsSpy.mockReturnValue({ cols: 134, rows: 51 });
    clearPtyExitSpy.mockClear();
  });

  afterEach(() => {
    delete (window as any).ccsmPty;
    __resetSingletonForTests();
  });

  it('attaches on mount: writes snapshot, subscribes onData, sets activeSid, ready state', async () => {
    const { bridge, spies } = makePtyBridge();
    (window as any).ccsmPty = bridge;

    const { result } = renderHook(() => usePtyAttach('sid-A', '/tmp'));
    expect(result.current.state.kind).toBe('attaching');
    await flushAll();

    expect(spies.attach).toHaveBeenCalledWith('sid-A');
    expect(resetSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith('snap');
    expect(spies.onData).toHaveBeenCalled();
    expect(getActiveSid()).toBe('sid-A');
    expect(focusSpy).toHaveBeenCalled();
    expect(clearPtyExitSpy).toHaveBeenCalledWith('sid-A');
    expect(result.current.state.kind).toBe('ready');
  });

  it('on sessionId change: detaches previous, unsubscribes, re-attaches new', async () => {
    const { bridge, spies } = makePtyBridge();
    (window as any).ccsmPty = bridge;

    const { rerender, result } = renderHook(({ sid }) => usePtyAttach(sid, '/tmp'), {
      initialProps: { sid: 'sid-A' },
    });
    await flushAll();
    expect(getActiveSid()).toBe('sid-A');
    const firstUnsub = spies.onDataUnsub;
    spies.onDataUnsub.mockClear();

    await act(async () => {
      rerender({ sid: 'sid-B' });
      await flush();
      await flush();
    });

    expect(spies.detach).toHaveBeenCalledWith('sid-A');
    expect(firstUnsub).toHaveBeenCalled(); // previous onData subscription torn down
    expect(inputDisposableDispose).toHaveBeenCalled();
    expect(spies.attach).toHaveBeenCalledWith('sid-B');
    expect(getActiveSid()).toBe('sid-B');
    expect(result.current.state.kind).toBe('ready');
  });

  it('falls back to spawn when attach returns null', async () => {
    let calls = 0;
    const { bridge, spies } = makePtyBridge({ snapshot: { snapshot: 'after-spawn', seq: 0 } });
    spies.attach.mockImplementation(async (_sid: string) => {
      calls += 1;
      if (calls === 1) return null;
      return { snapshot: 'ignored-now', cols: 80, rows: 24, pid: 1 };
    });
    (window as any).ccsmPty = bridge;

    renderHook(() => usePtyAttach('sid-C', '/cwd'));
    await flushAll();

    expect(spies.spawn).toHaveBeenCalledWith('sid-C', '/cwd');
    expect(spies.attach).toHaveBeenCalledTimes(2);
    // L4 PR-B (#865): the visible terminal paints the getBufferSnapshot
    // string, NOT the legacy attach.snapshot.
    expect(writeSpy).toHaveBeenCalledWith('after-spawn');
  });

  // L4 PR-F (#867) — the spawn-time cols/rows hack added for #852 has been
  // removed. The renderer no longer measures the viewport via FitAddon
  // before spawn nor forwards cols/rows to `pty.spawn`; the PTY launches at
  // the lifecycle defaults and the post-attach `pty.resize` + snapshot
  // replay (PR-D #866) reflows both the headless source-of-truth buffer
  // and the visible xterm to the real container size, so claude doesn't
  // need to voluntarily repaint its alt-screen for the user to see correct
  // content.
  it('does not forward cols/rows to spawn (#867 — PR-D resize+replay covers #852)', async () => {
    let calls = 0;
    const { bridge, spies } = makePtyBridge({ snapshot: { snapshot: 'after-spawn', seq: 0 } });
    spies.attach.mockImplementation(async (_sid: string) => {
      calls += 1;
      if (calls === 1) return null;
      return { snapshot: 'ignored-now', cols: 120, rows: 30, pid: 1 };
    });
    (window as any).ccsmPty = bridge;

    renderHook(() => usePtyAttach('sid-867', '/cwd'));
    await flushAll();

    // Spawn is called with sid + cwd ONLY — no opts argument.
    expect(spies.spawn).toHaveBeenCalledWith('sid-867', '/cwd');
    // FitAddon.proposeDimensions is no longer called pre-spawn.
    expect(proposeDimensionsSpy).not.toHaveBeenCalled();
  });

  it('post-attach fit triggers snapshot replay so the visible xterm reflows to the real viewport (#867)', async () => {
    const { bridge, spies } = makePtyBridge({ snapshot: { snapshot: 'snap', seq: 0 } });
    (window as any).ccsmPty = bridge;

    renderHook(() => usePtyAttach('sid-867r', '/cwd'));
    await flushAll();

    // Post-attach: fit.fit() ran, backend resize was pushed, and the
    // installed snapshot replay (PR-D #866) was invoked after the
    // resize promise resolved.
    expect(fitFitSpy).toHaveBeenCalled();
    expect(spies.resize).toHaveBeenCalledWith('sid-867r', 80, 24);
    // The snapshot-replay handler is installed by usePtyAttach at attach
    // time; verify it was invoked by checking that getBufferSnapshot was
    // called twice (once for the initial paint, once for the replay).
    expect(spies.getBufferSnapshot).toHaveBeenCalledTimes(2);
  });

  it('flips to error state when ccsmPty bridge is missing', async () => {
    delete (window as any).ccsmPty;
    const { result } = renderHook(() => usePtyAttach('sid-X', ''));
    await flushAll();
    expect(result.current.state).toEqual({ kind: 'error', message: 'ccsmPty unavailable' });
  });

  it('classifies pty exit: clean (code 0, no signal)', async () => {
    const { bridge, fire } = makePtyBridge();
    (window as any).ccsmPty = bridge;
    const { result } = renderHook(() => usePtyAttach('sid-D', ''));
    await flushAll();
    fire.exit({ sessionId: 'sid-D', code: 0, signal: null });
    await act(async () => {
      await flush();
    });
    expect(result.current.state).toMatchObject({ kind: 'exit', exitKind: 'clean' });
  });

  it('classifies pty exit: crashed (signal set)', async () => {
    const { bridge, fire } = makePtyBridge();
    (window as any).ccsmPty = bridge;
    const { result } = renderHook(() => usePtyAttach('sid-E', ''));
    await flushAll();
    fire.exit({ sessionId: 'sid-E', code: null, signal: 'SIGKILL' });
    await act(async () => {
      await flush();
    });
    expect(result.current.state).toMatchObject({ kind: 'exit', exitKind: 'crashed' });
  });
});
