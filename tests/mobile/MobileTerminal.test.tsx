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

const DEFAULT_VIEWPORT_STATE: TerminalViewportState = {
  geometry: null,
  contentWidthPx: 0,
  scroll: { maximumTop: 0, currentTop: 0, visibleRows: 30 },
};

const originalResizeObserver = globalThis.ResizeObserver;

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

describe('MobileTerminal', () => {
  beforeEach(() => {
    class ResizeObserverMock {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element): void {
        this.callback(
          [{
            target,
            contentRect: {
              x: 0,
              y: 0,
              width: 24,
              height: 220,
              top: 0,
              left: 0,
              right: 24,
              bottom: 220,
              toJSON: () => ({}),
            } as DOMRectReadOnly,
          } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }

      unobserve(): void {}

      disconnect(): void {}
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
});
