import { useEffect } from 'react';
import { useStore } from '../stores/store';
import { applyTerminalFontSize } from '../terminal/shellRegistry';

/**
 * Bridge the persisted `terminalFontSizePx` store field to the warm xterm
 * registry. The store action (`setTerminalFontSizePx`) is the source of
 * truth — driven by Ctrl+MouseWheel over the terminal pane (and by
 * persistence-rehydrate on boot). This effect listens for changes and
 * dispatches `applyTerminalFontSize`, which:
 *
 *   - applies `term.options.fontSize` + runs resize-replay on the active
 *     warm entry immediately (so cells resize + buffer reflows now);
 *   - marks all other warm entries with `pendingFontSize` for lazy apply
 *     in `ensureAndShowEntry` on next show (prevents N concurrent
 *     snapshot IPCs across N warmed sessions).
 *
 * We do NOT call `applyTerminalFontSize` on first mount with the initial
 * value — the registry's `allocEntry` reads the store directly when it
 * constructs each Terminal, so the boot value is already wired in. We
 * only react to subsequent changes via the subscriber.
 *
 * Persistence rehydrate timing: hydration runs once at boot and sets the
 * field to the persisted value (or default). If that differs from the
 * default `13`, this effect's subscriber will fire after hydrate — but
 * no warm entries exist yet (TerminalPane hasn't mounted), so
 * applyTerminalFontSize is a no-op iteration over an empty map. The
 * first session mount then alloc's a Terminal with the correct font.
 */
export function useTerminalFontSize(): void {
  useEffect(() => {
    let prev = useStore.getState().terminalFontSizePx;
    const unsubscribe = useStore.subscribe((s) => {
      const next = s.terminalFontSizePx;
      if (next === prev) return;
      prev = next;
      void applyTerminalFontSize(next);
    });
    return () => {
      unsubscribe();
    };
  }, []);
}
