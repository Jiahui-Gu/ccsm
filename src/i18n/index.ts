// i18next initialization for the renderer.
//
// Design notes:
// - Catalogs are statically imported. No backend, no lazy loading. Bundle
//   weight is ~10KB total — not worth a code-split round-trip per the
//   project's YAGNI rules.
// - We register every namespace from `en.ts` so consumers can do
//   `t('chat:sendButton')` without preloading.
// - The store decides the active language; this module exposes
//   `applyLanguage(pref)` so the App-level effect stays trivial.
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en';
import zh from './locales/zh';

export const SUPPORTED_LANGUAGES = ['en', 'zh'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export type LanguagePreference = 'system' | SupportedLanguage;

// Resolve a stored preference + a system locale string into one of the
// supported languages. Used by both the renderer (navigator.language) and
// any code that wants to mirror the same logic deterministically.
export function resolveLanguage(
  pref: LanguagePreference,
  systemLocale: string | undefined
): SupportedLanguage {
  if (pref === 'en' || pref === 'zh') return pref;
  const tag = (systemLocale ?? '').toLowerCase();
  if (tag.startsWith('zh')) return 'zh';
  return 'en';
}

// Build the resources object once. Each catalog is split into namespaces
// so consumers can scope their `useTranslation('chat')` etc.
function buildResources() {
  const namespaces = Object.keys(en) as Array<keyof typeof en>;
  const make = (catalog: typeof en) => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const ns of namespaces) out[ns] = catalog[ns] as unknown as Record<string, unknown>;
    return out;
  };
  return {
    en: make(en),
    zh: make(zh as unknown as typeof en)
  };
}

let initialized = false;

export function initI18n(initialLanguage: SupportedLanguage = 'en') {
  if (initialized) return i18next;
  initialized = true;
  const namespaces = Object.keys(en);
  void i18next.use(initReactI18next).init({
    resources: buildResources(),
    lng: initialLanguage,
    fallbackLng: 'en',
    ns: namespaces,
    defaultNS: 'common',
    interpolation: {
      // React already escapes — double-escaping eats apostrophes etc.
      escapeValue: false
    },
    returnNull: false,
    react: {
      // Components are translated synchronously — no Suspense boundary
      // needed. Keeps the renderer tree cleaner.
      useSuspense: false
    }
  });
  return i18next;
}

export function applyLanguage(lang: SupportedLanguage) {
  if (i18next.language !== lang) void i18next.changeLanguage(lang);
}

export { i18next };
