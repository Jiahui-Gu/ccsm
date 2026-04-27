// Permission-mode VALUES are CLI argv (default / acceptEdits / plan /
// bypassPermissions). They MUST stay in English regardless of UI
// language — anything else breaks the spawn args we hand to claude.exe.
//
// This test pins the contract: the human-readable label can change
// per-language, but the canonical English term still appears verbatim
// in the catalog so any code that needs the CLI name can find it.
import { describe, it, expect } from 'vitest';
import en from '../src/i18n/locales/en';
import zh from '../src/i18n/locales/zh';

const PERMISSION_MODE_VALUES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const;

describe('permission mode values', () => {
  it('en catalog exposes every official mode key', () => {
    for (const key of PERMISSION_MODE_VALUES) {
      expect(en.permissions.modes).toHaveProperty(key);
    }
  });

  it('zh catalog exposes the same mode keys (only labels differ)', () => {
    for (const key of PERMISSION_MODE_VALUES) {
      expect(zh.permissions.modes).toHaveProperty(key);
    }
  });

  it('the keys themselves remain the English CLI argv strings', () => {
    // The CLI argv mapping uses the OBJECT KEY, never the displayed
    // value. Sanity check that keys match the canonical names exactly.
    const enKeys = Object.keys(en.permissions.modes).sort();
    expect(enKeys).toEqual([...PERMISSION_MODE_VALUES].sort());
  });
});
