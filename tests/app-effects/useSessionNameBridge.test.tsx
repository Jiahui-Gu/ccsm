import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionNameBridge } from '../../src/app-effects/useSessionNameBridge';

describe('useSessionNameBridge', () => {
  let setName: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setName = vi.fn();
    (window as unknown as { ccsmSession: unknown }).ccsmSession = { setName };
  });

  afterEach(() => {
    delete (window as unknown as { ccsmSession?: unknown }).ccsmSession;
  });

  it('emits setName for each session on mount', () => {
    renderHook(() =>
      useSessionNameBridge([
        { id: 's1', name: 'Alpha' },
        { id: 's2', name: null },
      ])
    );
    expect(setName).toHaveBeenCalledWith('s1', 'Alpha');
    expect(setName).toHaveBeenCalledWith('s2', null);
  });

  it('emits null clear for sids that disappear between renders', () => {
    const { rerender } = renderHook(
      ({ list }: { list: Array<{ id: string; name?: string | null }> }) =>
        useSessionNameBridge(list),
      {
        initialProps: {
          list: [
            { id: 's1', name: 'Alpha' },
            { id: 's2', name: 'Beta' },
          ],
        },
      }
    );
    setName.mockClear();
    rerender({ list: [{ id: 's1', name: 'Alpha' }] });
    // s1 re-emitted, s2 cleared.
    expect(setName).toHaveBeenCalledWith('s1', 'Alpha');
    expect(setName).toHaveBeenCalledWith('s2', null);
  });

  it('is a no-op when the bridge is missing', () => {
    delete (window as unknown as { ccsmSession?: unknown }).ccsmSession;
    expect(() =>
      renderHook(() => useSessionNameBridge([{ id: 's1', name: 'X' }]))
    ).not.toThrow();
  });
});
