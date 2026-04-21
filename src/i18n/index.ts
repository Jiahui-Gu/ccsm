import en from './en';
import zh from './zh';

export type Locale = 'en' | 'zh';
type Loosen<T> = { [K in keyof T]: T[K] extends string ? string : Loosen<T[K]> };
export type Dict = Loosen<typeof en>;

const dicts: Record<Locale, Dict> = { en, zh };

export const SUPPORTED_LOCALES: Locale[] = ['en', 'zh'];

export function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  const lang = (navigator.language || 'en').toLowerCase();
  if (lang.startsWith('zh')) return 'zh';
  return 'en';
}

// Look up a dotted key with positional {x} interpolation. Falls back to en
// when the key is missing in the active locale, then to the key itself when
// it's missing everywhere — so a typo shows visibly in dev rather than
// rendering blank.
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const fromActive = lookup(dicts[locale], key);
  const raw = fromActive ?? lookup(dicts.en, key) ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

function lookup(dict: unknown, key: string): string | null {
  const parts = key.split('.');
  let cur: unknown = dict;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' ? cur : null;
}
