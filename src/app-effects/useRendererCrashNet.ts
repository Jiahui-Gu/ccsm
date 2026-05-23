import { useEffect } from 'react';
import { error as logError } from '../shared/log';

/**
 * Installs window-level `'error'` and `'unhandledrejection'` listeners that
 * forward to the shared logger (and, via that seam, to Sentry).
 *
 * History: these listeners used to be registered at module-eval time in
 * `src/index.tsx`, BEFORE `createRoot` ran. On Linux Chromium under xvfb that
 * boot-phase registration reproducibly broke `harness-dnd` Case 1
 * ("s1 did not land in g2"): the bare presence of a top-level `'error'`
 * listener before the React tree mounted appeared to perturb dnd-kit's
 * synthetic pointer-event reconstruction (cancelable / microtask-ordering
 * edge in some Chromium versions). Confirmed via git bisect of #1318.
 *
 * Moving the install into a `useEffect` defers it until after React mount,
 * which closes the boot-phase window. Everything user-triggerable still runs
 * inside the listeners' lifetime, so the crash net loses no real coverage.
 */
export function useRendererCrashNet(): void {
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      logError('renderer', 'unhandled rejection', e.reason);
    };
    const onError = (e: ErrorEvent) => {
      logError('renderer', 'uncaught error', e.error ?? e.message);
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);
}
