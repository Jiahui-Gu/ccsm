import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const fitFitSpy = vi.fn();
const fakeFit = { fit: fitFitSpy };
const fakeTerm = { cols: 100, rows: 30 };

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
    lastObserverCb = null;
    originalRO = globalThis.ResizeObserver;
    (globalThis as any).ResizeObserver = ROStub;
    resizeBridge = vi.fn();
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
});
