import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTutorialOverlay } from '../../src/app-effects/useTutorialOverlay';

describe('useTutorialOverlay', () => {
  it('shows the overlay when tutorialSeen is false', () => {
    const { result } = renderHook(() =>
      useTutorialOverlay({ tutorialSeen: false, markTutorialSeen: vi.fn() })
    );
    expect(result.current.show).toBe(true);
  });

  it('hides the overlay when tutorialSeen is true', () => {
    const { result } = renderHook(() =>
      useTutorialOverlay({ tutorialSeen: true, markTutorialSeen: vi.fn() })
    );
    expect(result.current.show).toBe(false);
  });

  it('dismiss() hides the overlay AND calls markTutorialSeen', () => {
    const markTutorialSeen = vi.fn();
    const { result } = renderHook(() =>
      useTutorialOverlay({ tutorialSeen: false, markTutorialSeen })
    );
    expect(result.current.show).toBe(true);
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.show).toBe(false);
    expect(markTutorialSeen).toHaveBeenCalledTimes(1);
  });

  it('reacts to tutorialSeen prop changes (e.g. user resets from settings)', () => {
    const { result, rerender } = renderHook(
      ({ seen }: { seen: boolean }) =>
        useTutorialOverlay({ tutorialSeen: seen, markTutorialSeen: vi.fn() }),
      { initialProps: { seen: true } }
    );
    expect(result.current.show).toBe(false);
    rerender({ seen: false });
    expect(result.current.show).toBe(true);
  });
});
