import { useEffect } from 'react';
import { setPersistErrorHandler } from '../stores/persist';

export interface PersistErrorToast {
  kind: 'error';
  title: string;
  body: string;
}

export interface PersistErrorDeps {
  /** Toast push handler (typically from `useToast()`). */
  push: (toast: PersistErrorToast) => void;
}

/**
 * Installs a debounced (5s) toast handler for store persistence errors.
 * Wired through `setPersistErrorHandler` so the store's persist middleware
 * surfaces disk-full / I/O failures to the user as a single toast rather
 * than a flood. Cleared on unmount.
 *
 * Hook-form rewrite of the inline `<PersistErrorBridge />` component that
 * used to live at the bottom of App.tsx, extracted under Task #724.
 */
export function usePersistErrorBridge(deps: PersistErrorDeps): void {
  const { push } = deps;
  useEffect(() => {
    let lastShown = 0;
    setPersistErrorHandler(() => {
      const now = Date.now();
      if (now - lastShown < 5000) return;
      lastShown = now;
      push({
        kind: 'error',
        title: 'Failed to save state',
        body: 'Your recent changes may not survive restart. Check disk space.',
      });
    });
    return () => setPersistErrorHandler(() => {});
  }, [push]);
}
