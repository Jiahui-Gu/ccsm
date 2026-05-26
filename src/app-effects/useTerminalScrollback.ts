import { useEffect } from 'react';
import { useStore } from '../stores/store';
import { applyTerminalScrollback } from '../terminal/shellRegistry';

/**
 * Hot-apply the `scrollbackLines` store field to every warm xterm entry.
 *
 * The store action (`setScrollbackLines`, dispatched from the Appearance
 * settings pane on input commit / reset) is the source of truth. This
 * effect listens for changes and dispatches `applyTerminalScrollback`,
 * which assigns `term.options.scrollback = n` on each warm entry.
 *
 * No first-mount apply: the registry's `allocEntry` reads the store
 * directly when constructing each Terminal, so the boot value is already
 * wired in. We only react to subsequent changes via the subscriber.
 *
 * Companion knob `useTerminalFontSize` follows the same pattern; the
 * scrollback variant is simpler because there is no resize-replay,
 * IME guard, or pending-defer needed — xterm handles cap shrinks
 * internally (trims oldest rows immediately) and cap grows are a
 * no-op until new writes arrive.
 */
export function useTerminalScrollback(): void {
  useEffect(() => {
    let prev = useStore.getState().scrollbackLines;
    const unsubscribe = useStore.subscribe((s) => {
      const next = s.scrollbackLines;
      if (next === prev) return;
      prev = next;
      applyTerminalScrollback(next);
    });
    return () => {
      unsubscribe();
    };
  }, []);
}
