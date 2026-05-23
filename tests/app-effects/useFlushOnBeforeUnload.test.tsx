// Tests for `useFlushOnBeforeUnload` (PR #1337 follow-up).
//
// The hook installs a window-level 'beforeunload' listener inside a
// `useEffect` and removes it in cleanup. Per memory
// `feedback_pre_react_mount_listeners.md`, the listener MUST be installed
// in useEffect, NEVER at module-eval time — installing it before
// `createRoot` breaks dnd-kit synthetic pointer events under Linux/xvfb
// (the same anti-pattern PR #1320 fixed for crash-net; PR #1337 is the
// fix for this hook).
//
// Coverage here mirrors `useRendererCrashNet.test.tsx`:
//   - subscribe on mount via addEventListener spy
//   - unsubscribe on unmount via removeEventListener spy with the SAME
//     handler reference (no leak)
//   - 'beforeunload' event triggers flushNow()
//   - no listener installation at module-eval time (memory contract)
//   - after unmount, dispatched events do NOT trigger flushNow

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const flushNowSpy = vi.fn();

vi.mock('../../src/stores/persist', () => ({
  flushNow: (...args: unknown[]) => flushNowSpy(...args),
}));

describe('useFlushOnBeforeUnload', () => {
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    flushNowSpy.mockClear();
    addSpy = vi.spyOn(window, 'addEventListener');
    removeSpy = vi.spyOn(window, 'removeEventListener');
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('does NOT install listener at module-eval time (memory: pre-React-mount listeners ban)', async () => {
    // Re-import the hook in isolation and confirm that merely importing
    // the module does not register a 'beforeunload' listener on window.
    // The contract: listener goes in useEffect.
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
    // Mutation check: moving `window.addEventListener` from inside
    // useEffect to module top level causes this test to fail with
    // 'beforeunload' showing up in `installed`.
    vi.resetModules();
    addSpy.mockClear();
    await import('../../src/app-effects/useFlushOnBeforeUnload');
    const installed = addSpy.mock.calls
      .map((c) => c[0])
      .filter((t) => t === 'beforeunload');
    expect(installed).toEqual([]);
  });

  it('installs beforeunload listener on mount', async () => {
    const { useFlushOnBeforeUnload } = await import(
      '../../src/app-effects/useFlushOnBeforeUnload'
    );
    addSpy.mockClear();
    renderHook(() => useFlushOnBeforeUnload());

    const types = addSpy.mock.calls.map((c) => c[0]);
    expect(types).toContain('beforeunload');
  });

  it('removes beforeunload listener with the same handler ref on unmount', async () => {
    const { useFlushOnBeforeUnload } = await import(
      '../../src/app-effects/useFlushOnBeforeUnload'
    );
    addSpy.mockClear();
    removeSpy.mockClear();
    const { unmount } = renderHook(() => useFlushOnBeforeUnload());

    // Capture the handler ref that was added.
    let addedHandler: EventListenerOrEventListenerObject | undefined;
    for (const call of addSpy.mock.calls) {
      const [type, handler] = call as [string, EventListenerOrEventListenerObject];
      if (type === 'beforeunload') {
        addedHandler = handler;
      }
    }
    expect(addedHandler).toBeDefined();

    unmount();

    // After unmount, 'beforeunload' should be removed with the IDENTICAL
    // handler reference — anything else would be a leak.
    let removedHandler: EventListenerOrEventListenerObject | undefined;
    for (const call of removeSpy.mock.calls) {
      const [type, handler] = call as [string, EventListenerOrEventListenerObject];
      if (type === 'beforeunload') {
        removedHandler = handler;
      }
    }
    expect(removedHandler).toBe(addedHandler);
  });

  it('forwards window "beforeunload" event to flushNow()', async () => {
    const { useFlushOnBeforeUnload } = await import(
      '../../src/app-effects/useFlushOnBeforeUnload'
    );
    renderHook(() => useFlushOnBeforeUnload());

    window.dispatchEvent(new Event('beforeunload'));

    expect(flushNowSpy).toHaveBeenCalledTimes(1);
  });

  it('after unmount, dispatched events no longer reach flushNow', async () => {
    const { useFlushOnBeforeUnload } = await import(
      '../../src/app-effects/useFlushOnBeforeUnload'
    );
    const { unmount } = renderHook(() => useFlushOnBeforeUnload());

    // Strong form: first prove the listener IS wired by dispatching
    // pre-unmount and asserting flushNow fires. Without this, the
    // negative-only assertion below would also pass for a hook that
    // simply never installed the listener.
    window.dispatchEvent(new Event('beforeunload'));
    expect(flushNowSpy).toHaveBeenCalledTimes(1);

    unmount();
    flushNowSpy.mockClear();

    window.dispatchEvent(new Event('beforeunload'));
    expect(flushNowSpy).not.toHaveBeenCalled();
  });
});
