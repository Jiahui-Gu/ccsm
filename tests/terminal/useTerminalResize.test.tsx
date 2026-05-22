import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const fitFitSpy = vi.fn();
const fakeFit = { fit: fitFitSpy };
// Mutable buffer state so individual tests can set up pre-resize
// atBottom vs scrolled-up scenarios.
const fakeBuffer = { active: { baseY: 0, viewportY: 0 } };
const scrollToBottomSpy = vi.fn();
const scrollToLineSpy = vi.fn();
// `write` invokes its drain callback synchronously so the post-write
// scroll restoration lands in the same microtask sequence as the test's
// awaits — mirrors the usePtyAttach test fake.
const writeSpy = vi.fn((data: string, cb?: () => void) => {
  if (cb) cb();
});
const fakeTerm = {
  cols: 100,
  rows: 30,
  buffer: fakeBuffer,
  scrollToBottom: scrollToBottomSpy,
  scrollToLine: scrollToLineSpy,
  write: writeSpy,
};

let snapshotReplayFn: (() => Promise<void>) | null = null;

vi.mock('../../src/terminal/xtermSingleton', () => {
  let activeSid: string | null = 'sid-A';
  return {
    ensureTerminal: vi.fn(),
    getTerm: vi.fn(() => fakeTerm),
    getFit: vi.fn(() => fakeFit),
    getActiveSid: vi.fn(() => activeSid),
    setActiveSid: vi.fn((s: string | null) => {
      activeSid = s;
    }),
    getUnsubscribeData: vi.fn(() => null),
    setUnsubscribeData: vi.fn(),
    getInputDisposable: vi.fn(() => null),
    setInputDisposable: vi.fn(),
    getSnapshotReplay: vi.fn(() => snapshotReplayFn),
    setSnapshotReplay: vi.fn((fn: (() => Promise<void>) | null) => { snapshotReplayFn = fn; }),
    __resetSingletonForTests: vi.fn(),
  };
});

import { useTerminalResize } from '../../src/terminal/useTerminalResize';

// Capture the ResizeObserver callback so the test can fire it manually.
let lastObserverCb: ResizeObserverCallback | null = null;
const observeSpy = vi.fn();
const disconnectSpy = vi.fn();

class ROStub implements ResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    lastObserverCb = cb;
  }
  observe(target: Element): void {
    observeSpy(target);
  }
  unobserve(): void {}
  disconnect(): void {
    disconnectSpy();
  }
}

describe('useTerminalResize', () => {
  let originalRO: typeof globalThis.ResizeObserver;
  let resizeBridge: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fitFitSpy.mockClear();
    observeSpy.mockClear();
    disconnectSpy.mockClear();
    scrollToBottomSpy.mockClear();
    scrollToLineSpy.mockClear();
    writeSpy.mockClear();
    fakeBuffer.active.baseY = 0;
    fakeBuffer.active.viewportY = 0;
    lastObserverCb = null;
    snapshotReplayFn = null;
    originalRO = globalThis.ResizeObserver;
    (globalThis as any).ResizeObserver = ROStub;
    resizeBridge = vi.fn(async () => {});
    (window as any).ccsmPty = { resize: resizeBridge };
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as any).ResizeObserver = originalRO;
    delete (window as any).ccsmPty;
  });

  it('observes the host and runs fit + ccsmPty.resize after the 80ms debounce', () => {
    const host = document.createElement('div');
    const ref = { current: host };
    renderHook(() => useTerminalResize(ref));
    expect(observeSpy).toHaveBeenCalledWith(host);

    // Trigger a resize event from the observer.
    lastObserverCb!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    expect(fitFitSpy).not.toHaveBeenCalled(); // debounced
    vi.advanceTimersByTime(80);

    expect(fitFitSpy).toHaveBeenCalledTimes(1);
    expect(resizeBridge).toHaveBeenCalledWith('sid-A', 100, 30);
  });

  it('disconnects the observer on unmount', () => {
    const host = document.createElement('div');
    const ref = { current: host };
    const { unmount } = renderHook(() => useTerminalResize(ref));
    unmount();
    expect(disconnectSpy).toHaveBeenCalled();
  });

  // L4 PR-D (#866): after resize, the visible xterm must replay from the
  // headless buffer's reflowed cell content rather than waiting on claude
  // to repaint. The hook must invoke the snapshot-replay handler installed
  // by usePtyAttach AFTER the backend resize IPC settles.
  it('PR-D: invokes the snapshot-replay handler after the resize IPC resolves', async () => {
    const replaySpy = vi.fn(async () => {});
    snapshotReplayFn = replaySpy;
    let resolveResize!: () => void;
    const resizePromise = new Promise<void>((r) => { resolveResize = r; });
    resizeBridge.mockImplementationOnce(() => resizePromise);

    const host = document.createElement('div');
    const ref = { current: host };
    renderHook(() => useTerminalResize(ref));
    lastObserverCb!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    vi.advanceTimersByTime(80);
    expect(resizeBridge).toHaveBeenCalledWith('sid-A', 100, 30);
    // Replay must NOT fire until the resize promise settles — otherwise we'd
    // snapshot the headless buffer BEFORE its `resize()` had reflowed.
    expect(replaySpy).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    resolveResize();
    // Use real microtasks to drain the .then().
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();
    expect(replaySpy).toHaveBeenCalledTimes(1);
  });

  it('PR-D: skips the replay when no handler is installed (no session attached)', () => {
    snapshotReplayFn = null;
    const host = document.createElement('div');
    const ref = { current: host };
    renderHook(() => useTerminalResize(ref));
    lastObserverCb!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    vi.advanceTimersByTime(80);
    // Resize still pushed to backend; absence of replay handler is non-fatal.
    expect(resizeBridge).toHaveBeenCalledWith('sid-A', 100, 30);
  });

  // Scroll-restoration gating (fix/attach-scroll-to-bottom): the replay
  // handler unconditionally parks the viewport at the bottom, which is
  // the right behaviour for attach but hostile on resize when the user
  // was scrolled up reading scrollback. The hook must snapshot
  // `atBottom` BEFORE the backend resize and only let the bottom-park
  // stand when it was true; otherwise it should restore the saved
  // viewportY via `scrollToLine`.
  it('resize when user WAS at bottom pre-resize: no scrollToLine, replay-side scroll stands', async () => {
    const replaySpy = vi.fn(async () => {});
    snapshotReplayFn = replaySpy;
    // baseY === viewportY → atBottom.
    fakeBuffer.active.baseY = 500;
    fakeBuffer.active.viewportY = 500;

    const host = document.createElement('div');
    const ref = { current: host };
    renderHook(() => useTerminalResize(ref));
    lastObserverCb!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    vi.advanceTimersByTime(80);

    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(replaySpy).toHaveBeenCalledTimes(1);
    // Pre-resize atBottom → don't restore a prior line.
    expect(scrollToLineSpy).not.toHaveBeenCalled();
  });

  it('resize when user was scrolled UP pre-resize: scrollToLine restores saved viewportY after replay', async () => {
    const replaySpy = vi.fn(async () => {});
    snapshotReplayFn = replaySpy;
    // baseY far ahead of viewportY → user scrolled up; gap > 1.
    fakeBuffer.active.baseY = 500;
    fakeBuffer.active.viewportY = 120;

    const host = document.createElement('div');
    const ref = { current: host };
    renderHook(() => useTerminalResize(ref));
    lastObserverCb!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    vi.advanceTimersByTime(80);

    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(replaySpy).toHaveBeenCalledTimes(1);
    // The rendezvous write('') fires its cb synchronously in our fake,
    // so scrollToLine should land with the saved pre-resize viewportY.
    expect(scrollToLineSpy).toHaveBeenCalledWith(120);
  });
});
