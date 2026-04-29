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
const fakeFit = { fit: fitFitSpy };

// We bypass ensureTerminal by mocking the singleton module directly.
vi.mock('../../src/terminal/xtermSingleton', async () => {
  let activeSid: string | null = null;
  let unsub: (() => void) | null = null;
  let inDisp: { dispose: () => void } | null = null;
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
    __resetSingletonForTests: vi.fn(() => {
      activeSid = null;
      unsub = null;
      inDisp = null;
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

function makePtyBridge(opts: { attach?: AttachResp } = {}) {
  const attachResp: AttachResp =
    opts.attach === undefined
      ? { snapshot: 'snap', cols: 80, rows: 24, pid: 1234 }
      : opts.attach;
  let onDataHandler: ((p: { sid: string; chunk: string }) => void) | null = null;
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
  const onData = vi.fn((cb: (p: { sid: string; chunk: string }) => void) => {
    onDataHandler = cb;
    return onDataUnsub;
  });
  const onExitUnsub = vi.fn();
  const onExit = vi.fn((cb: typeof onExitHandler) => {
    onExitHandler = cb;
    return onExitUnsub;
  });
  return {
    bridge: { attach, detach, spawn, input, resize, onData, onExit },
    spies: { attach, detach, spawn, onData, onDataUnsub, onExit, onExitUnsub, input, resize },
    fire: {
      data: (p: { sid: string; chunk: string }) => onDataHandler?.(p),
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
    const { bridge, spies } = makePtyBridge();
    spies.attach.mockImplementation(async (_sid: string) => {
      calls += 1;
      if (calls === 1) return null;
      return { snapshot: 'after-spawn', cols: 80, rows: 24, pid: 1 };
    });
    (window as any).ccsmPty = bridge;

    renderHook(() => usePtyAttach('sid-C', '/cwd'));
    await flushAll();

    expect(spies.spawn).toHaveBeenCalledWith('sid-C', '/cwd');
    expect(spies.attach).toHaveBeenCalledTimes(2);
    expect(writeSpy).toHaveBeenCalledWith('after-spawn');
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
