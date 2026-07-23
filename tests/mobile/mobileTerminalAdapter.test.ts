import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITerminalOptions } from '@xterm/xterm';

import {
  createMobileTerminalAdapter,
  type MobileSerializeAddon,
  type MobileTerminalAdapter,
  type MobileTerminalAdapterOptions,
  type MobileXtermAddon,
  type RenderTerminalEffect,
  type TerminalViewportAnchor,
} from '../../src/mobile/mobileTerminalAdapter';
import type { TerminalGeometry } from '../../src/shared/mobileRemote';

type FakeVisualViewport = EventTarget & {
  height: number;
  offsetTop: number;
  setMetrics: (height: number, offsetTop: number) => void;
};

function createVisualViewport(height = 620, offsetTop = 8): FakeVisualViewport {
  const viewport = new EventTarget() as FakeVisualViewport;
  viewport.height = height;
  viewport.offsetTop = offsetTop;
  viewport.setMetrics = (nextHeight: number, nextOffsetTop: number) => {
    viewport.height = nextHeight;
    viewport.offsetTop = nextOffsetTop;
  };
  return viewport;
}

function createFakeAddon(): MobileXtermAddon & { dispose: ReturnType<typeof vi.fn> } {
  return { dispose: vi.fn() };
}

function createFakeSerializeAddon(): MobileSerializeAddon & {
  dispose: ReturnType<typeof vi.fn>;
  serialize: ReturnType<typeof vi.fn>;
} {
  return { dispose: vi.fn(), serialize: vi.fn(() => 'serialized-output') };
}

function createFakeTerminal(seed?: {
  cols?: number;
  rows?: number;
  baseY?: number;
  viewportY?: number;
  screenWidth?: number;
}) {
  const element = document.createElement('div');
  const textarea = document.createElement('textarea');
  element.appendChild(textarea);
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  element.appendChild(screen);

  let screenWidth = seed?.screenWidth ?? 480;
  vi.spyOn(screen, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        width: screenWidth,
        height: 18,
        top: 0,
        right: screenWidth,
        bottom: 18,
        left: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );

  const pendingWriteCallbacks: Array<() => void> = [];
  const scrollListeners = new Set<(position: number) => void>();
  const scrollDisposers: Array<ReturnType<typeof vi.fn>> = [];

  const terminal = {
    element,
    textarea,
    cols: seed?.cols ?? 80,
    rows: seed?.rows ?? 24,
    unicode: { activeVersion: '6' },
    buffer: {
      active: {
        baseY: seed?.baseY ?? 0,
        viewportY: seed?.viewportY ?? 0,
      },
    },
    open: vi.fn((parent: HTMLElement) => parent.appendChild(element)),
    reset: vi.fn(),
    write: vi.fn((_data: string, callback?: () => void) => {
      if (callback) pendingWriteCallbacks.push(callback);
    }),
    resize: vi.fn((cols: number, rows: number) => {
      terminal.cols = cols;
      terminal.rows = rows;
    }),
    getSelection: vi.fn(() => ''),
    clearSelection: vi.fn(),
    loadAddon: vi.fn(),
    scrollToLine: vi.fn((line: number) => {
      terminal.buffer.active.viewportY = line;
    }),
    scrollLines: vi.fn((amount: number) => {
      const maxTop = terminal.buffer.active.baseY;
      const target = Math.max(0, Math.min(maxTop, terminal.buffer.active.viewportY + amount));
      terminal.buffer.active.viewportY = target;
    }),
    onScroll: vi.fn((listener: (position: number) => void) => {
      scrollListeners.add(listener);
      const disposer = vi.fn(() => {
        scrollListeners.delete(listener);
      });
      scrollDisposers.push(disposer);
      return { dispose: disposer };
    }),
    dispose: vi.fn(),
  };

  return {
    terminal,
    setScreenWidth: (width: number) => {
      screenWidth = width;
    },
    completeNextWrite: () => {
      pendingWriteCallbacks.shift()?.();
    },
    completeWriteAt: (index: number) => {
      const callback = pendingWriteCallbacks[index];
      if (!callback) return;
      pendingWriteCallbacks.splice(index, 1);
      callback();
    },
    emitScroll: (position = terminal.buffer.active.viewportY) => {
      for (const listener of [...scrollListeners]) listener(position);
    },
    getPendingWriteCount: () => pendingWriteCallbacks.length,
    scrollDisposers,
  };
}

type Harness = {
  adapter: MobileTerminalAdapter;
  terminal: ReturnType<typeof createFakeTerminal>['terminal'];
  terminalProbe: ReturnType<typeof createFakeTerminal>;
  serializeAddon: ReturnType<typeof createFakeSerializeAddon>;
  unicodeAddon: ReturnType<typeof createFakeAddon>;
  webLinksAddon: ReturnType<typeof createFakeAddon>;
  createTerminalSpy: ReturnType<typeof vi.fn>;
  host: HTMLDivElement;
  triggerHostResize: () => void;
};

const createdAdapters: MobileTerminalAdapter[] = [];
let visualViewport: FakeVisualViewport;
let resizeObserverCallback: ResizeObserverCallback | null = null;
let observeSpy: ReturnType<typeof vi.fn>;
let disconnectSpy: ReturnType<typeof vi.fn>;
const originalResizeObserver = globalThis.ResizeObserver;
const originalVisualViewport = window.visualViewport;

function install(geometry: TerminalGeometry, snapshot: string): RenderTerminalEffect {
  return {
    type: 'installSnapshot',
    sid: 's1',
    seq: 1,
    snapshot,
    geometry,
  };
}

function createHarness(
  options: Partial<MobileTerminalAdapterOptions> = {},
  seed?: Parameters<typeof createFakeTerminal>[0],
): Harness {
  const host = document.createElement('div');
  const terminalProbe = createFakeTerminal(seed);
  const serializeAddon = createFakeSerializeAddon();
  const unicodeAddon = createFakeAddon();
  const webLinksAddon = createFakeAddon();
  const createTerminalSpy = vi.fn((_terminalOptions: ITerminalOptions) => terminalProbe.terminal);

  const adapter = createMobileTerminalAdapter(host, {
    createTerminal: createTerminalSpy,
    createSerializeAddon: () => serializeAddon,
    createUnicode11Addon: () => unicodeAddon,
    createWebLinksAddon: () => webLinksAddon,
    ...options,
  });
  createdAdapters.push(adapter);

  return {
    adapter,
    terminal: terminalProbe.terminal,
    terminalProbe,
    serializeAddon,
    unicodeAddon,
    webLinksAddon,
    createTerminalSpy,
    host,
    triggerHostResize: () => {
      resizeObserverCallback?.([], {} as ResizeObserver);
    },
  };
}

describe('createMobileTerminalAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizeObserverCallback = null;
    observeSpy = vi.fn();
    disconnectSpy = vi.fn();

    class ResizeObserverCtor {
      observe = observeSpy;
      disconnect = disconnectSpy;
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);

      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }
    }

    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: ResizeObserverCtor,
      configurable: true,
      writable: true,
    });

    visualViewport = createVisualViewport();
    Object.defineProperty(window, 'visualViewport', {
      value: visualViewport,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    for (const adapter of createdAdapters.splice(0)) {
      try {
        adapter.dispose();
      } catch {
        // already disposed by a test
      }
    }
    vi.useRealTimers();

    Object.defineProperty(window, 'visualViewport', {
      value: originalVisualViewport,
      configurable: true,
      writable: true,
    });

    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: originalResizeObserver,
      configurable: true,
      writable: true,
    });
  });

  it('creates one read-only terminal and loads exactly serialize/unicode/weblinks addons', () => {
    const { createTerminalSpy, terminal, serializeAddon, unicodeAddon, webLinksAddon } = createHarness();

    expect(createTerminalSpy).toHaveBeenCalledOnce();
    expect(createTerminalSpy.mock.calls[0]?.[0]).toMatchObject({
      convertEol: false,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 5000,
      theme: { background: '#0d0f12', foreground: '#e8eaed' },
    });
    expect(terminal.loadAddon).toHaveBeenCalledTimes(3);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(1, serializeAddon);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(2, unicodeAddon);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(3, webLinksAddon);
    expect(terminal.unicode.activeVersion).toBe('11');
  });

  it('resizes only from installSnapshot and performs one reset plus snapshot write', () => {
    const { adapter, terminal, terminalProbe } = createHarness();

    adapter.apply([install({ cols: 132, rows: 36, epoch: 2 }, 'screen')]);
    expect(terminal.resize).toHaveBeenCalledOnce();
    expect(terminal.resize).toHaveBeenCalledWith(132, 36);
    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write.mock.calls[0]?.[0]).toBe('screen');

    terminalProbe.completeNextWrite();
    adapter.apply([{ type: 'write', sid: 's1', seq: 2, data: 'tail' }]);
    terminalProbe.completeNextWrite();

    expect(terminal.resize).toHaveBeenCalledOnce();
    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write.mock.calls.map((call) => call[0])).toEqual(['screen', 'tail']);
  });

  it('treats viewport and host events as css/state updates only', () => {
    const { adapter, terminal, triggerHostResize } = createHarness();
    adapter.apply([install({ cols: 132, rows: 36, epoch: 2 }, 'screen')]);
    expect(terminal.resize).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event('resize'));
    visualViewport.dispatchEvent(new Event('resize'));
    visualViewport.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('orientationchange'));
    triggerHostResize();
    vi.runAllTimers();

    expect(terminal.resize).toHaveBeenCalledOnce();
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('620px');
    expect(document.documentElement.style.getPropertyValue('--app-offset-top')).toBe('8px');
  });

  it('reports xterm scroll metrics and clamps public scroll actions', () => {
    const { adapter, terminal } = createHarness({}, { rows: 30, baseY: 200, viewportY: 150 });

    expect(adapter.getViewportState().scroll).toEqual({
      maximumTop: 200,
      currentTop: 150,
      visibleRows: 30,
    });

    adapter.scrollToLine(999);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(200);
    adapter.scrollToLine(-20);
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(0);

    terminal.buffer.active.viewportY = 150;
    adapter.scrollLines(999);
    expect(terminal.scrollLines).toHaveBeenLastCalledWith(50);
    terminal.buffer.active.viewportY = 150;
    adapter.scrollLines(-999);
    expect(terminal.scrollLines).toHaveBeenLastCalledWith(-150);
  });

  it('captures anchors and restores history distance after writes', () => {
    const { adapter, terminal, terminalProbe } = createHarness({}, { baseY: 200, viewportY: 150 });

    adapter.apply([install({ cols: 140, rows: 32, epoch: 4 }, 'screen')]);
    terminalProbe.completeNextWrite();

    const anchor = adapter.captureAnchor(76);
    expect(anchor).toEqual({
      mode: 'history',
      distanceFromBottom: 50,
      horizontalOffsetPx: 76,
      canonicalCols: 140,
    });

    terminal.buffer.active.baseY = 230;
    terminal.buffer.active.viewportY = 170;
    adapter.apply([{ type: 'write', sid: 's1', seq: 2, data: 'tail' }], anchor);
    terminalProbe.completeNextWrite();

    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(170);
  });

  it('applies write completions in effect fifo order even when callbacks arrive out of order', () => {
    const { adapter, terminal, terminalProbe } = createHarness({}, { baseY: 100, viewportY: 20 });
    const anchor: TerminalViewportAnchor = {
      mode: 'history',
      distanceFromBottom: 5,
      horizontalOffsetPx: 0,
      canonicalCols: 80,
    };

    adapter.apply(
      [
        install({ cols: 80, rows: 24, epoch: 2 }, 'snapshot'),
        { type: 'write', sid: 's1', seq: 2, data: 'tail' },
      ],
      anchor,
    );

    terminal.buffer.active.baseY = 120;
    terminal.buffer.active.viewportY = 10;
    terminal.scrollToLine.mockClear();

    terminalProbe.completeWriteAt(1);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();

    terminalProbe.completeWriteAt(0);
    expect(terminal.scrollToLine.mock.calls.map((call) => call[0])).toEqual([115, 40]);
  });

  it('measures .xterm-screen width after canonical callbacks and physical changes', () => {
    const { adapter, terminalProbe } = createHarness({}, { screenWidth: 420 });
    const publishedWidths: number[] = [];
    const unsubscribe = adapter.subscribeViewport((state) => {
      publishedWidths.push(state.contentWidthPx);
    });

    adapter.apply([install({ cols: 120, rows: 30, epoch: 3 }, 'screen')]);
    terminalProbe.completeNextWrite();
    expect(adapter.getViewportState().contentWidthPx).toBe(420);

    terminalProbe.setScreenWidth(640);
    visualViewport.setMetrics(512, 14);
    visualViewport.dispatchEvent(new Event('resize'));
    vi.runAllTimers();
    expect(adapter.getViewportState().contentWidthPx).toBe(640);
    expect(publishedWidths.at(-1)).toBe(640);

    unsubscribe();
    const callCount = publishedWidths.length;
    terminalProbe.setScreenWidth(700);
    visualViewport.dispatchEvent(new Event('scroll'));
    vi.runAllTimers();
    expect(publishedWidths.length).toBe(callCount);
  });

  it('cleans up subscriptions and suppresses pending callbacks after dispose', () => {
    const { adapter, terminalProbe } = createHarness();
    const listener = vi.fn();
    adapter.subscribeViewport(listener);

    adapter.apply([{ type: 'write', sid: 's1', seq: 2, data: 'tail' }]);
    expect(terminalProbe.getPendingWriteCount()).toBe(1);
    adapter.dispose();

    terminalProbe.completeNextWrite();
    terminalProbe.emitScroll();
    visualViewport.dispatchEvent(new Event('resize'));
    vi.runAllTimers();

    expect(listener).not.toHaveBeenCalled();
    expect(terminalProbe.scrollDisposers).toHaveLength(1);
    expect(terminalProbe.scrollDisposers[0]).toHaveBeenCalledOnce();
    expect(disconnectSpy).toHaveBeenCalledOnce();
  });

  it('keeps native selection behavior and surfaces clipboard failures', async () => {
    const originalClipboard = navigator.clipboard;
    const { adapter, terminal } = createHarness();
    terminal.getSelection.mockReturnValue('hello world');
    const failure = new Error('clipboard denied');
    const writeText = vi.fn().mockRejectedValue(failure);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await expect(adapter.copySelection()).rejects.toThrow('clipboard denied');
    expect(terminal.clearSelection).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  });

  it('serialize delegates to the serialize addon', () => {
    const { adapter, serializeAddon } = createHarness();
    expect(adapter.serialize()).toBe('serialized-output');
    expect(serializeAddon.serialize).toHaveBeenCalledOnce();
  });
});
