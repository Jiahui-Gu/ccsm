import React, { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { useStore } from '../../stores/store';
import { useTranslation } from '../../i18n/useTranslation';
import { usePreferences } from '../../store/preferences';
import { Field } from './Field';
import { Segmented } from './Segmented';

export function AppearancePane() {
  const theme = useStore((s) => s.theme);
  const fontSizePx = useStore((s) => s.fontSizePx);
  const setTheme = useStore((s) => s.setTheme);
  const setFontSizePx = useStore((s) => s.setFontSizePx);
  const language = usePreferences((s) => s.language);
  const setLanguage = usePreferences((s) => s.setLanguage);
  const { t } = useTranslation('settings');

  const sizeStops: Array<12 | 13 | 14 | 15 | 16> = [12, 13, 14, 15, 16];

  return (
    <>
      <Field label={t('language')} hint={t('languageHint')}>
        <Segmented
          value={language}
          onChange={setLanguage}
          options={[
            { value: 'system', label: t('languageOptions.system') },
            { value: 'en', label: t('languageOptions.en') },
            { value: 'zh', label: t('languageOptions.zh') }
          ]}
        />
      </Field>
      <Field label={t('theme')} hint={t('themeHint')}>
        <Segmented
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'dark', label: t('themeOptions.dark') },
            { value: 'light', label: t('themeOptions.light') },
            { value: 'system', label: t('themeOptions.system') },
          ]}
        />
      </Field>
      <Field label={t('fontSize')} hint={t('fontSizeHint')}>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={12}
            max={16}
            step={1}
            value={fontSizePx}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              if (sizeStops.includes(v as 12 | 13 | 14 | 15 | 16)) {
                setFontSizePx(v as 12 | 13 | 14 | 15 | 16);
              }
            }}
            className="w-48 accent-accent cursor-pointer"
            aria-label={t('fontSizeAriaLabel')}
          />
          <span className="text-meta font-mono text-fg-secondary tabular-nums w-10">{fontSizePx}px</span>
        </div>
      </Field>
      <CloseBehaviorField />
    </>
  );
}

// Close-button behaviour preference. Persisted via the existing `db:save` /
// `db:load` IPC under the `closeAction` app_state key — main reads the same
// key on every win.on('close') so the choice takes effect without a restart.
// Default is platform-derived inside main (win/linux=ask, mac=tray); the
// renderer mirrors that fallback so the segmented control reflects the
// current effective value before the user ever picks a row.
type CloseBehavior = 'ask' | 'tray' | 'quit';
function CloseBehaviorField() {
  const { t } = useTranslation('settings');
  const platformDefault: CloseBehavior =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'tray' : 'ask';
  const [value, setValue] = useState<CloseBehavior>(platformDefault);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await window.ccsm?.loadState('closeAction');
        if (cancelled) return;
        if (raw === 'ask' || raw === 'tray' || raw === 'quit') setValue(raw);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onChange = (next: CloseBehavior) => {
    setValue(next);
    void window.ccsm?.saveState('closeAction', next);
  };

  return (
    <Field label={t('closeBehavior')} hint={t('closeBehaviorHint')}>
      <div className={cn(!hydrated && 'opacity-60')} data-close-behavior>
        <Segmented
          value={value}
          onChange={onChange}
          options={[
            { value: 'ask', label: t('closeBehaviorOptions.ask') },
            { value: 'tray', label: t('closeBehaviorOptions.tray') },
            { value: 'quit', label: t('closeBehaviorOptions.quit') }
          ]}
        />
      </div>
    </Field>
  );
}
