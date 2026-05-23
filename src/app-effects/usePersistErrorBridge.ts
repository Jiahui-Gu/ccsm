import { useEffect } from 'react';
import { setPersistErrorHandler } from '../stores/persist';

export interface PersistErrorToast {
  kind: 'error';
  title: string;
  body: string;
  /**
   * When set, the toast stays until the user dismisses it. Used for the
   * `value_too_large` failure mode — silently retrying every 250 ms with no
   * visible signal would silently lose every subsequent edit until quit,
   * which then rolls the user back to potentially weeks-old state on
   * relaunch (see #F5 / persist-oversize regression test).
   */
  persistent?: boolean;
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
 * Two failure shapes are distinguished:
 *   - `value_too_large`: the snapshot exceeded the IPC validator's cap
 *     (`MAX_STATE_VALUE_BYTES` in electron/db-validate.ts). This is the
 *     silent-data-loss path — every subsequent write also fails, so we
 *     surface it as a persistent toast and log a diagnostic breadcrumb.
 *   - everything else: disk full / I/O / corruption. Generic transient
 *     toast (debounced) — old behaviour, preserved.
 *
 * Hook-form rewrite of the inline `<PersistErrorBridge />` component that
 * used to live at the bottom of App.tsx, extracted under Task #724.
 */
export function usePersistErrorBridge(deps: PersistErrorDeps): void {
  const { push } = deps;
  useEffect(() => {
    let lastShown = 0;
    let oversizeShown = false;
    setPersistErrorHandler((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'value_too_large') {
        // Loud + diagnostic. We log every occurrence (one console.error per
        // failed write is fine — there's one every 250 ms at most because
        // of the persist debounce, and the renderer log buffer is bounded)
        // but only push ONE persistent toast — a stack of identical
        // persistent toasts would just be noise.
        console.error(
          '[persist] oversize snapshot rejected by main (value_too_large);',
          'recent settings/sidebar changes will not survive restart until resolved.',
        );
        if (oversizeShown) return;
        oversizeShown = true;
        push({
          kind: 'error',
          title: 'Settings too large to save',
          body:
            'Your sidebar and session list have grown past the save limit. ' +
            'Recent changes will not survive restart. Try removing unused ' +
            'sessions or groups, or contact support.',
          persistent: true,
        });
        return;
      }
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
