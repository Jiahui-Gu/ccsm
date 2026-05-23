// Tests for `useRendererCrashNet` (PR-B2 / audit gap from PR #1320).
//
// The hook installs window-level 'error' and 'unhandledrejection' listeners
// inside a `useEffect` and removes them in cleanup. Per memory
// `feedback_pre_react_mount_listeners.md`, the listeners MUST be installed
// in useEffect, NEVER at module-eval time — installing them before
// `createRoot` breaks dnd-kit synthetic pointer events under Linux/xvfb
// (confirmed via the bisect that produced #1320).
//
// Coverage here:
//   - subscribe on mount via addEventListener spy
//   - unsubscribe on unmount via removeEventListener spy (with the SAME
//     handler reference — listeners actually removable, not leaked)
//   - 'error' event forwards to the shared `error()` logger sink
//   - 'unhandledrejection' event forwards to the same sink
//   - no listener installation happens at module-eval (memory contract)
//
// jsdom provides a real `window`; we spy on add/removeEventListener to
// avoid asserting via side-effects on a global the hook also dispatches
// to (race-prone).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const logErrorSpy = vi.fn();

vi.mock('../../src/shared/log', () => ({
  error: (...args: unknown[]) => logErrorSpy(...args),
  warn: vi.fn(),
}));

describe('useRendererCrashNet', () => {
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logErrorSpy.mockClear();
    addSpy = vi.spyOn(window, 'addEventListener');
    removeSpy = vi.spyOn(window, 'removeEventListener');
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('does NOT install listeners at module-eval time (memory: pre-React-mount listeners ban)', async () => {
    // Re-import the hook in isolation and confirm that merely importing
    // the module does not register a 'error' or 'unhandledrejection'
    // listener on window. The contract: listeners go in useEffect.
    //
    // CRITICAL: vitest's ESM module cache short-circuits a second
    // `await import(...)` to the cached module record, so the module's
    // top-level code does NOT re-execute and `addSpy` (cleared in
    // beforeEach) sees zero calls regardless of where the install
    // lives. Without `vi.resetModules()` this assertion is a tautology.
    // Reset is scoped to THIS test only — other tests rely on the
    // cached module so their addSpy records reflect the useEffect
    // install, not a re-eval.
    //
    // Mutation check (performed locally before commit): moving
    // `window.addEventListener` calls from inside useEffect to the
    // module top level causes this test to fail with both 'error' and
    // 'unhandledrejection' showing up in `installed`.
    vi.resetModules();
    addSpy.mockClear();
    await import('../../src/app-effects/useRendererCrashNet');
    const installed = addSpy.mock.calls
      .map((c) => c[0])
      .filter((t) => t === 'error' || t === 'unhandledrejection');
    expect(installed).toEqual([]);
  });

  it('installs error + unhandledrejection listeners on mount', async () => {
    const { useRendererCrashNet } = await import('../../src/app-effects/useRendererCrashNet');
    addSpy.mockClear();
    renderHook(() => useRendererCrashNet());

    const types = addSpy.mock.calls.map((c) => c[0]);
    expect(types).toContain('error');
    expect(types).toContain('unhandledrejection');
  });

  it('removes BOTH listeners with the same handler refs on unmount', async () => {
    const { useRendererCrashNet } = await import('../../src/app-effects/useRendererCrashNet');
    addSpy.mockClear();
    removeSpy.mockClear();
    const { unmount } = renderHook(() => useRendererCrashNet());

    // Capture the (type → handler) pairs that were added.
    const added = new Map<string, EventListenerOrEventListenerObject>();
    for (const call of addSpy.mock.calls) {
      const [type, handler] = call as [string, EventListenerOrEventListenerObject];
      if (type === 'error' || type === 'unhandledrejection') {
        added.set(type, handler);
      }
    }
    expect(added.size).toBe(2);

    unmount();

    // After unmount, both types should be removed with the IDENTICAL
    // handler reference — anything else would be a leak.
    const removed = new Map<string, EventListenerOrEventListenerObject>();
    for (const call of removeSpy.mock.calls) {
      const [type, handler] = call as [string, EventListenerOrEventListenerObject];
      if (type === 'error' || type === 'unhandledrejection') {
        removed.set(type, handler);
      }
    }
    expect(removed.get('error')).toBe(added.get('error'));
    expect(removed.get('unhandledrejection')).toBe(added.get('unhandledrejection'));
  });

  it('forwards window "error" event to logError("renderer", "uncaught error", ...)', async () => {
    const { useRendererCrashNet } = await import('../../src/app-effects/useRendererCrashNet');
    renderHook(() => useRendererCrashNet());

    const boom = new Error('boom');
    const evt = new ErrorEvent('error', { error: boom, message: 'boom-msg' });
    window.dispatchEvent(evt);

    expect(logErrorSpy).toHaveBeenCalledWith('renderer', 'uncaught error', boom);
  });

  it('falls back to event.message when event.error is missing', async () => {
    const { useRendererCrashNet } = await import('../../src/app-effects/useRendererCrashNet');
    renderHook(() => useRendererCrashNet());

    // Some Chromium error events (cross-origin script errors) only populate
    // `message`. The hook documents `e.error ?? e.message`; assert that fallback.
    const evt = new ErrorEvent('error', { message: 'cross-origin-script-error' });
    // Manually clear .error (jsdom may set it to null by default; ensure):
    Object.defineProperty(evt, 'error', { value: undefined, configurable: true });
    window.dispatchEvent(evt);

    expect(logErrorSpy).toHaveBeenCalledWith(
      'renderer',
      'uncaught error',
      'cross-origin-script-error',
    );
  });

  it('forwards window "unhandledrejection" event to logError with the reason', async () => {
    const { useRendererCrashNet } = await import('../../src/app-effects/useRendererCrashNet');
    renderHook(() => useRendererCrashNet());

    const reason = new Error('async-boom');
    // jsdom's PromiseRejectionEvent constructor exists; if not, fall back.
    const PRE: typeof PromiseRejectionEvent | undefined = (globalThis as any).PromiseRejectionEvent;
    let evt: Event;
    if (typeof PRE === 'function') {
      evt = new PRE('unhandledrejection', {
        promise: Promise.reject(reason).catch(() => undefined) as unknown as Promise<unknown>,
        reason,
      });
    } else {
      evt = new Event('unhandledrejection');
      (evt as unknown as { reason: unknown }).reason = reason;
    }
    window.dispatchEvent(evt);

    expect(logErrorSpy).toHaveBeenCalledWith('renderer', 'unhandled rejection', reason);
  });

  it('after unmount, dispatched events no longer reach logError', async () => {
    const { useRendererCrashNet } = await import('../../src/app-effects/useRendererCrashNet');
    const { unmount } = renderHook(() => useRendererCrashNet());

    // Strong form: first prove the listener IS wired by dispatching
    // pre-unmount and asserting logError fires. Without this, the
    // negative-only assertion below would also pass for a hook that
    // simply never installed the listener.
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('pre-unmount') }));
    expect(logErrorSpy).toHaveBeenCalledTimes(1);

    unmount();
    logErrorSpy.mockClear();

    // jsdom re-raises ErrorEvent.error as an uncaught error on dispatch,
    // which would fail the suite even after our handler is gone. Use a
    // bare Event of type 'error' instead — the listener (if still
    // attached) would still receive it, and that's what we're checking.
    window.dispatchEvent(new Event('error'));
    expect(logErrorSpy).not.toHaveBeenCalled();
  });
});
