import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { useStore } from '../../stores/store';
import { useTranslation } from '../../i18n/useTranslation';
import { Field } from './Field';

// Hover-revealed copy affordance for read-only connection values (Base URL,
// model). Mirrors the CodeBlock copy button pattern: opacity-0 by default,
// reveals on group-hover or focus-visible, flips to a Check + "Copied"
// tooltip for ~1.5s after a successful clipboard write.
function CopyValueButton({ value, idleLabel, copiedLabel }: { value: string; idleLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onCopy = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        console.warn('[ConnectionPane] clipboard API unavailable');
        return;
      }
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn('[ConnectionPane] clipboard write failed', err);
    }
  }, [value]);

  const label = copied ? copiedLabel : idleLabel;

  return (
    <Tooltip content={label} side="left">
      <button
        type="button"
        onClick={onCopy}
        aria-label={label}
        data-copied={copied || undefined}
        className={cn(
          'absolute top-1 right-1 inline-grid place-items-center',
          'h-5 w-5 rounded-md border border-transparent',
          'text-fg-tertiary hover:text-fg-primary hover:bg-bg-hover',
          'transition-[opacity,background-color,color] duration-150',
          '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          'data-[copied]:opacity-100 data-[copied]:text-state-success',
          'focus-ring outline-none'
        )}
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      </button>
    </Tooltip>
  );
}

export function ConnectionPane() {
  const connection = useStore((s) => s.connection);
  const models = useStore((s) => s.models);
  const modelsLoaded = useStore((s) => s.modelsLoaded);
  const loadConnection = useStore((s) => s.loadConnection);
  const loadModels = useStore((s) => s.loadModels);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const { t } = useTranslation('settings');

  // Re-read on mount so the pane reflects edits the user made externally
  // (claude /config or hand-edit) since the last app boot.
  useEffect(() => {
    void loadConnection();
    void loadModels();
  }, [loadConnection, loadModels]);

  async function onOpenSettings() {
    const api = window.ccsm;
    if (!api?.connection?.openSettingsFile) return;
    setOpening(true);
    setOpenError(null);
    try {
      const res = await api.connection.openSettingsFile();
      if (!res.ok) setOpenError(res.error);
    } finally {
      setOpening(false);
    }
  }

  const baseUrl = connection?.baseUrl ?? null;
  const model = connection?.model ?? null;
  const hasAuth = !!connection?.hasAuthToken;

  return (
    <div data-connection-pane>
      <div
        className="text-meta text-fg-tertiary mb-4 max-w-[520px] [&_code]:font-mono [&_code]:text-fg-secondary"
        dangerouslySetInnerHTML={{ __html: t('connection.intro') }}
      />

      <Field label={t('connection.baseUrl')}>
        <div className="group relative">
          <code
            data-connection-base-url
            className="block px-2 py-1.5 pr-8 rounded-sm bg-bg-elevated border border-border-subtle text-meta text-fg-secondary font-mono break-all"
          >
            {baseUrl ?? t('connection.baseUrlDefault')}
          </code>
          {baseUrl && (
            <CopyValueButton
              value={baseUrl}
              idleLabel={t('connection.copyBaseUrl')}
              copiedLabel={t('connection.copied')}
            />
          )}
        </div>
      </Field>

      <Field label={t('connection.defaultModel')}>
        <div className="group relative">
          <code
            data-connection-model
            className="block px-2 py-1.5 pr-8 rounded-sm bg-bg-elevated border border-border-subtle text-meta text-fg-secondary font-mono break-all"
          >
            {model ?? t('connection.modelUnset')}
          </code>
          {model && (
            <CopyValueButton
              value={model}
              idleLabel={t('connection.copyModel')}
              copiedLabel={t('connection.copied')}
            />
          )}
        </div>
      </Field>

      <Field label={t('connection.authToken')}>
        <span className="text-chrome text-fg-secondary">
          {hasAuth ? t('connection.authConfigured') : t('connection.authNotConfigured')}
        </span>
      </Field>

      <Field
        label={
          modelsLoaded
            ? t('connection.discoveredModels', { count: models.length })
            : t('connection.discoveredModelsLoadingCount')
        }
        hint={t('connection.discoveredModelsHint')}
      >
        {!modelsLoaded ? (
          <div className="text-chrome text-fg-tertiary">{t('connection.modelsLoading')}</div>
        ) : models.length === 0 ? (
          <div
            className="text-chrome text-fg-tertiary [&_code]:font-mono [&_code]:text-fg-secondary"
            dangerouslySetInnerHTML={{ __html: t('connection.modelsEmpty') }}
          />
        ) : (
          <ul
            data-connection-models
            className="max-h-40 overflow-auto rounded-sm border border-border-subtle bg-bg-elevated divide-y divide-border-subtle"
          >
            {models.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between px-3 py-1.5 text-meta"
              >
                <span className="font-mono text-fg-primary truncate">{m.id}</span>
                <span className="text-mono-xs tracking-wide text-fg-tertiary ml-2 shrink-0">
                  {m.source === 'settings'
                    ? t('connection.modelSourceSettings')
                    : m.source === 'cli-picker'
                      ? t('connection.modelSourceCliPicker')
                      : m.source === 'fallback'
                        ? t('connection.modelSourceFallback')
                        : m.source}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Field>

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="md"
          onClick={onOpenSettings}
          disabled={opening}
          data-connection-open-file
        >
          {opening ? t('connection.opening') : t('connection.openSettingsFile')}
        </Button>
        {openError && (
          <span className="text-meta text-state-error">{openError}</span>
        )}
      </div>
    </div>
  );
}
