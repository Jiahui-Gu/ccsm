// Renderer preferences store. Persists user-tunable bits that the app
// needs to read everywhere — for now just `language`. Persistence uses
// localStorage; the main process will get the resolved language via IPC
// once the IPC surface is wired (see `electron/i18n.ts`).
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LanguagePreference, SupportedLanguage } from '../i18n';
import { resolveLanguage, applyLanguage } from '../i18n';

type PreferencesState = {
  language: LanguagePreference;
  resolvedLanguage: SupportedLanguage;
  setLanguage: (next: LanguagePreference) => void;
  // Called on app boot once we know the system locale (via electron IPC
  // or `navigator.language`). Kept separate from `setLanguage` because
  // it must NOT overwrite the user's explicit choice.
  hydrateSystemLocale: (locale: string | undefined) => void;
};

const STORAGE_KEY = 'agentory:preferences';

function getNavigatorLocale(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return navigator.language;
}

export const usePreferences = create<PreferencesState>()(
  persist(
    (set, get) => ({
      language: 'system',
      resolvedLanguage: resolveLanguage('system', getNavigatorLocale()),
      setLanguage: (next) => {
        const resolved = resolveLanguage(next, getNavigatorLocale());
        applyLanguage(resolved);
        set({ language: next, resolvedLanguage: resolved });
      },
      hydrateSystemLocale: (locale) => {
        const { language } = get();
        const resolved = resolveLanguage(language, locale);
        applyLanguage(resolved);
        set({ resolvedLanguage: resolved });
      }
    }),
    {
      name: STORAGE_KEY,
      partialize: (s) => ({ language: s.language })
    }
  )
);
