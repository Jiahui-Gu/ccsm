// Migrated from harness-ui cases `i18n-settings-zh` + `language-toggle`
// (Task #740 Batch 3.1).
//
// Coverage:
//   - i18n-settings-zh: opening Settings, switching to zh via the
//     Appearance pane Language segmented control, and confirming
//     Appearance / Updates panes all render Chinese labels (and no
//     longer English ones).
//   - language-toggle: en→zh→en flip, plus the protected-term parity
//     scan (English proper nouns like "MCP", "Claude", "GitHub" must
//     survive translation into the zh catalog).
//
// The harness probe also asserted live language flip in the sidebar
// settings button label and the input placeholder. That UI live-flip
// path is already covered by `tests/language-switch.test.tsx`
// (rerender on usePreferences.setLanguage). This file covers the
// Settings-dialog-specific assertions the harness owned.
//
// Reverse-verify (manual):
//   - Drop "MCP" from the zh.ts catalog (replace with a translated
//     phrase that omits "MCP") → protected-term parity test fails.
//   - Force AppearancePane to ignore the Language segmented choice →
//     `switching to 中文 flips Appearance / Updates panes into Chinese`
//     fails.
import React, { useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act, waitFor } from '@testing-library/react';
import { SettingsDialog } from '../src/components/SettingsDialog';
import { usePreferences } from '../src/store/preferences';
import { initI18n } from '../src/i18n';
import en from '../src/i18n/locales/en';
import zh from '../src/i18n/locales/zh';

// Settings panes mount a few pieces that hit window.ccsm. Provide a tiny
// shim so they don't blow up under jsdom.
function stubCcsm() {
  const api = {
    getVersion: vi.fn(async () => '0.0.0-test'),
    updatesStatus: vi.fn(async () => ({ kind: 'idle' as const })),
    updatesGetAutoCheck: vi.fn(async () => true),
    updatesSetAutoCheck: vi.fn(async (v: boolean) => v),
    updatesCheck: vi.fn(async () => {}),
    updatesDownload: vi.fn(async () => {}),
    updatesInstall: vi.fn(async () => {}),
    onUpdateStatus: () => () => {},
    loadState: vi.fn(async () => undefined),
    saveState: vi.fn(async () => {}),
    settingsLoad: vi.fn(async () => ({})),
    settingsOpenInEditor: vi.fn(async () => {}),
    modelsList: vi.fn(async () => []),
  };
  (window as { ccsm?: unknown }).ccsm = api;
  return api;
}

function stubMatchMedia() {
  if (window.matchMedia) return;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function Harness() {
  const [open, setOpen] = useState(true);
  return <SettingsDialog open={open} onOpenChange={setOpen} initialTab="appearance" />;
}

beforeEach(() => {
  cleanup();
  stubCcsm();
  stubMatchMedia();
  // Force a clean English baseline.
  act(() => usePreferences.getState().setLanguage('en'));
  initI18n('en');
});

afterEach(() => {
  delete (window as { ccsm?: unknown }).ccsm;
  act(() => usePreferences.getState().setLanguage('en'));
});

describe('Settings i18n (en → zh → en)', () => {
  it('switching to 中文 flips Appearance / Updates panes into Chinese', async () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog');

    // Pick the Chinese language radio inside the Appearance pane.
    const zhRadio = within(dialog).getByRole('radio', { name: /^中文$/ });
    fireEvent.click(zhRadio);

    // After flip: appearance pane labels are zh.
    await waitFor(() => {
      const text = dialog.textContent || '';
      expect(text).toMatch(/主题/);
      expect(text).toMatch(/字号/);
      expect(text).not.toMatch(/\bTheme\b/);
    });

    // Updates tab.
    fireEvent.click(within(dialog).getByRole('tab', { name: /^更新$/ }));
    await waitFor(() => {
      const txt = dialog.textContent || '';
      expect(txt).toMatch(/版本/);
      expect(txt).toMatch(/检查更新/);
      expect(txt).toMatch(/自动检查/);
      expect(txt).not.toMatch(/Check for updates/);
      expect(txt).not.toMatch(/Automatic checks/);
    });
  });

  it('en → zh → en round-trip keeps Settings strings consistent', async () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog');

    // English baseline assertions.
    expect(within(dialog).getByText(/^Theme$/)).toBeInTheDocument();

    // Flip to zh.
    fireEvent.click(within(dialog).getByRole('radio', { name: /^中文$/ }));
    await waitFor(() => {
      expect(within(dialog).getByText(/^主题$/)).toBeInTheDocument();
    });

    // Flip back to English via the segmented control's English option.
    fireEvent.click(within(dialog).getByRole('radio', { name: /^English$/ }));
    await waitFor(() => {
      expect(within(dialog).getByText(/^Theme$/)).toBeInTheDocument();
    });
  });
});

describe('i18n protected-term parity (en ↔ zh)', () => {
  // English proper nouns / acronyms that MUST survive the zh translation.
  const PROTECTED_TERMS = [
    'MCP',
    'CLI',
    'IPC',
    'API',
    'URL',
    'JSONL',
    'JSON',
    'SDK',
    'REST',
    'Claude',
    'Anthropic',
    'CCSM',
    'Electron',
    'GitHub',
  ];

  it('every zh string keeps the same English proper noun appearing in its en counterpart', () => {
    type Catalog = Record<string, unknown>;
    const violations: Array<{ key: string; term: string; en: string; zh: string }> = [];
    function walk(enNode: unknown, zhNode: unknown, prefix: string) {
      if (typeof enNode === 'string') {
        if (typeof zhNode !== 'string') return;
        for (const term of PROTECTED_TERMS) {
          const re = new RegExp(`\\b${term}\\b`);
          if (re.test(enNode)) {
            if (!new RegExp(`\\b${term}\\b`).test(zhNode)) {
              violations.push({ key: prefix, term, en: enNode, zh: zhNode });
            }
          }
        }
        return;
      }
      if (enNode && typeof enNode === 'object') {
        for (const k of Object.keys(enNode as Catalog)) {
          walk(
            (enNode as Catalog)[k],
            zhNode ? (zhNode as Catalog)[k] : undefined,
            prefix ? `${prefix}.${k}` : k
          );
        }
      }
    }
    walk(en as unknown, zh as unknown, '');
    if (violations.length > 0) {
      const sample = violations
        .slice(0, 5)
        .map((v) => `${v.key} [${v.term}] en="${v.en}" zh="${v.zh}"`)
        .join('\n  ');
      throw new Error(
        `${violations.length} zh strings dropped a protected English proper noun:\n  ${sample}`
      );
    }
    expect(violations).toEqual([]);
  });
});
