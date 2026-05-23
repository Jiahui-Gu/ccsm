import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionActiveBridge } from '../../src/app-effects/useSessionActiveBridge';

describe('useSessionActiveBridge', () => {
  let setActive: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActive = vi.fn();
    (window as unknown as { ccsmSession: unknown }).ccsmSession = { setActive };
  });

  afterEach(() => {
    delete (window as unknown as { ccsmSession?: unknown }).ccsmSession;
  });

  it('forwards a non-empty activeId on mount', () => {
    renderHook(() => useSessionActiveBridge('abc'));
    expect(setActive).toHaveBeenCalledWith('abc');
  });

  it('coerces empty / undefined / null to null', () => {
    renderHook(() => useSessionActiveBridge(''));
    expect(setActive).toHaveBeenLastCalledWith(null);
    setActive.mockClear();
    renderHook(() => useSessionActiveBridge(undefined));
    expect(setActive).toHaveBeenLastCalledWith(null);
    setActive.mockClear();
    renderHook(() => useSessionActiveBridge(null));
    expect(setActive).toHaveBeenLastCalledWith(null);
  });

  it('re-fires when activeId changes', () => {
    const { rerender } = renderHook(({ id }: { id: string }) => useSessionActiveBridge(id), {
      initialProps: { id: 'a' },
    });
    rerender({ id: 'b' });
    expect(setActive).toHaveBeenNthCalledWith(1, 'a');
    expect(setActive).toHaveBeenNthCalledWith(2, 'b');
  });

  it('is a no-op when the bridge is missing: setActive never called', () => {
    const capturedSpy = setActive;
    delete (window as unknown as { ccsmSession?: unknown }).ccsmSession;
    const { rerender, unmount } = renderHook(
      ({ id }: { id: string | null }) => useSessionActiveBridge(id),
      { initialProps: { id: 'x' as string | null } }
    );
    expect(capturedSpy).not.toHaveBeenCalled();
    rerender({ id: 'y' });
    expect(capturedSpy).not.toHaveBeenCalled();
    unmount();
    expect(capturedSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when bridge.setActive is not a function', () => {
    (window as unknown as { ccsmSession: unknown }).ccsmSession = { setActive: null };
    renderHook(() => useSessionActiveBridge('x'));
    expect(setActive).not.toHaveBeenCalled();
  });
});
