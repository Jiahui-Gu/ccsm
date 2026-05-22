import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useShortcutHandlers } from '../../src/app-effects/useShortcutHandlers';

function dispatchKey(init: KeyboardEventInit & { target?: EventTarget }): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.target) {
    Object.defineProperty(ev, 'target', { value: init.target });
  }
  window.dispatchEvent(ev);
  return ev;
}

describe('useShortcutHandlers', () => {
  let toggleShortcuts: ReturnType<typeof vi.fn>;
  let togglePalette: ReturnType<typeof vi.fn>;
  let openSettings: ReturnType<typeof vi.fn>;
  let createNewGroup: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    toggleShortcuts = vi.fn();
    togglePalette = vi.fn();
    openSettings = vi.fn();
    createNewGroup = vi.fn();
  });

  function mount() {
    return renderHook(() =>
      useShortcutHandlers({
        toggleShortcuts,
        togglePalette,
        openSettings,
        createNewGroup,
      })
    );
  }

  it('Ctrl+/ toggles the shortcut overlay', () => {
    mount();
    dispatchKey({ key: '/', ctrlKey: true });
    expect(toggleShortcuts).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+F toggles the palette', () => {
    mount();
    dispatchKey({ key: 'f', ctrlKey: true });
    expect(togglePalette).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+B is NOT bound (sidebar collapse removed in #894)', () => {
    mount();
    dispatchKey({ key: 'b', ctrlKey: true });
    expect(togglePalette).not.toHaveBeenCalled();
    expect(toggleShortcuts).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
    expect(createNewGroup).not.toHaveBeenCalled();
  });

  it('Ctrl+, opens settings', () => {
    mount();
    dispatchKey({ key: ',', ctrlKey: true });
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('"?" toggles the overlay only when target is not editable', () => {
    mount();
    dispatchKey({ key: '?' });
    expect(toggleShortcuts).toHaveBeenCalledTimes(1);

    const input = document.createElement('input');
    document.body.appendChild(input);
    dispatchKey({ key: '?', target: input });
    expect(toggleShortcuts).toHaveBeenCalledTimes(1);
    document.body.removeChild(input);
  });

  // Audit gap (PR #568, search-shortcut-f a3): negative assertion guarding the
  // palette binding. Ctrl+K is a common rebind candidate (matches Slack /
  // VSCode quick-switcher), so explicitly assert it does NOT route through
  // any of our handlers. If somebody rebinds Ctrl+K → palette without
  // updating the rest of the shortcut surface, this catches it.
  it('Ctrl+K is NOT bound to any handler (search-shortcut-f a3)', () => {
    mount();
    dispatchKey({ key: 'k', ctrlKey: true });
    dispatchKey({ key: 'K', ctrlKey: true });
    dispatchKey({ key: 'k', metaKey: true });
    expect(togglePalette).not.toHaveBeenCalled();
    expect(toggleShortcuts).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
    expect(createNewGroup).not.toHaveBeenCalled();
  });

  // ShortcutOverlay + CommandPalette advertise Ctrl+Shift+N for "New
  // group"; the chord was previously unbound (silent no-op when the user
  // followed the in-app hint). These cases lock the wiring in.
  it('Ctrl+Shift+N creates a new group', () => {
    mount();
    dispatchKey({ key: 'N', ctrlKey: true, shiftKey: true });
    expect(createNewGroup).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Shift+N creates a new group (macOS modifier)', () => {
    mount();
    dispatchKey({ key: 'N', metaKey: true, shiftKey: true });
    expect(createNewGroup).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+N (without Shift) is NOT bound to createNewGroup', () => {
    mount();
    dispatchKey({ key: 'n', ctrlKey: true });
    dispatchKey({ key: 'N', ctrlKey: true });
    expect(createNewGroup).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+N is suppressed when an editable target has focus', () => {
    mount();
    const input = document.createElement('input');
    document.body.appendChild(input);
    dispatchKey({ key: 'N', ctrlKey: true, shiftKey: true, target: input });
    expect(createNewGroup).not.toHaveBeenCalled();
    document.body.removeChild(input);

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    dispatchKey({ key: 'N', ctrlKey: true, shiftKey: true, target: textarea });
    expect(createNewGroup).not.toHaveBeenCalled();
    document.body.removeChild(textarea);

    // Note: contenteditable surfaces are also gated via `isContentEditable`
    // in the editable check; not asserted here because jsdom doesn't
    // propagate the `contentEditable` attribute to that getter reliably.
  });

  it('removes the keydown listener on unmount', () => {
    const { unmount } = mount();
    unmount();
    dispatchKey({ key: '/', ctrlKey: true });
    dispatchKey({ key: 'f', ctrlKey: true });
    expect(toggleShortcuts).not.toHaveBeenCalled();
    expect(togglePalette).not.toHaveBeenCalled();
  });
});
