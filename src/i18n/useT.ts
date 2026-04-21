import { useStore } from '../stores/store';
import { detectSystemLocale, translate, type Locale } from './index';

// Resolve the active locale from the user setting (which can be the literal
// 'system' to defer to the OS). Reads through the store so language changes
// re-render every consumer.
export function useLocale(): Locale {
  const setting = useStore((s) => s.localeSetting);
  if (setting === 'system') return detectSystemLocale();
  return setting;
}

export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const locale = useLocale();
  return (key, vars) => translate(locale, key, vars);
}
