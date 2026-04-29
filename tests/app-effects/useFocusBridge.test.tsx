import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFocusBridge } from '../../src/app-effects/useFocusBridge';

describe('useFocusBridge', () => {
  it('runs the callback when the window receives focus', () => {
    const cb = vi.fn();
    renderHook(() => useFocusBridge(cb));
    window.dispatchEvent(new Event('focus'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('removes the listener on unmount', () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useFocusBridge(cb));
    unmount();
    window.dispatchEvent(new Event('focus'));
    expect(cb).not.toHaveBeenCalled();
  });

  it('re-binds when the callback identity changes', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const { rerender } = renderHook(({ cb }: { cb: () => void }) => useFocusBridge(cb), {
      initialProps: { cb: cb1 },
    });
    rerender({ cb: cb2 });
    window.dispatchEvent(new Event('focus'));
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
