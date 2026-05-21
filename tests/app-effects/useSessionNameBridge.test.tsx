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

  it('emits null clear for sids that disappear between renders, without re-emitting unchanged names', () => {
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
    // s2 cleared. s1 is NOT re-emitted because its name didn't change —
    // re-emitting on every render would fire one IPC per session per JSONL
    // state toggle, which is the perf regression this diff guards against.
    expect(setName).toHaveBeenCalledWith('s2', null);
    expect(setName).not.toHaveBeenCalledWith('s1', 'Alpha');
  });

  it('only IPCs for sids whose name actually changed', () => {
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
    // Rerender with a NEW array reference but identical contents — this is
    // the hot path when the store toggles a different session's `state`
    // field. Zero IPCs expected.
    rerender({
      list: [
        { id: 's1', name: 'Alpha' },
        { id: 's2', name: 'Beta' },
      ],
    });
    expect(setName).not.toHaveBeenCalled();

    // Rename s2 only — exactly one IPC, for s2.
    setName.mockClear();
    rerender({
      list: [
        { id: 's1', name: 'Alpha' },
        { id: 's2', name: 'Beta renamed' },
      ],
    });
    expect(setName).toHaveBeenCalledTimes(1);
    expect(setName).toHaveBeenCalledWith('s2', 'Beta renamed');
  });

  it('is a no-op when the bridge is missing', () => {
    delete (window as unknown as { ccsmSession?: unknown }).ccsmSession;
    expect(() =>
      renderHook(() => useSessionNameBridge([{ id: 's1', name: 'X' }]))
    ).not.toThrow();
  });
});
