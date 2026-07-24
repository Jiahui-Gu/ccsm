import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';

import { MobileTerminal, type MobileTerminalAdapterFactory } from '../../src/mobile/components/MobileTerminal';
import type {
  MobileTerminalAdapter,
  TerminalViewportAnchor,
  TerminalViewportState,
} from '../../src/mobile/mobileTerminalAdapter';
import type { TerminalRenderBatch } from '../../src/mobile/mobileRemoteStore';
import type { TerminalSyncEffect } from '../../src/mobile/terminalSync';

type FakeMobileTerminalAdapter = MobileTerminalAdapter & {
  emitViewport(state: TerminalViewportState): void;
};

type ResizeObserverRecord = {
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  target: Element | null;
};

const DEFAULT_VIEWPORT_STATE: TerminalViewportState = {
  geometry: null,
  contentWidthPx: 0,
  scroll: { maximumTop: 0, currentTop: 0, visibleRows: 30 },
};

const originalResizeObserver = globalThis.ResizeObserver;
let resizeObserverRecords: ResizeObserverRecord[] = [];

function createFakeAdapter(): FakeMobileTerminalAdapter {
  const listeners = new Set<(state: TerminalViewportState) => void>();
  return {
    apply: vi.fn(),
    captureAnchor: vi.fn(() => ({
      mode: 'bottom',
      horizontalOffsetPx: 0,
      canonicalCols: 140,
    })),
    getViewportState: vi.fn(() => DEFAULT_VIEWPORT_STATE),
    subscribeViewport: vi.fn((listener: (state: TerminalViewportState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    scrollToLine: vi.fn(),
    scrollLines: vi.fn(),
    copySelection: vi.fn().mockResolvedValue(undefined),
    serialize: vi.fn(() => ''),
    dispose: vi.fn(),
    emitViewport(state: TerminalViewportState) {
      for (const listener of listeners) listener(state);
    },
  };
}

function createRef(): MutableRefObject<MobileTerminalAdapter | null> {
  return { current: null };
}

function viewportState(overrides: Partial<TerminalViewportState> = {}): TerminalViewportState {
  return {
    ...DEFAULT_VIEWPORT_STATE,
    ...overrides,
    scroll: {
      ...DEFAULT_VIEWPORT_STATE.scroll,
      ...overrides.scroll,
    },
  };
}

function installV1(
  sid: string,
  geometry = { cols: 140, rows: 30, epoch: 1 },
): Extract<TerminalSyncEffect, { type: 'installSnapshot' }> {
  return {
    type: 'installSnapshot',
    sid,
    seq: 0,
    snapshot: 'screen',
    geometry,
  };
}

function writeV1(
  sid: string,
  seq: number,
  data = 'tail',
): Extract<TerminalSyncEffect, { type: 'write' }> {
  return {
    type: 'write',
    sid,
    seq,
    data,
  };
}

function batch(
  id: number,
  sid: string,
  effects: TerminalRenderBatch['effects'],
): TerminalRenderBatch {
  return { id, sid, effects: [...effects] };
}

function emitResize(target: Element, width: number, height: number): void {
  const record = resizeObserverRecords.find((candidate) => candidate.target === target);
  expect(record).toBeDefined();
  record?.callback(
    [
      {
        target,
        contentRect: {
          x: 0,
          y: 0,
          width,
          height,
          top: 0,
          left: 0,
          right: width,
          bottom: height,
          toJSON: () => ({}),
        } as DOMRectReadOnly,
      } as ResizeObserverEntry,
    ],
    {} as ResizeObserver,
  );
}

describe('MobileTerminal', () => {
  beforeEach(() => {
    resizeObserverRecords = [];
    class ResizeObserverMock {
      private readonly record: ResizeObserverRecord;

      constructor(callback: ResizeObserverCallback) {
        this.record = {
          callback,
          observe: vi.fn((target: Element) => {
            this.record.target = target;
          }),
          disconnect: vi.fn(),
          target: null,
        };
        resizeObserverRecords.push(this.record);
      }

      observe(target: Element): void {
        this.record.observe(target);
      }

      unobserve(): void {}

      disconnect(): void {
        this.record.disconnect();
      }
    }

    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: ResizeObserverMock,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalResizeObserver) {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        value: originalResizeObserver,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
    vi.restoreAllMocks();
  });

  it('creates one adapter on mount and keeps the same adapter across rerenders', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const adapterRef = createRef();

    const { container, rerender } = render(
      <MobileTerminal
        sid="s1"
        batch={null}
        onConsumed={vi.fn()}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    rerender(
      <MobileTerminal
        sid="s2"
        batch={null}
        onConsumed={vi.fn()}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    expect(createAdapter).toHaveBeenCalledOnce();
    const host = container.querySelector('.mobile-terminal__grid');
    expect(host).not.toBeNull();
    expect((createAdapter as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(host);
    expect(adapterRef.current).toBe(adapter);
    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('subscribes to viewport state, updates scrollbar metrics, and routes scrollbar actions to adapter methods', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const adapterRef = createRef();

    const { container } = render(
      <MobileTerminal
        sid="s1"
        batch={null}
        onConsumed={vi.fn()}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    act(() => {
      adapter.emitViewport(viewportState({
        geometry: { cols: 140, rows: 30, epoch: 1 },
        contentWidthPx: 1120,
        scroll: { maximumTop: 90, currentTop: 30, visibleRows: 30 },
      }));
    });

    const output = screen.getByLabelText('Terminal output') as HTMLDivElement;
    expect(output.style.width).toBe('1120px');

    const scrollbar = screen.getByRole('scrollbar', { name: /terminal output scroll position/i });
    expect(scrollbar).toHaveAttribute('aria-valuemax', '90');
    expect(scrollbar).toHaveAttribute('aria-valuenow', '30');
    act(() => {
      emitResize(scrollbar, 24, 220);
    });

    fireEvent.keyDown(scrollbar, { key: 'ArrowDown' });
    fireEvent.keyDown(scrollbar, { key: 'End' });

    expect(adapter.scrollLines).toHaveBeenCalledWith(1);
    expect(adapter.scrollToLine).toHaveBeenCalledWith(90);

    const viewport = container.querySelector('.mobile-terminal__viewport') as HTMLElement;
    expect(viewport).not.toBeNull();
  });

  it('captures and restores a history anchor per session across s1->s2->s1', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const onConsumed = vi.fn();
    const adapterRef = createRef();
    const savedAnchor: TerminalViewportAnchor = {
      mode: 'history',
      distanceFromBottom: 18,
      horizontalOffsetPx: 76,
      canonicalCols: 140,
    };

    vi.mocked(adapter.captureAnchor)
      .mockImplementationOnce(() => savedAnchor)
      .mockImplementation(() => ({
        mode: 'bottom',
        horizontalOffsetPx: 0,
        canonicalCols: 140,
      }));

    const { rerender } = render(
      <MobileTerminal
        sid="s1"
        batch={null}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    rerender(
      <MobileTerminal
        sid="s2"
        batch={batch(1, 's2', [installV1('s2')])}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    rerender(
      <MobileTerminal
        sid="s1"
        batch={batch(2, 's1', [installV1('s1')])}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    expect(adapter.apply).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({ mode: 'history', distanceFromBottom: 18, horizontalOffsetPx: 76 }),
    );
  });

  it('starts a sid without saved anchor at bottom with horizontal offset 0', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const adapterRef = createRef();

    render(
      <MobileTerminal
        sid="s9"
        batch={batch(1, 's9', [installV1('s9')])}
        onConsumed={vi.fn()}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    expect(adapter.apply).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ mode: 'bottom', horizontalOffsetPx: 0 }),
    );
  });

  it('applies only matching sid batches and deduplicates repeated batch ids', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const onConsumed = vi.fn();
    const adapterRef = createRef();

    const { rerender } = render(
      <MobileTerminal
        sid="s1"
        batch={null}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    rerender(
      <MobileTerminal
        sid="s1"
        batch={batch(1, 's2', [writeV1('s2', 1)])}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    rerender(
      <MobileTerminal
        sid={null}
        batch={batch(2, 's1', [writeV1('s1', 2)])}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    expect(adapter.apply).not.toHaveBeenCalled();
    expect(onConsumed).not.toHaveBeenCalled();

    const matching = batch(3, 's1', [writeV1('s1', 3)]);
    rerender(
      <MobileTerminal
        sid="s1"
        batch={matching}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    rerender(
      <MobileTerminal
        sid="s1"
        batch={matching}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    expect(adapter.apply).toHaveBeenCalledTimes(1);
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(onConsumed).toHaveBeenCalledWith(3);
  });

  it('ignores stale monotonic batch ids after a newer batch has applied', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const onConsumed = vi.fn();
    const adapterRef = createRef();

    const { rerender } = render(
      <MobileTerminal
        sid="s1"
        batch={null}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    for (let id = 1; id <= 25; id += 1) {
      rerender(
        <MobileTerminal
          sid="s1"
          batch={batch(id, 's1', [writeV1('s1', id)])}
          onConsumed={onConsumed}
          adapterRef={adapterRef}
          createAdapter={createAdapter}
        />,
      );
    }
    const applyCallsBeforeStale = vi.mocked(adapter.apply).mock.calls.length;
    const consumeCallsBeforeStale = onConsumed.mock.calls.length;
    rerender(
      <MobileTerminal
        sid="s1"
        batch={batch(12, 's1', [writeV1('s1', 12, 'stale')])}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    expect(adapter.apply).toHaveBeenCalledTimes(applyCallsBeforeStale);
    expect(onConsumed).toHaveBeenCalledTimes(consumeCallsBeforeStale);
  });

  it('does not consume a batch when synchronous apply throws', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const onConsumed = vi.fn();
    const adapterRef = createRef();
    const failure = new Error('apply failed');

    vi.mocked(adapter.apply).mockImplementation(() => {
      throw failure;
    });

    expect(() =>
      render(
        <MobileTerminal
          sid="s1"
          batch={batch(1, 's1', [writeV1('s1', 1, 'boom')])}
          onConsumed={onConsumed}
          adapterRef={adapterRef}
          createAdapter={createAdapter}
        />,
      ),
    ).toThrow('apply failed');
    expect(onConsumed).not.toHaveBeenCalled();
  });

  it('preserves horizontal offset for unchanged canonical width and clamps when extent shrinks', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const adapterRef = createRef();

    const { container } = render(
      <MobileTerminal
        sid="s1"
        batch={batch(1, 's1', [installV1('s1')])}
        onConsumed={vi.fn()}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    const viewport = container.querySelector('.mobile-terminal__viewport') as HTMLDivElement;
    expect(viewport).not.toBeNull();

    Object.defineProperty(viewport, 'scrollWidth', {
      value: 900,
      configurable: true,
    });
    Object.defineProperty(viewport, 'clientWidth', {
      value: 300,
      configurable: true,
    });
    viewport.scrollLeft = 250;
    fireEvent.scroll(viewport);

    act(() => {
      adapter.emitViewport(viewportState({
        geometry: { cols: 140, rows: 30, epoch: 1 },
        contentWidthPx: 900,
      }));
    });
    expect(viewport.scrollLeft).toBe(250);

    Object.defineProperty(viewport, 'scrollWidth', {
      value: 340,
      configurable: true,
    });
    Object.defineProperty(viewport, 'clientWidth', {
      value: 300,
      configurable: true,
    });

    act(() => {
      adapter.emitViewport(viewportState({
        geometry: { cols: 140, rows: 30, epoch: 1 },
        contentWidthPx: 340,
      }));
    });
    expect(viewport.scrollLeft).toBe(40);
  });

  it('reclamps on viewport clientWidth-only resize and updates affordance without viewport-state changes', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const onConsumed = vi.fn();
    const adapterRef = createRef();
    const first = batch(1, 's1', [installV1('s1')]);

    const { container, rerender } = render(
      <MobileTerminal
        sid="s1"
        batch={first}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    const viewport = container.querySelector('.mobile-terminal__viewport') as HTMLDivElement;
    expect(viewport).not.toBeNull();

    Object.defineProperty(viewport, 'scrollWidth', {
      value: 900,
      configurable: true,
    });
    Object.defineProperty(viewport, 'clientWidth', {
      value: 300,
      configurable: true,
    });
    viewport.scrollLeft = 250;
    fireEvent.scroll(viewport);

    expect(container.firstElementChild).toHaveClass('mobile-terminal--left-edge-affordance-visible');

    Object.defineProperty(viewport, 'clientWidth', {
      value: 900,
      configurable: true,
    });
    act(() => {
      emitResize(viewport, 900, 220);
    });

    expect(viewport.scrollLeft).toBe(0);
    expect(container.firstElementChild).not.toHaveClass(
      'mobile-terminal--left-edge-affordance-visible',
    );

    rerender(
      <MobileTerminal
        sid="s2"
        batch={batch(2, 's2', [installV1('s2')])}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    rerender(
      <MobileTerminal
        sid="s1"
        batch={batch(3, 's1', [installV1('s1')])}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    expect(adapter.apply).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({ horizontalOffsetPx: 0 }),
    );
  });

  it('disconnects viewport width observer on unmount', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const adapterRef = createRef();

    const { container, unmount } = render(
      <MobileTerminal
        sid="s1"
        batch={null}
        onConsumed={vi.fn()}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    const viewport = container.querySelector('.mobile-terminal__viewport');
    expect(viewport).not.toBeNull();
    const record = resizeObserverRecords.find((candidate) => candidate.target === viewport);
    expect(record).toBeDefined();

    unmount();
    expect(record?.disconnect).toHaveBeenCalledOnce();
  });
});
