import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePtyExitBridge } from '../../src/app-effects/usePtyExitBridge';

describe('usePtyExitBridge', () => {
  let onExit: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let exitCb: ((e: { sessionId: string; code?: number | null; signal?: string | number | null }) => void) | null = null;

  beforeEach(() => {
    unsubscribe = vi.fn();
    onExit = vi.fn((cb: typeof exitCb) => {
      exitCb = cb;
      return unsubscribe;
    });
    (window as unknown as { ccsmPty: unknown }).ccsmPty = { onExit };
  });

  afterEach(() => {
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
    exitCb = null;
  });

  it('subscribes on mount and unsubscribes on unmount', () => {
    const apply = vi.fn();
    const { unmount } = renderHook(() => usePtyExitBridge(apply));
    expect(onExit).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('forwards valid exit events to applyPtyExit with normalized payload', () => {
    const apply = vi.fn();
    renderHook(() => usePtyExitBridge(apply));
    exitCb!({ sessionId: 's1', code: 137, signal: 'SIGTERM' });
    expect(apply).toHaveBeenCalledWith('s1', { code: 137, signal: 'SIGTERM' });
    exitCb!({ sessionId: 's2' });
    expect(apply).toHaveBeenCalledWith('s2', { code: null, signal: null });
  });

  it('ignores malformed events', () => {
    const apply = vi.fn();
    renderHook(() => usePtyExitBridge(apply));
    exitCb!({ sessionId: '' });
    exitCb!(undefined as unknown as { sessionId: string });
    expect(apply).not.toHaveBeenCalled();
  });

  it('is a no-op when the bridge is missing', () => {
    delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
    expect(() => renderHook(() => usePtyExitBridge(vi.fn()))).not.toThrow();
  });
});
