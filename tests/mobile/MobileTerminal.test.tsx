import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { MutableRefObject } from 'react';

import { MobileTerminal, type MobileTerminalAdapterFactory } from '../../src/mobile/components/MobileTerminal';
import type { MobileTerminalAdapter } from '../../src/mobile/mobileTerminalAdapter';
import type { TerminalRenderBatch } from '../../src/mobile/mobileRemoteStore';

function createFakeAdapter(): MobileTerminalAdapter {
  return {
    apply: vi.fn(),
    captureAnchor: vi.fn(() => ({ mode: 'bottom', horizontalOffsetPx: 0, canonicalCols: 80 })),
    getViewportState: vi.fn(() => ({
      geometry: null,
      contentWidthPx: 0,
      scroll: { maximumTop: 0, currentTop: 0, visibleRows: 24 },
    })),
    subscribeViewport: vi.fn(() => vi.fn()),
    scrollToLine: vi.fn(),
    scrollLines: vi.fn(),
    copySelection: vi.fn().mockResolvedValue(undefined),
    serialize: vi.fn(() => ''),
    dispose: vi.fn(),
  };
}

function createRef(): MutableRefObject<MobileTerminalAdapter | null> {
  return { current: null };
}

function batch(id: number, data: string): TerminalRenderBatch {
  return { id, effects: [{ type: 'write', data }] };
}

describe('MobileTerminal', () => {
  it('creates exactly one adapter on mount and passes only the host element', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const adapterRef = createRef();

    const { container } = render(
      <MobileTerminal
        batch={null}
        onConsumed={vi.fn()}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    expect(createAdapter).toHaveBeenCalledOnce();
    const host = container.querySelector('.mobile-terminal');
    expect(host).not.toBeNull();
    expect((createAdapter as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(host);
    expect((createAdapter as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1);
    expect(adapterRef.current).toBe(adapter);
  });

  it('applies a batch that is already non-null on the very first mount (no drop)', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const onConsumed = vi.fn();
    const adapterRef = createRef();
    const firstBatch = batch(1, 'already-queued-snapshot');

    render(
      <MobileTerminal
        batch={firstBatch}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    expect(createAdapter).toHaveBeenCalledOnce();
    expect(adapter.apply).toHaveBeenCalledTimes(1);
    expect(adapter.apply).toHaveBeenCalledWith(firstBatch.effects);
    expect(onConsumed).toHaveBeenCalledWith(1);
  });

  it('does not recreate the adapter when unrelated props (e.g. batch) change', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const onConsumed = vi.fn();
    const adapterRef = createRef();

    const { rerender } = render(
      <MobileTerminal
        batch={null}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    rerender(
      <MobileTerminal
        batch={batch(1, 'a')}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    rerender(
      <MobileTerminal
        batch={batch(2, 'b')}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    expect(createAdapter).toHaveBeenCalledOnce();
    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('applies each numbered batch exactly once, in order, and calls onConsumed after apply', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const onConsumed = vi.fn();
    const adapterRef = createRef();

    const { rerender } = render(
      <MobileTerminal
        batch={null}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    rerender(
      <MobileTerminal
        batch={batch(1, 'first')}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    expect(adapter.apply).toHaveBeenCalledTimes(1);
    expect(adapter.apply).toHaveBeenLastCalledWith([{ type: 'write', data: 'first' }]);
    expect(onConsumed).toHaveBeenLastCalledWith(1);

    rerender(
      <MobileTerminal
        batch={batch(2, 'second')}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    expect(adapter.apply).toHaveBeenCalledTimes(2);
    expect(adapter.apply).toHaveBeenLastCalledWith([{ type: 'write', data: 'second' }]);
    expect(onConsumed).toHaveBeenLastCalledWith(2);
  });

  it('deduplicates a repeated batch id and never reapplies it', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const onConsumed = vi.fn();
    const adapterRef = createRef();
    const firstBatch = batch(1, 'only');

    const { rerender } = render(
      <MobileTerminal
        batch={null}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    rerender(
      <MobileTerminal
        batch={firstBatch}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    expect(adapter.apply).toHaveBeenCalledTimes(1);

    rerender(
      <MobileTerminal
        batch={{ id: 1, effects: firstBatch.effects }}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    expect(adapter.apply).toHaveBeenCalledTimes(1);
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it('disposes the adapter and nulls the ref on unmount', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const adapterRef = createRef();

    const { unmount } = render(
      <MobileTerminal
        batch={null}
        onConsumed={vi.fn()}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    expect(adapterRef.current).toBe(adapter);

    unmount();

    expect(adapter.dispose).toHaveBeenCalledOnce();
    expect(adapterRef.current).toBeNull();
  });

  it('never focuses any element on pointer interaction with the host', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const adapterRef = createRef();
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');

    const { container } = render(
      <MobileTerminal
        batch={null}
        onConsumed={vi.fn()}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    const host = container.querySelector('.mobile-terminal') as HTMLElement;
    host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    host.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

    expect(focusSpy).not.toHaveBeenCalled();
    focusSpy.mockRestore();
  });
});
