// TDD tests for the `MobileTerminal` React wrapper. Uses an injected fake
// adapter factory (the `createAdapter` prop) rather than unsafely mocking
// `@xterm/xterm` — the component itself is oblivious to what the adapter
// actually does, so a lightweight fake stands in for
// `createMobileTerminalAdapter`.

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { MutableRefObject } from 'react';

import { MobileTerminal, type MobileTerminalAdapterFactory } from '../../src/mobile/components/MobileTerminal';
import type { MobileTerminalAdapter } from '../../src/mobile/mobileTerminalAdapter';
import type { TerminalRenderBatch } from '../../src/mobile/mobileRemoteStore';

function createFakeAdapter(): MobileTerminalAdapter {
  return {
    apply: vi.fn(),
    fit: vi.fn(),
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
  it('creates exactly one adapter on mount, passing the host element and onResize', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const onResize = vi.fn();
    const adapterRef = createRef();

    const { container } = render(
      <MobileTerminal
        batch={null}
        onResize={onResize}
        onConsumed={vi.fn()}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    expect(createAdapter).toHaveBeenCalledOnce();
    const host = container.querySelector('.mobile-terminal');
    expect(host).not.toBeNull();
    expect((createAdapter as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(host);
    expect((createAdapter as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
      onResize,
    });
    expect(adapterRef.current).toBe(adapter);
  });

  it('does not recreate the adapter when unrelated props (e.g. batch) change', () => {
    const adapter = createFakeAdapter();
    const createAdapter: MobileTerminalAdapterFactory = vi.fn(() => adapter);
    const onResize = vi.fn();
    const onConsumed = vi.fn();
    const adapterRef = createRef();

    const { rerender } = render(
      <MobileTerminal
        batch={null}
        onResize={onResize}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    rerender(
      <MobileTerminal
        batch={batch(1, 'a')}
        onResize={onResize}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    rerender(
      <MobileTerminal
        batch={batch(2, 'b')}
        onResize={onResize}
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
        onResize={vi.fn()}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    rerender(
      <MobileTerminal
        batch={batch(1, 'first')}
        onResize={vi.fn()}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    expect(adapter.apply).toHaveBeenCalledTimes(1);
    expect(adapter.apply).toHaveBeenLastCalledWith([{ type: 'write', data: 'first' }]);
    expect(onConsumed).toHaveBeenLastCalledWith(1);

    // A new batch arriving before the previous one's consumption callback
    // takes effect (id 2 replaces id 1 directly) is still applied exactly
    // once, in order.
    rerender(
      <MobileTerminal
        batch={batch(2, 'second')}
        onResize={vi.fn()}
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
        onResize={vi.fn()}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );

    rerender(
      <MobileTerminal
        batch={firstBatch}
        onResize={vi.fn()}
        onConsumed={onConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />,
    );
    expect(adapter.apply).toHaveBeenCalledTimes(1);

    // Same id delivered again in a distinct object (defensive: the real
    // store never does this, but the wrapper's own dedup guard — not just
    // React's prop-reference bailout — must hold).
    rerender(
      <MobileTerminal
        batch={{ id: 1, effects: firstBatch.effects }}
        onResize={vi.fn()}
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
        onResize={vi.fn()}
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
        onResize={vi.fn()}
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
