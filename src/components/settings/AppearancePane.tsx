import React, { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { useStore } from '../../stores/store';
import { useTranslation } from '../../i18n/useTranslation';
import { usePreferences } from '../../store/preferences';
import {
  SCROLLBACK_LINES_DEFAULT,
  SCROLLBACK_LINES_MAX,
  SCROLLBACK_LINES_MIN,
} from '../../stores/slices/types';
import { sanitizeScrollbackLines } from '../../stores/slices/appearanceSlice';
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
      <ScrollbackField />
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

// Terminal scrollback line cap. Single user-facing knob that bounds BOTH
// the visible xterm buffer (next-launch effect — the renderer's xterm
// singleton reads this once at construction) and the headless
// authoritative buffer in main (next-spawn effect — `entryFactory.makeEntry`
// reads from the same `scrollbackLines` row). Persisted via `db:save` to
// match the closeBehavior pattern, NOT via the renderer's PERSISTED_KEYS
// JSON blob, so the main process can read the same value directly.
//
// We mirror the value into zustand on change so the live xterm singleton
// has a synchronous reader; the on-disk row is the source of truth.
function ScrollbackField() {
  const { t } = useTranslation('settings');
  const storeValue = useStore((s) => s.scrollbackLines);
  const setStoreValue = useStore((s) => s.setScrollbackLines);
  // Local "what the user is currently typing" buffer so we don't clobber
  // their keystrokes mid-edit with the sanitized round-trip. Synced to
  // the store value when the input loses focus / user commits.
  const [draft, setDraft] = useState<string>(String(storeValue));

  // If the store value changes from elsewhere (e.g. another window, future
  // multi-window support, or hydrate), reflect it into the input.
  useEffect(() => {
    setDraft(String(storeValue));
  }, [storeValue]);

  const commit = (raw: string): void => {
    const sanitized = sanitizeScrollbackLines(raw);
    setStoreValue(sanitized);
    setDraft(String(sanitized));
    // Persist to the same db row main reads from in
    // electron/prefs/scrollback.ts. Fire-and-forget — the renderer's view
    // (zustand) is already updated synchronously above, so a slow IPC
    // doesn't block the UI. Persist as a string for parity with how
    // closeAction is stored (db column is TEXT).
    void window.ccsm?.saveState('scrollbackLines', String(sanitized));
  };

  return (
    <Field label={t('scrollback')} hint={t('scrollbackHint')}>
      <div className="flex items-center gap-3">
        <input
          type="number"
          min={SCROLLBACK_LINES_MIN}
          max={SCROLLBACK_LINES_MAX}
          step={100}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label={t('scrollbackAriaLabel')}
          className={cn(
            'h-7 w-24 px-2 rounded-sm bg-bg-input text-fg-primary text-chrome',
            'border border-border-subtle focus-ring outline-none tabular-nums'
          )}
        />
        <span className="text-meta text-fg-secondary">
          {t('scrollbackUnit')}
        </span>
        <button
          type="button"
          onClick={() => commit(String(SCROLLBACK_LINES_DEFAULT))}
          className={cn(
            'h-7 px-2 rounded-sm text-meta text-fg-secondary',
            'hover:bg-bg-hover hover:text-fg-primary focus-ring outline-none transition-colors'
          )}
        >
          {t('scrollbackReset', { default: SCROLLBACK_LINES_DEFAULT.toString() })}
        </button>
      </div>
    </Field>
  );
}
