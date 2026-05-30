import { SCROLLBACK_LINES_DEFAULT, TERMINAL_FONT_SIZE_DEFAULT } from '../stores/slices/types';
import { warn } from '../shared/log';

// Appearance defaults (scrollback cap + terminal font size) are owned by
// the store, but a static `import { useStore }` here would close a module
// cycle: store.ts → sessionCrudSlice → terminal/shellRegistry → store.ts
// (DEBT #6). Instead the store registers a lazy provider at boot via
// `setShellAppearanceProvider`. Until that runs (tests / non-renderer
// contexts) we fall back to the compile-time defaults from `slices/types`,
// which is the same value the store's appearance slice initialises with.
export type ShellAppearance = {
  scrollbackLines: number;
  terminalFontSizePx: number;
};

let appearanceProvider: (() => ShellAppearance) | null = null;

/**
 * Register the live appearance source. Called once by `stores/store.ts`
 * after the store is created so `createShell` can read the user's current
 * scrollback / font-size without importing the store (which would form a
 * cycle). Idempotent re-registration is allowed (last writer wins).
 */
export function setShellAppearanceProvider(provider: () => ShellAppearance): void {
  appearanceProvider = provider;
}

export function readAppearance(): ShellAppearance {
  if (appearanceProvider) {
    try {
      return appearanceProvider();
    } catch (e) {
      warn('shell', 'appearance provider threw — using defaults', e);
    }
  }
  return {
    scrollbackLines: SCROLLBACK_LINES_DEFAULT,
    terminalFontSizePx: TERMINAL_FONT_SIZE_DEFAULT,
  };
}
