import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUpdateDownloadedBridge } from '../../src/app-effects/useUpdateDownloadedBridge';

describe('useUpdateDownloadedBridge', () => {
  let onUpdateDownloaded: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let downloadedCb: ((info: { version: string }) => void) | null = null;
  let updatesInstall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    unsubscribe = vi.fn();
    onUpdateDownloaded = vi.fn((cb: (info: { version: string }) => void) => {
      downloadedCb = cb;
      return unsubscribe;
    });
    updatesInstall = vi.fn();
    (window as unknown as { ccsm: unknown }).ccsm = {
      onUpdateDownloaded,
      updatesInstall,
    };
  });

  afterEach(() => {
    delete (window as unknown as { ccsm?: unknown }).ccsm;
    downloadedCb = null;
  });

  it('subscribes on mount and unsubscribes on unmount', () => {
    const push = vi.fn();
    const { unmount } = renderHook(() => useUpdateDownloadedBridge({ push }));
    expect(onUpdateDownloaded).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('pushes a single persistent toast on first update event, then ignores subsequent events', () => {
    const push = vi.fn();
    renderHook(() => useUpdateDownloadedBridge({ push }));
    downloadedCb!({ version: '1.2.3' });
    downloadedCb!({ version: '1.2.4' });
    expect(push).toHaveBeenCalledTimes(1);
    const toast = push.mock.calls[0][0];
    expect(toast.kind).toBe('info');
    expect(toast.persistent).toBe(true);
    expect(typeof toast.action.onClick).toBe('function');
    toast.action.onClick();
    expect(updatesInstall).toHaveBeenCalledTimes(1);
  });
});
