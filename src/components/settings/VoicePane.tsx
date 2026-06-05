import React, { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/Button';
import { useTranslation } from '../../i18n/useTranslation';
import type { VoiceTier, VoiceLanguage, VoiceModelStatus } from '../../global';

// Mirrors electron/voice/modelTiers.ts (renderer can't import from electron/).
const VOICE_TIERS: readonly VoiceTier[] = [
  'tiny',
  'base',
  'small',
  'medium',
  'large-v3',
  'large-v3-turbo'
];

const HEAVY_TIERS: ReadonlySet<VoiceTier> = new Set(['medium', 'large-v3', 'large-v3-turbo']);

// Display-only sizes (HEAD-measured 2026-06-03). See modelTiers.ts — these
// are for the "~X MB" hint, never a validation gate.
const TIER_SIZE_BYTES: Record<VoiceTier, number> = {
  tiny: 77691713,
  base: 147951465,
  small: 487601967,
  medium: 1533763059,
  'large-v3': 3095033483,
  'large-v3-turbo': 1624555275
};

const ACCURACY_KEY: Record<VoiceTier, string> = {
  tiny: 'voice.accuracyTiny',
  base: 'voice.accuracyBase',
  small: 'voice.accuracySmall',
  medium: 'voice.accuracyMedium',
  'large-v3': 'voice.accuracyLargeV3',
  'large-v3-turbo': 'voice.accuracyLargeV3Turbo'
};

// Mirrors electron/voice/voiceLanguages.ts. Kept tight (auto + the two UI
// languages) — the point is the Chinese-vs-English misfire, not a full picker.
const VOICE_LANGUAGES: readonly VoiceLanguage[] = ['auto', 'zh', 'en'];

const LANGUAGE_LABEL_KEY: Record<VoiceLanguage, string> = {
  auto: 'voice.languageAuto',
  zh: 'voice.languageZh',
  en: 'voice.languageEn'
};

// Mirror electron defaultVoiceLanguage(): Chinese UI ⇒ 'zh' (the locale most
// hurt by auto-detect misfiring to English), otherwise 'auto'.
function defaultVoiceLanguage(uiLanguage: string | undefined): VoiceLanguage {
  return (uiLanguage ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'auto';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function VoicePane() {
  const { t, i18n } = useTranslation('settings');
  const [selected, setSelected] = useState<VoiceTier | null>(null);
  const [language, setLanguage] = useState<VoiceLanguage | null>(null);
  const [downloaded, setDownloaded] = useState<Record<VoiceTier, boolean>>(
    () => Object.fromEntries(VOICE_TIERS.map((tier) => [tier, false])) as Record<VoiceTier, boolean>
  );
  const [statuses, setStatuses] = useState<Partial<Record<VoiceTier, VoiceModelStatus>>>({});

  useEffect(() => {
    void window.ccsm?.loadState('voiceTier').then((raw) => {
      setSelected((raw as VoiceTier | null) ?? 'base');
    });
    void window.ccsm?.loadState('voiceLanguage').then((raw) => {
      const stored = raw as VoiceLanguage | null;
      setLanguage(
        stored && VOICE_LANGUAGES.includes(stored)
          ? stored
          : defaultVoiceLanguage(i18n.language)
      );
    });
    for (const tier of VOICE_TIERS) {
      void window.ccsmVoice?.isModelDownloaded(tier).then((ok) => {
        setDownloaded((prev) => ({ ...prev, [tier]: ok }));
      });
    }
    const off = window.ccsmVoice?.onModelStatus((status) => {
      setStatuses((prev) => ({ ...prev, [status.tier]: status }));
      if (status.kind === 'ready') {
        setDownloaded((prev) => ({ ...prev, [status.tier]: true }));
      }
    });
    return () => off?.();
  }, [i18n.language]);

  function onUse(tier: VoiceTier) {
    setSelected(tier);
    void window.ccsm?.saveState('voiceTier', tier);
  }

  function onPickLanguage(lang: VoiceLanguage) {
    setLanguage(lang);
    void window.ccsm?.saveState('voiceLanguage', lang);
  }

  function onDownload(tier: VoiceTier) {
    void window.ccsmVoice?.downloadModel(tier);
  }

  function onCancel(tier: VoiceTier) {
    void window.ccsmVoice?.cancelDownload(tier);
  }

  return (
    <div data-voice-pane>
      <div className="text-meta text-fg-tertiary mb-4 max-w-[520px]">{t('voice.intro')}</div>
      <div role="radiogroup" aria-label={t('voice.tierLabel')} className="flex flex-col gap-2">
        {VOICE_TIERS.map((tier) => {
          const status = statuses[tier];
          const isDownloading = status?.kind === 'downloading';
          const isError = status?.kind === 'error';
          const isDownloaded = downloaded[tier];
          const isSelected = selected === tier;
          const isHeavy = HEAVY_TIERS.has(tier);

          return (
            <div
              key={tier}
              role="radio"
              aria-checked={isSelected}
              tabIndex={0}
              onClick={() => isDownloaded && onUse(tier)}
              onKeyDown={(e) => {
                if ((e.key === ' ' || e.key === 'Enter') && isDownloaded) {
                  e.preventDefault();
                  onUse(tier);
                }
              }}
              className={cn(
                'rounded-md border p-3 outline-none focus-ring transition-colors',
                isSelected ? 'border-accent bg-bg-hover' : 'border-border-default',
                isDownloaded ? 'cursor-pointer hover:bg-bg-hover' : 'cursor-default'
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-chrome font-medium text-fg-primary font-mono">{tier}</span>
                <span className="text-meta text-fg-tertiary">{formatBytes(TIER_SIZE_BYTES[tier])}</span>
                {isSelected && (
                  <span className="inline-flex items-center gap-1 text-meta text-accent">
                    <Check size={11} strokeWidth={3} />
                    {t('voice.selected')}
                  </span>
                )}
                {!isSelected && isDownloaded && (
                  <span className="text-meta text-fg-secondary">{t('voice.installed')}</span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  {isDownloading ? (
                    <>
                      <span className="text-meta text-fg-secondary font-mono">
                        {t('voice.downloading', {
                          transferred: formatBytes(status.transferred),
                          total: status.total != null ? ` / ${formatBytes(status.total)}` : ''
                        })}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => onCancel(tier)}>
                        {t('voice.cancelButton')}
                      </Button>
                    </>
                  ) : isDownloaded ? (
                    !isSelected && (
                      <Button variant="secondary" size="sm" onClick={() => onUse(tier)}>
                        {t('voice.useButton')}
                      </Button>
                    )
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => onDownload(tier)}>
                      {t('voice.downloadButton')}
                    </Button>
                  )}
                </span>
              </div>
              <div className="text-meta text-fg-tertiary mt-1">{t(ACCURACY_KEY[tier])}</div>
              {isHeavy && (
                <div className="text-meta text-state-warning-fg mt-1">{t('voice.heavyWarning')}</div>
              )}
              {isError && (
                <div className="text-meta text-state-error-fg mt-1">
                  {t('voice.downloadError', { message: status.message })}
                </div>
              )}
              {isDownloading && (
                <div className="mt-2 h-1 rounded-full bg-bg-elevated overflow-hidden">
                  <div
                    className="h-full bg-accent transition-[width] duration-200"
                    style={{
                      width:
                        status.total != null && status.total > 0
                          ? `${Math.min(100, (status.transferred / status.total) * 100)}%`
                          : '100%'
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6" data-voice-language>
        <div className="text-chrome font-medium text-fg-primary mb-1">
          {t('voice.languageLabel')}
        </div>
        <div className="text-meta text-fg-tertiary mb-2 max-w-[520px]">{t('voice.languageHint')}</div>
        <div
          role="radiogroup"
          aria-label={t('voice.languageLabel')}
          className="flex flex-wrap gap-2"
        >
          {VOICE_LANGUAGES.map((lang) => {
            const isActive = language === lang;
            return (
              <button
                key={lang}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => onPickLanguage(lang)}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-chrome outline-none focus-ring transition-colors',
                  isActive
                    ? 'border-accent bg-bg-hover text-fg-primary'
                    : 'border-border-default text-fg-secondary hover:bg-bg-hover'
                )}
              >
                {t(LANGUAGE_LABEL_KEY[lang])}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
