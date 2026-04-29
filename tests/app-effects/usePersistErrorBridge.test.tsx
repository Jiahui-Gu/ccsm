import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const setPersistErrorHandler = vi.fn();
let installed: (() => void) | null = null;

vi.mock('../../src/stores/persist', () => ({
  setPersistErrorHandler: (fn: () => void) => {
    installed = fn;
    setPersistErrorHandler(fn);
  },
}));

import { usePersistErrorBridge } from '../../src/app-effects/usePersistErrorBridge';

describe('usePersistErrorBridge', () => {
  beforeEach(() => {
    setPersistErrorHandler.mockClear();
    installed = null;
  });

  it('installs a handler on mount and clears it on unmount', () => {
    const push = vi.fn();
    const { unmount } = renderHook(() => usePersistErrorBridge({ push }));
    expect(setPersistErrorHandler).toHaveBeenCalledTimes(1);
    expect(typeof installed).toBe('function');
    unmount();
    // Mount installs once, unmount installs the no-op clearing handler.
    expect(setPersistErrorHandler).toHaveBeenCalledTimes(2);
  });

  it('debounces error toasts within a 5s window', () => {
    const push = vi.fn();
    renderHook(() => usePersistErrorBridge({ push }));
    installed!();
    installed!();
    installed!();
    expect(push).toHaveBeenCalledTimes(1);
    const toast = push.mock.calls[0][0];
    expect(toast.kind).toBe('error');
    expect(toast.title).toBe('Failed to save state');
  });
});
