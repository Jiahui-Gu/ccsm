// Audit gap fill (PR #568, shortcut-overlay-opens a5 + a8): the original e2e
// probe spoofed `navigator.platform` via an Electron init script and asserted
// that the overlay rendered ⌘ glyphs on macOS while non-mac kept Ctrl. The
// ported tests/shortcut-overlay.test.tsx only exercises the default jsdom
// userAgent (non-mac); a5 (mac branch) and a8 (CommandPalette per-row hint
// uses platform-correct modifier) had nowhere to land.
//
// Both modules read the platform at module-evaluation time:
//   - ShortcutOverlay.tsx: `IS_MAC = /Mac|iPhone|iPad/i.test(navigator.userAgent)`
//   - CommandPalette.tsx:  `MOD = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'`
// So we have to spoof BOTH `userAgent` and `platform`, then `vi.resetModules()`
// + dynamic import to re-trigger the module-eval branch under each platform.
//
// Two cases per module: macOS (⌘) vs non-mac (Ctrl).
import React, { useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, act, fireEvent } from '@testing-library/react';
import { useStore } from '../src/stores/store';

// Re-import a module under a spoofed navigator. The `loader` callback is
// invoked AFTER navigator is stubbed and modules are reset, so the module's
// top-level `const IS_MAC = ...` runs against the spoofed value.
async function withNavigator<T>(
  navInit: { userAgent: string; platform: string },
  loader: () => Promise<T>
): Promise<T> {
  const realNavigator = globalThis.navigator;
  // jsdom's navigator is a Proxy; we replace it wholesale for the duration of
  // the load so any module that reads userAgent OR platform sees the spoof.
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...realNavigator, userAgent: navInit.userAgent, platform: navInit.platform },
    configurable: true,
    writable: true,
  });
  vi.resetModules();
  try {
    return await loader();
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: realNavigator,
      configurable: true,
      writable: true,
    });
    vi.resetModules();
  }
}

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// jsdom doesn't ship matchMedia. CommandPalette subscribes to
// `(prefers-color-scheme: dark)` for the "Switch theme → X" label.
function stubMatchMedia(): void {
  if (typeof window === 'undefined' || window.matchMedia) return;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const initial = useStore.getState();

function seedSessions(sessions: Array<{ id: string; name: string }>) {
  useStore.setState(
    {
      ...initial,
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        state: 'idle',
        cwd: '~',
        model: 'claude-opus-4',
        groupId: 'g-default',
        agentType: 'claude-code',
      })),
      activeId: sessions[0]?.id ?? '',
      hydrated: true,
    } as ReturnType<typeof useStore.getState>,
    true
  );
}

beforeEach(() => {
  cleanup();
  stubMatchMedia();
});
afterEach(() => cleanup());

describe('ShortcutOverlay platform-correct modifier (a5)', () => {
  it('renders ⌘ glyphs when navigator.userAgent is macOS', async () => {
    await withNavigator({ userAgent: MAC_UA, platform: 'MacIntel' }, async () => {
      const mod = await import('../src/components/ShortcutOverlay');
      function Harness() {
        const [open, setOpen] = useState(true);
        return <mod.ShortcutOverlay open={open} onOpenChange={setOpen} />;
      }
      render(<Harness />);
      const dialog = screen.getByRole('dialog');
      const text = dialog.textContent || '';
      // ⌘ glyph present, Ctrl chip absent.
      expect(text).toMatch(/⌘/);
      const kbds = within(dialog).getAllByText((_, el) => el?.tagName.toLowerCase() === 'kbd');
      const labels = kbds.map((el) => el.textContent || '');
      expect(labels.some((l) => l.includes('⌘'))).toBe(true);
      expect(labels).not.toContain('Ctrl');
    });
  });

  it('renders Ctrl chips when navigator.userAgent is Windows (control)', async () => {
    await withNavigator({ userAgent: WIN_UA, platform: 'Win32' }, async () => {
      const mod = await import('../src/components/ShortcutOverlay');
      function Harness() {
        const [open, setOpen] = useState(true);
        return <mod.ShortcutOverlay open={open} onOpenChange={setOpen} />;
      }
      render(<Harness />);
      const dialog = screen.getByRole('dialog');
      const text = dialog.textContent || '';
      expect(text).not.toMatch(/⌘/);
      const kbds = within(dialog).getAllByText((_, el) => el?.tagName.toLowerCase() === 'kbd');
      const labels = kbds.map((el) => el.textContent || '');
      expect(labels).toContain('Ctrl');
    });
  });
});

describe('CommandPalette per-row hint platform-correct modifier (a8)', () => {
  it('per-row hints render ⌘ on macOS', async () => {
    seedSessions([{ id: 's-mac', name: 'mac-target' }]);
    await withNavigator({ userAgent: MAC_UA, platform: 'MacIntel' }, async () => {
      const mod = await import('../src/components/CommandPalette');
      function Harness() {
        const [open, setOpen] = useState(true);
        return <mod.CommandPalette open={open} onOpenChange={setOpen} />;
      }
      await act(async () => {
        render(<Harness />);
      });
      const dialog = screen.getByRole('dialog');
      // CommandPalette only renders the built-in command rows (which carry
      // the per-row modifier hints) once the user types — empty input keeps
      // the placeholder hint instead. Type a needle that matches several
      // commands ("new" → New session + New group, both with ⌘N hints).
      const input = within(dialog).getByPlaceholderText(/Search/i) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { value: 'new' } });
      });
      const text = dialog.textContent || '';
      expect(text).toMatch(/⌘/);
      expect(text).not.toMatch(/Ctrl\+/);
    });
  });

  it('per-row hints render Ctrl+ on non-mac (control)', async () => {
    seedSessions([{ id: 's-win', name: 'win-target' }]);
    await withNavigator({ userAgent: WIN_UA, platform: 'Win32' }, async () => {
      const mod = await import('../src/components/CommandPalette');
      function Harness() {
        const [open, setOpen] = useState(true);
        return <mod.CommandPalette open={open} onOpenChange={setOpen} />;
      }
      await act(async () => {
        render(<Harness />);
      });
      const dialog = screen.getByRole('dialog');
      const input = within(dialog).getByPlaceholderText(/Search/i) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(input, { target: { value: 'new' } });
      });
      const text = dialog.textContent || '';
      expect(text).toMatch(/Ctrl\+/);
      expect(text).not.toMatch(/⌘/);
    });
  });
});
