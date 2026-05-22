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
  /**
   * Create a new sidebar group and focus it. Bound to Ctrl+Shift+N.
   * Mirrors Sidebar's "+" button (handleNewGroup) so the keyboard path
   * lands on the same row a click would. Suppressed while a text input,
   * textarea, or contenteditable surface has focus so the chord can't
   * fire mid-typing.
   */
  createNewGroup: () => void;
}

/**
 * Composite hook that installs all global keyboard shortcuts handled at
 * the App level. Combines what was previously a single inline `keydown`
 * listener in App.tsx covering: Ctrl+/, "?", Ctrl+F, Ctrl+,, Ctrl+Shift+N.
 *
 * Extracted for SRP under Task #724.
 */
export function useShortcutHandlers(deps: ShortcutHandlersDeps): void {
  const { toggleShortcuts, togglePalette, openSettings, createNewGroup } = deps;
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
      } else if (k === 'n' && e.shiftKey) {
        // Ctrl/⌘ + Shift + N — create a new sidebar group. Both
        // ShortcutOverlay and CommandPalette advertise this chord; without
        // this branch the hint pointed at a no-op. Editable-target gate
        // mirrors the "?" branch so typing "N" in the InputBar with Shift
        // held (a capital N) can't spawn groups behind the user.
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        createNewGroup();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleShortcuts, togglePalette, openSettings, createNewGroup]);
}
