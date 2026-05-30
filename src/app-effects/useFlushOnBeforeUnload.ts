import { useEffect } from 'react';
import { flushNow } from '../stores/persist';
import { flushDraftsNow } from '../stores/drafts';

/**
 * Installs a `'beforeunload'` listener that flushes the debounced persist
 * queue before the renderer is torn down. Without this, a quit within
 * ~250 ms of the last user action drops that action (sidebar resize, model
 * pick, etc.) on next launch.
 *
 * History: previously registered at module-eval time in `src/index.tsx`,
 * BEFORE `createRoot`. That is the same anti-pattern PR #1320 fixed for the
 * renderer crash-net listeners (see `useRendererCrashNet.ts`). A global
 * window listener installed before the React tree mounts interacts badly
 * with dnd-kit's PointerSensor on Linux Chromium under xvfb and
 * reproducibly flakes `harness-dnd` Case 1 ("s1 did not land in g2") on
 * ubuntu-latest, even though the listener does not preventDefault /
 * stopPropagation. Deferring to `useEffect` closes the boot-phase window —
 * no real coverage is lost because there's no user-triggerable persist
 * write in the boot window before render anyway.
 */
export function useFlushOnBeforeUnload(): void {
  useEffect(() => {
    const onBeforeUnload = () => {
      flushNow();
      flushDraftsNow();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);
}
