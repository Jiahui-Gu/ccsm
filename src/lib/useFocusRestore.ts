import { useEffect, useRef } from 'react';

/**
 * Capture the currently-focused element when `open` flips to true, and
 * restore focus to it when `open` flips back to false.
 *
 * Radix Dialog auto-restores focus when opened via `<Dialog.Trigger>`, but
 * many of our dialogs (Settings, CommandPalette, Import) are opened
 * imperatively from keyboard shortcuts or context-menu items. In those
 * paths there is no Trigger, so the dialog closes onto `document.body` and
 * keyboard / screen-reader users lose their place.
 *
 * Usage: call inside the consumer that owns the open state; pass `open`
 * and an optional fallback selector to focus when no prior element is
 * captured (e.g., active session in the sidebar).
 */
export function useFocusRestore(
  open: boolean,
  options: { fallbackSelector?: string } = {}
): void {
  const previousRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = document.activeElement;
      // Skip body/html — they're not meaningful restore targets.
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
      return;
    }

    if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
      const target = previousRef.current;
      previousRef.current = null;

      // Defer past Radix's onCloseAutoFocus (which runs in a microtask
      // chain on close) so our restore wins the race; otherwise Radix may
      // park focus on its own focus-guard div / body.
      const id = window.setTimeout(() => {
        if (target && document.contains(target)) {
          try {
            target.focus();
            return;
          } catch {
            // fall through to fallback
          }
        }
        const sel = options.fallbackSelector;
        if (sel) {
          const el = document.querySelector<HTMLElement>(sel);
          el?.focus();
        }
      }, 50);
      return () => window.clearTimeout(id);
    }
  }, [open, options.fallbackSelector]);
}
