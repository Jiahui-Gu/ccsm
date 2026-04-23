import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Capture the currently-focused element when `open` flips to true, and
 * expose an `onCloseAutoFocus` handler that restores focus to it when the
 * Radix dialog closes.
 *
 * Radix Dialog auto-restores focus when opened via `<Dialog.Trigger>`, but
 * many of our dialogs (Settings, CommandPalette, Import) are opened
 * imperatively from keyboard shortcuts or context-menu items. In those
 * paths there is no Trigger, so the dialog closes onto `document.body` and
 * keyboard / screen-reader users lose their place.
 *
 * USAGE: pass the returned handler into the Radix `Dialog.Content`
 * `onCloseAutoFocus` prop:
 *
 *   const { handleCloseAutoFocus } = useFocusRestore(open, {
 *     fallbackSelector: '...'
 *   });
 *   <Dialog.Content onCloseAutoFocus={handleCloseAutoFocus} ...>
 *
 * The handler calls `event.preventDefault()` to suppress Radix's own
 * focus-return path, then synchronously focuses the captured element.
 * Synchronous focus inside `onCloseAutoFocus` is the pattern Radix's docs
 * explicitly recommend; it eliminates the race that any deferred
 * (setTimeout-based) restore would lose against Radix's own focus moves.
 *
 * Capture uses `useLayoutEffect` so it commits before Radix's child
 * focus-trap effects move focus into the dialog. Otherwise we'd capture
 * the focus-trap sentinel, not the user's previous focus.
 */
export function useFocusRestore(
  open: boolean,
  options: { fallbackSelector?: string } = {}
): { handleCloseAutoFocus: (event: Event) => void } {
  const previousRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const fallbackSelectorRef = useRef(options.fallbackSelector);
  fallbackSelectorRef.current = options.fallbackSelector;

  // Capture before any child (Radix Dialog) layout effect can move focus
  // into the dialog. Parent layout effects run before child layout effects.
  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement
      ) {
        previousRef.current = active;
      } else {
        previousRef.current = null;
      }
      wasOpenRef.current = true;
    } else if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
    }
  }, [open]);

  const handleCloseAutoFocus = useCallback((event: Event) => {
    // Suppress Radix's default restore so it doesn't race us / land on body.
    event.preventDefault();
    const target = previousRef.current;
    previousRef.current = null;
    if (target && document.contains(target)) {
      try {
        target.focus();
        return;
      } catch {
        // fall through to fallback
      }
    }
    const sel = fallbackSelectorRef.current;
    if (sel) {
      const el = document.querySelector<HTMLElement>(sel);
      el?.focus();
    }
  }, []);

  return { handleCloseAutoFocus };
}
