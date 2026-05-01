// Regression: PR #520 (#613) — `fix(notify): clear sessionNamesFromRenderer
// on session delete`.
//
// Bug: the renderer mirrors per-session `(sid, name)` pairs to main's
// `sessionNamesFromRenderer` Map (via `ccsmSession.setName` IPC) so the
// desktop-notify bridge can label OS toasts with the friendly name
// instead of the bare UUID. Before the fix the renderer never emitted a
// clearing call when a sid disappeared from the sessions array, so
// main's map grew unbounded across the app lifetime (~50 bytes per
// ever-created-then-deleted session). Audit #876 cluster H, follow-up
// to PR #509.
//
// Fix lives in `src/app-effects/useSessionNameBridge.ts`: on each
// `sessions` update, diff against a `prevSidsRef` snapshot and emit
// `bridge.setName(staleSid, null)` for any sid no longer present.
//
// Existing coverage gap: the harness-real-cli probe
// `notify-name-cleared-on-session-delete` covers the end-to-end path
// against a real Electron + claude CLI (~30s). There is NO unit test
// exercising the renderer-side cleanup logic in isolation, so a
// refactor that moves the cleanup branch out of the effect (e.g.
// "we'll let main GC by tracking unwatched events instead") would only
// surface in a slow e2e run. This file pins the contract at the hook
// boundary.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionNameBridge } from '../../src/app-effects/useSessionNameBridge';

type SessionLike = { id: string; name?: string | null };

function installBridge() {
  const setName = vi.fn();
  (window as unknown as { ccsmSession: { setName: typeof setName } }).ccsmSession = {
    setName,
  };
  return setName;
}

afterEach(() => {
  (window as unknown as { ccsmSession?: unknown }).ccsmSession = undefined;
});

describe('PR #520 regression — useSessionNameBridge clears stale sids', () => {
  let setName: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setName = installBridge();
  });

  it('mirrors current (sid, name) pairs to main on first render', () => {
    const sessions: SessionLike[] = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ];
    renderHook(({ s }: { s: SessionLike[] }) => useSessionNameBridge(s), {
      initialProps: { s: sessions },
    });
    expect(setName).toHaveBeenCalledWith('a', 'Alpha');
    expect(setName).toHaveBeenCalledWith('b', 'Beta');
    // No clearing calls on the first pass — the prev-snapshot is empty.
    const clearCalls = setName.mock.calls.filter((c) => c[1] === null);
    expect(clearCalls).toEqual([]);
  });

  it('emits setName(sid, null) for sids that disappear between renders', () => {
    const initial: SessionLike[] = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
      { id: 'c', name: 'Gamma' },
    ];
    const after: SessionLike[] = [
      { id: 'a', name: 'Alpha' },
      // 'b' and 'c' deleted
    ];
    const { rerender } = renderHook(({ s }: { s: SessionLike[] }) => useSessionNameBridge(s), {
      initialProps: { s: initial },
    });
    setName.mockClear();
    rerender({ s: after });

    // Surviving sid is re-pushed (idempotent in main).
    expect(setName).toHaveBeenCalledWith('a', 'Alpha');
    // Both deleted sids must receive an explicit null clear so main's
    // sessionNamesFromRenderer Map drops them.
    expect(setName).toHaveBeenCalledWith('b', null);
    expect(setName).toHaveBeenCalledWith('c', null);
  });

  it('does NOT emit clears for sids that are still present', () => {
    const sessions: SessionLike[] = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ];
    const { rerender } = renderHook(({ s }: { s: SessionLike[] }) => useSessionNameBridge(s), {
      initialProps: { s: sessions },
    });
    setName.mockClear();
    // Re-render with the SAME sids but a renamed entry — no clears
    // expected, only the rename pushes through.
    rerender({ s: [{ id: 'a', name: 'Alpha-2' }, { id: 'b', name: 'Beta' }] });
    const clearCalls = setName.mock.calls.filter((c) => c[1] === null);
    expect(clearCalls).toEqual([]);
    expect(setName).toHaveBeenCalledWith('a', 'Alpha-2');
  });

  it('handles a full delete-all transition (every sid cleared)', () => {
    const initial: SessionLike[] = [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ];
    const { rerender } = renderHook(({ s }: { s: SessionLike[] }) => useSessionNameBridge(s), {
      initialProps: { s: initial },
    });
    setName.mockClear();
    rerender({ s: [] });
    expect(setName).toHaveBeenCalledWith('a', null);
    expect(setName).toHaveBeenCalledWith('b', null);
  });

  it('is a no-op when window.ccsmSession is unavailable (preload not wired)', () => {
    (window as unknown as { ccsmSession?: unknown }).ccsmSession = undefined;
    expect(() =>
      renderHook(() => useSessionNameBridge([{ id: 'a', name: 'Alpha' }])),
    ).not.toThrow();
  });
});
