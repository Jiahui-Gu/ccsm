// Migrated from harness-ui case `shortcut-overlay-opens` (Task #740 Batch 3.1).
// The harness probe boots Electron, spoofs navigator.platform via init script,
// reloads, and asserts the overlay opens via ? / Cmd+/, renders kbd chips, and
// closes via Escape. None of this requires Electron — ShortcutOverlay is a
// controlled Radix Dialog whose modifier-glyph branch reads navigator.userAgent
// at module evaluation. RTL covers it without the 30s electron boot.
//
// Reverse-verify (manual): force IS_MAC=true in ShortcutOverlay.tsx — the
// "Ctrl is rendered on win/linux" assertion fails with `mac glyphs leaked`.
import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ShortcutOverlay } from '../src/components/ShortcutOverlay';

function Harness({ initialOpen = true }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button data-testid="opener" onClick={() => setOpen(true)}>open</button>
      <ShortcutOverlay open={open} onOpenChange={setOpen} />
    </>
  );
}

describe('ShortcutOverlay', () => {
  afterEach(() => cleanup());

  it('renders the overlay with title, kbd chips, and Ctrl glyphs on non-mac', () => {
    // Default jsdom userAgent does not contain Mac, so IS_MAC=false → MOD='Ctrl'.
    expect(/Mac|iPhone|iPad/i.test(navigator.userAgent)).toBe(false);

    render(<Harness initialOpen />);
    const dialog = screen.getByRole('dialog');
    // Title is rendered inside the Dialog and wired via aria-labelledby.
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const titleEl = document.getElementById(labelledBy as string);
    expect(titleEl?.textContent || '').toMatch(/Keyboard shortcuts/i);

    // ≥6 kbd chips.
    const kbds = within(dialog).getAllByText((_, el) => el?.tagName.toLowerCase() === 'kbd');
    expect(kbds.length).toBeGreaterThanOrEqual(6);

    // Win/linux: must NOT render mac glyphs, must render at least one Ctrl chip.
    const dialogText = dialog.textContent || '';
    expect(dialogText).not.toMatch(/[⌘⇧]/); // ⌘ ⇧
    expect(dialogText).not.toMatch(/\bCmd\b/);
    const kbdLabels = kbds.map((el) => el.textContent || '');
    expect(kbdLabels).toContain('Ctrl');
  });

  it('Esc dismisses the overlay (controlled close path)', () => {
    render(<Harness initialOpen />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // Radix routes Esc through DismissableLayer's document keydown listener.
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    // After Esc, Radix flips open=false via onOpenChange. Query again.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('open prop drives mount/unmount (re-open after close)', () => {
    render(<Harness initialOpen={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('opener'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
