import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCwdRedirectedBridge } from '../../src/app-effects/useCwdRedirectedBridge';

describe('useCwdRedirectedBridge', () => {
  let onCwdRedirected: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let cb: ((e: { sid: string; newCwd: string }) => void) | null = null;

  beforeEach(() => {
    unsubscribe = vi.fn();
    onCwdRedirected = vi.fn((c: typeof cb) => {
      cb = c;
      return unsubscribe;
    });
    (window as unknown as { ccsmSession: unknown }).ccsmSession = { onCwdRedirected };
  });

  afterEach(() => {
    delete (window as unknown as { ccsmSession?: unknown }).ccsmSession;
    cb = null;
  });

  it('subscribes on mount and unsubscribes on unmount', () => {
    const apply = vi.fn();
    const { unmount } = renderHook(() => useCwdRedirectedBridge(apply));
    expect(onCwdRedirected).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('forwards valid events to applyCwdRedirect', () => {
    const apply = vi.fn();
    renderHook(() => useCwdRedirectedBridge(apply));
    cb!({ sid: 'abc', newCwd: '/new/path' });
    expect(apply).toHaveBeenCalledWith('abc', '/new/path');
  });

  it('ignores empty / malformed events', () => {
    const apply = vi.fn();
    renderHook(() => useCwdRedirectedBridge(apply));
    cb!({ sid: '', newCwd: '/x' });
    cb!({ sid: 'a', newCwd: '' });
    cb!(undefined as unknown as { sid: string; newCwd: string });
    expect(apply).not.toHaveBeenCalled();
  });

  it('is a no-op when the bridge is missing: never invokes apply, mount + unmount clean', () => {
    delete (window as unknown as { ccsmSession?: unknown }).ccsmSession;
    const apply = vi.fn();
    const { unmount } = renderHook(() => useCwdRedirectedBridge(apply));
    expect(onCwdRedirected).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    unmount();
    // Cleanup path must not have invoked the (absent) unsubscribe spy
    // either — the early-return guards both subscribe and teardown.
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('is a no-op when onCwdRedirected is not a function on the bridge', () => {
    (window as unknown as { ccsmSession: unknown }).ccsmSession = { onCwdRedirected: 42 };
    const apply = vi.fn();
    const { unmount } = renderHook(() => useCwdRedirectedBridge(apply));
    unmount();
    expect(apply).not.toHaveBeenCalled();
  });
});
