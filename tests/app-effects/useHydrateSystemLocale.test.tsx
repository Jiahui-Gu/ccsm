import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useHydrateSystemLocale } from '../../src/app-effects/useHydrateSystemLocale';

describe('useHydrateSystemLocale', () => {
  afterEach(() => {
    delete (window as unknown as { ccsm?: unknown }).ccsm;
  });

  it('hydrates with the locale returned by main', async () => {
    const getSystemLocale = vi.fn().mockResolvedValue('zh-CN');
    (window as unknown as { ccsm: unknown }).ccsm = { i18n: { getSystemLocale } };
    const hydrate = vi.fn();
    renderHook(() => useHydrateSystemLocale(hydrate));
    await waitFor(() => expect(hydrate).toHaveBeenCalledWith('zh-CN'));
  });

  it('falls back to navigator.language when bridge throws', async () => {
    const getSystemLocale = vi.fn().mockRejectedValue(new Error('no'));
    (window as unknown as { ccsm: unknown }).ccsm = { i18n: { getSystemLocale } };
    const hydrate = vi.fn();
    renderHook(() => useHydrateSystemLocale(hydrate));
    await waitFor(() => expect(hydrate).toHaveBeenCalled());
    const arg = hydrate.mock.calls[0][0];
    expect(arg === navigator.language || arg === undefined).toBe(true);
  });

  it('does not call hydrate after unmount (cancellation)', async () => {
    let resolve!: (v: string) => void;
    const getSystemLocale = vi.fn().mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    (window as unknown as { ccsm: unknown }).ccsm = { i18n: { getSystemLocale } };
    const hydrate = vi.fn();
    const { unmount } = renderHook(() => useHydrateSystemLocale(hydrate));
    unmount();
    resolve('en');
    // Give the microtask queue a beat to flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(hydrate).not.toHaveBeenCalled();
  });
});
