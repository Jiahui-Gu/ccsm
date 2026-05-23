import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionTitleBridge } from '../../src/app-effects/useSessionTitleBridge';

describe('useSessionTitleBridge', () => {
  let onTitle: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let titleCb: ((e: { sid: string; title: string }) => void) | null = null;

  beforeEach(() => {
    unsubscribe = vi.fn();
    onTitle = vi.fn((cb: typeof titleCb) => {
      titleCb = cb;
      return unsubscribe;
    });
    (window as unknown as { ccsmSession: unknown }).ccsmSession = { onTitle };
  });

  afterEach(() => {
    delete (window as unknown as { ccsmSession?: unknown }).ccsmSession;
    titleCb = null;
  });

  it('subscribes on mount and unsubscribes on unmount', () => {
    const apply = vi.fn();
    const { unmount } = renderHook(() => useSessionTitleBridge(apply));
    expect(onTitle).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('forwards valid title events to applyExternalTitle', () => {
    const apply = vi.fn();
    renderHook(() => useSessionTitleBridge(apply));
    titleCb!({ sid: 'abc', title: 'My session' });
    expect(apply).toHaveBeenCalledWith('abc', 'My session');
  });

  it('ignores empty / malformed events', () => {
    const apply = vi.fn();
    renderHook(() => useSessionTitleBridge(apply));
    titleCb!({ sid: '', title: 't' });
    titleCb!({ sid: 'abc', title: '' });
    titleCb!(undefined as unknown as { sid: string; title: string });
    expect(apply).not.toHaveBeenCalled();
  });

  it('is a no-op when the bridge is missing: subscribe + apply never called', () => {
    delete (window as unknown as { ccsmSession?: unknown }).ccsmSession;
    const apply = vi.fn();
    const { unmount } = renderHook(() => useSessionTitleBridge(apply));
    expect(onTitle).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('is a no-op when onTitle is not a function on the bridge', () => {
    (window as unknown as { ccsmSession: unknown }).ccsmSession = { onTitle: undefined };
    const apply = vi.fn();
    const { unmount } = renderHook(() => useSessionTitleBridge(apply));
    unmount();
    expect(apply).not.toHaveBeenCalled();
  });
});
