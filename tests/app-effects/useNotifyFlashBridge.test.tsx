import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNotifyFlashBridge } from '../../src/app-effects/useNotifyFlashBridge';
import { useStore } from '../../src/stores/store';

describe('useNotifyFlashBridge', () => {
  let onFlash: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let flashCb: ((e: { sid: string; on: boolean }) => void) | null = null;
  let setFlashSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    unsubscribe = vi.fn();
    onFlash = vi.fn((cb: typeof flashCb) => {
      flashCb = cb;
      return unsubscribe;
    });
    (window as unknown as { ccsmNotify: unknown }).ccsmNotify = { onFlash };
    setFlashSpy = vi.spyOn(useStore.getState(), '_setFlash');
  });

  afterEach(() => {
    delete (window as unknown as { ccsmNotify?: unknown }).ccsmNotify;
    flashCb = null;
    setFlashSpy.mockRestore();
  });

  it('subscribes on mount and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useNotifyFlashBridge());
    expect(onFlash).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('forwards valid flash events to the store _setFlash action', () => {
    renderHook(() => useNotifyFlashBridge());
    flashCb!({ sid: 's1', on: true });
    expect(setFlashSpy).toHaveBeenCalledWith('s1', true);
    flashCb!({ sid: 's1', on: false });
    expect(setFlashSpy).toHaveBeenCalledWith('s1', false);
  });

  it('ignores malformed events', () => {
    renderHook(() => useNotifyFlashBridge());
    flashCb!({ sid: '', on: true });
    flashCb!(undefined as unknown as { sid: string; on: boolean });
    expect(setFlashSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when the bridge is missing', () => {
    delete (window as unknown as { ccsmNotify?: unknown }).ccsmNotify;
    expect(() => renderHook(() => useNotifyFlashBridge())).not.toThrow();
  });
});
