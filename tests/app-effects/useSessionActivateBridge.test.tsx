import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionActivateBridge } from '../../src/app-effects/useSessionActivateBridge';

describe('useSessionActivateBridge', () => {
  let onActivate: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let activateCallback: ((e: { sid: string }) => void) | null = null;

  beforeEach(() => {
    unsubscribe = vi.fn();
    onActivate = vi.fn((cb: (e: { sid: string }) => void) => {
      activateCallback = cb;
      return unsubscribe;
    });
    (window as unknown as { ccsmSession: unknown }).ccsmSession = { onActivate };
  });

  afterEach(() => {
    delete (window as unknown as { ccsmSession?: unknown }).ccsmSession;
    activateCallback = null;
  });

  it('subscribes on mount and unsubscribes on unmount', () => {
    const selectSession = vi.fn();
    const { unmount } = renderHook(() => useSessionActivateBridge(selectSession));
    expect(onActivate).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('forwards a valid sid to selectSession', () => {
    const selectSession = vi.fn();
    renderHook(() => useSessionActivateBridge(selectSession));
    activateCallback!({ sid: 'abc123' });
    expect(selectSession).toHaveBeenCalledWith('abc123');
  });

  it('ignores empty / malformed events', () => {
    const selectSession = vi.fn();
    renderHook(() => useSessionActivateBridge(selectSession));
    activateCallback!({ sid: '' });
    activateCallback!({ sid: undefined as unknown as string });
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('is a no-op when the bridge is missing', () => {
    delete (window as unknown as { ccsmSession?: unknown }).ccsmSession;
    const selectSession = vi.fn();
    expect(() =>
      renderHook(() => useSessionActivateBridge(selectSession))
    ).not.toThrow();
  });
});
