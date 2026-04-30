import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useExitAnimation } from '../../src/app-effects/useExitAnimation';

describe('useExitAnimation', () => {
  let onBeforeHide: ReturnType<typeof vi.fn>;
  let onAfterShow: ReturnType<typeof vi.fn>;
  let offHide: ReturnType<typeof vi.fn>;
  let offShow: ReturnType<typeof vi.fn>;
  let hideCb: (() => void) | null = null;
  let showCb: (() => void) | null = null;

  beforeEach(() => {
    offHide = vi.fn();
    offShow = vi.fn();
    onBeforeHide = vi.fn((cb: () => void) => {
      hideCb = cb;
      return offHide;
    });
    onAfterShow = vi.fn((cb: () => void) => {
      showCb = cb;
      return offShow;
    });
    (window as unknown as { ccsm: unknown }).ccsm = {
      window: { onBeforeHide, onAfterShow },
    };
    document.documentElement.style.opacity = '';
    document.documentElement.style.transition = '';
  });

  afterEach(() => {
    delete (window as unknown as { ccsm?: unknown }).ccsm;
    hideCb = null;
    showCb = null;
    document.documentElement.style.opacity = '';
    document.documentElement.style.transition = '';
  });

  it('subscribes on mount and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useExitAnimation());
    expect(onBeforeHide).toHaveBeenCalledTimes(1);
    expect(onAfterShow).toHaveBeenCalledTimes(1);
    unmount();
    expect(offHide).toHaveBeenCalledTimes(1);
    expect(offShow).toHaveBeenCalledTimes(1);
  });

  it('fades opacity to 0 on beforeHide and back to 1 on afterShow', () => {
    renderHook(() => useExitAnimation());
    hideCb!();
    expect(document.documentElement.style.opacity).toBe('0');
    showCb!();
    expect(document.documentElement.style.opacity).toBe('1');
  });

  it('clears inline opacity + transition on unmount', () => {
    const { unmount } = renderHook(() => useExitAnimation());
    hideCb!();
    expect(document.documentElement.style.opacity).toBe('0');
    unmount();
    expect(document.documentElement.style.opacity).toBe('');
    expect(document.documentElement.style.transition).toBe('');
  });

  it('is a no-op when the bridge is missing', () => {
    delete (window as unknown as { ccsm?: unknown }).ccsm;
    expect(() => renderHook(() => useExitAnimation())).not.toThrow();
  });
});
