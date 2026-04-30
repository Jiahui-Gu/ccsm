import { useEffect } from 'react';

/**
 * True when the event target is a text-editable surface where printable
 * keys (like "?") should remain composition input rather than trigger a
 * global shortcut. Used by `useShortcutHandlers` to gate the modifier-free
 * "?" overlay binding.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    const nonText = new Set([
      'checkbox',
      'radio',
      'button',
      'submit',
      'reset',
      'range',
      'color',
      'file',
    ]);
    return !nonText.has(type);
  }
  return false;
}

export interface ShortcutHandlersDeps {
  /** Toggle the shortcut overlay visibility. Bound to Ctrl+/ and "?". */
  toggleShortcuts: () => void;
  /** Toggle the command palette. Bound to Ctrl+F. */
  togglePalette: () => void;
  /** Open the settings dialog. Bound to Ctrl+,. */
  openSettings: () => void;
}

/**
 * Composite hook that installs all global keyboard shortcuts handled at
 * the App level. Combines what was previously a single inline `keydown`
 * listener in App.tsx covering: Ctrl+/, "?", Ctrl+F, Ctrl+,.
 *
 * Extracted for SRP under Task #724.
 */
export function useShortcutHandlers(deps: ShortcutHandlersDeps): void {
  const { toggleShortcuts, togglePalette, openSettings } = deps;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === '/' && !e.shiftKey) {
        e.preventDefault();
        toggleShortcuts();
        return;
      }
      if (!mod) {
        if (e.key === '?' && !isEditableTarget(e.target)) {
          e.preventDefault();
          toggleShortcuts();
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'f' && !e.shiftKey) {
        e.preventDefault();
        togglePalette();
      } else if (e.key === ',') {
        e.preventDefault();
        openSettings();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleShortcuts, togglePalette, openSettings]);
}
