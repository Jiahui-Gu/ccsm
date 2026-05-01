// Regression: PR #601 (commit 15f86dd) — `fix(ui): remove false Ctrl+N
// shortcut hints`.
//
// Bug: ShortcutOverlay row + CommandPalette command-list hint advertised
// `Ctrl+N` for "New session" even though no Ctrl+N key handler exists in
// App.tsx (only Ctrl+Shift+N is bound, for "New group"). Per user
// 2026-04-30: ccsm intentionally won't add the shortcut, so the hints
// have to stay gone. A future PR re-adding "Ctrl+N" / "⌘+N" labels (e.g.
// during another shortcut sweep) would silently mislead users into
// pressing a no-op key.
//
// Existing coverage gap: `tests/shortcut-overlay.test.tsx` asserts
// >=6 kbd chips and that `Ctrl` appears at least once, but does NOT
// assert that the standalone `Ctrl+N` (or `⌘+N`) combo is absent. The
// CommandPalette's hint chip column is not tested at all for this.
//
// This file pins both surfaces so a regression in either fails loudly.
import React, { useState } from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { ShortcutOverlay } from '../../src/components/ShortcutOverlay';
import { CommandPalette } from '../../src/components/CommandPalette';
import { useStore } from '../../src/stores/store';

// Pattern matches `Ctrl+N` / `Ctrl + N` / `⌘+N` / `⌘ + N` etc., but does
// NOT match the legitimate `Ctrl+Shift+N` / `⌘+Shift+N`. The textContent
// concatenates row labels with no separator (e.g. "Ctrl+Shift+NNew
// group"), so we use a negative-lookbehind for "Shift+" before the
// modifier — and we don't anchor with \b after N because the next
// character is often the start of an action label like "New group".
const FALSE_NEW_SESSION_PATTERN = /(?<!Shift\+)(?:Ctrl|⌘)\s*\+\s*N(?![a-z])/;

afterEach(() => cleanup());

function ShortcutHarness() {
  const [open, setOpen] = useState(true);
  return <ShortcutOverlay open={open} onOpenChange={setOpen} />;
}

describe('PR #601 regression — no false Ctrl+N hint', () => {
  describe('ShortcutOverlay', () => {
    it('does not render a standalone Ctrl+N (or ⌘+N) row for "New session"', () => {
      render(<ShortcutHarness />);
      const dialog = screen.getByRole('dialog');
      const text = dialog.textContent || '';
      // Safety: legitimate Ctrl+Shift+N (New group) should still render
      // — that proves the dialog actually mounted with shortcut rows and
      // the negative assertion below isn't vacuous. The textContent has
      // no whitespace between kbd chips, so the modifier+Shift+N pair
      // appears as the literal "Ctrl+Shift+N" / "⌘+Shift+N". We don't
      // anchor with \b after N because the next char is usually the
      // start of an action label like "New group" (no boundary).
      expect(text).toMatch(/(?:Ctrl|⌘)\+Shift\+N(?![a-z])/);
      // Real check: the bare "Ctrl+N" / "⌘+N" combo must be gone.
      expect(text).not.toMatch(FALSE_NEW_SESSION_PATTERN);

      // Also pin the kbd chip granularity: NO row's kbd-chip group spells
      // out exactly the modifier+N pair (without Shift). The PR removed
      // a row that rendered 2 kbds: `Ctrl` and `N`.
      const rows = within(dialog).getAllByRole('row');
      for (const row of rows) {
        const kbds = within(row)
          .queryAllByText((_, el) => el?.tagName.toLowerCase() === 'kbd')
          .map((el) => (el.textContent || '').trim());
        // A "false Ctrl+N" row would contain exactly [Ctrl/⌘, N] with no
        // intermediate Shift kbd. Reject that exact shape.
        const isModN =
          kbds.length === 2 &&
          /^(Ctrl|⌘)$/.test(kbds[0]) &&
          /^N$/.test(kbds[1]);
        expect(isModN).toBe(false);
      }
    });
  });

  describe('CommandPalette', () => {
    beforeEach(() => {
      // CommandPalette reads sessions/groups/theme from the store. Seed an
      // empty-ish state so the only commands present are the static ones
      // (cmdNewGroup / cmdImport / cmdOpenSettings / cmdSwitchTheme).
      useStore.setState({
        sessions: [],
        groups: [],
        flashStates: {},
        disconnectedSessions: {},
      });
      // jsdom lacks matchMedia which CommandPalette uses for theme.
      if (!(window as { matchMedia?: unknown }).matchMedia) {
        Object.defineProperty(window, 'matchMedia', {
          writable: true,
          value: vi.fn().mockImplementation(() => ({
            matches: false,
            media: '(prefers-color-scheme: dark)',
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(),
          })),
        });
      }
    });

    it('does not surface a Ctrl+N / ⌘+N hint chip on any command row', () => {
      render(<CommandPalette open onOpenChange={() => {}} />);
      const dialog = screen.getByRole('dialog');
      // Type into the search box so commands surface as result rows
      // (CommandPalette only renders results when a query is non-empty).
      const search = within(dialog).getByPlaceholderText(/search/i) as HTMLInputElement;
      fireEvent.change(search, { target: { value: 'new' } });

      const text = dialog.textContent || '';
      // Sanity: at least the "new group" command surfaces with its
      // legitimate Ctrl+Shift+N / ⌘+Shift+N hint.
      expect(text).toMatch(/(?:Ctrl|⌘)\s*\+?\s*Shift\s*\+\s*N\b/);
      // Real check: no row offers a bare modifier+N hint.
      expect(text).not.toMatch(FALSE_NEW_SESSION_PATTERN);
    });
  });
});
