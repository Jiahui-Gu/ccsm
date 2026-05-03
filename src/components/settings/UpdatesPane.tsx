import React, { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import * as Checkbox from '@radix-ui/react-checkbox';
import { cn } from '../../lib/cn';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { useTranslation } from '../../i18n/useTranslation';
import type { UpdateStatus } from '../../global';
import { commitItem } from '../../stores/persist';
import { Field } from './Field';

const CRASH_OPT_OUT_KEY = 'crashReportingOptOut';

export function UpdatesPane() {
  const [version, setVersion] = useState<string>('…');
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });
  const [autoCheck, setAutoCheck] = useState<boolean>(true);
  const { t } = useTranslation('settings');

  useEffect(() => {
    window.ccsm?.getVersion().then(setVersion).catch(() => setVersion('unknown'));
    void window.ccsm?.updatesStatus().then(setStatus).catch(() => {});
    void window.ccsm?.updatesGetAutoCheck().then(setAutoCheck).catch(() => {});
    const off = window.ccsm?.onUpdateStatus(setStatus);
    return () => off?.();
  }, []);

  const isChecking = status.kind === 'checking';
  const isDownloading = status.kind === 'downloading';
  const canCheck = !isChecking && !isDownloading && status.kind !== 'downloaded';

  async function onCheck() {
    if (!window.ccsm) return;
    setStatus({ kind: 'checking' });
    await window.ccsm.updatesCheck();
    // Real status arrives via the push event; nothing to do here.
  }

  async function onDownload() {
    await window.ccsm?.updatesDownload();
  }

  function onInstall() {
    void window.ccsm?.updatesInstall();
  }

  async function onToggleAutoCheck(next: boolean) {
    setAutoCheck(next);
    if (window.ccsm) {
      const applied = await window.ccsm.updatesSetAutoCheck(next);
      setAutoCheck(applied);
    }
  }

  return (
    <>
      <Field label={t('updates.version')}>
        <span className="text-chrome text-fg-secondary font-mono">{version}</span>
      </Field>
      <Field label={t('updates.status')}>
        <span className="text-chrome text-fg-secondary font-mono">{describeStatus(status, t)}</span>
      </Field>
      <Field label={t('updates.automaticChecks')} hint={t('updates.automaticChecksHint')}>
        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
          <Switch
            checked={autoCheck}
            onCheckedChange={(v) => void onToggleAutoCheck(v)}
            aria-label={t('updates.automaticChecksToggle')}
          />
          <span className="text-chrome text-fg-secondary">{t('updates.automaticChecksToggle')}</span>
        </label>
      </Field>
      <div className="flex gap-2">
        <Button variant="secondary" size="md" onClick={onCheck} disabled={!canCheck}>
          {isChecking ? t('updates.checking') : t('updates.checkButton')}
        </Button>
        {status.kind === 'available' && (
          <Button variant="primary" size="md" onClick={onDownload}>
            {t('updates.downloadButton', { version: status.version })}
          </Button>
        )}
        {status.kind === 'downloaded' && (
          <Button variant="primary" size="md" onClick={onInstall}>
            {t('updates.installButton')}
          </Button>
        )}
      </div>
      <div className="mt-6 pt-5 border-t border-border-subtle">
        <CrashReportingField />
      </div>
    </>
  );
}

function describeStatus(s: UpdateStatus, t: (key: string, vars?: Record<string, unknown>) => string): string {
  switch (s.kind) {
    case 'idle':
      return t('updates.statusIdle');
    case 'checking':
      return t('updates.statusChecking');
    case 'available':
      return t('updates.statusAvailable', { version: s.version });
    case 'not-available':
      return t('updates.statusNotAvailable');
    case 'downloading':
      return t('updates.statusDownloading', {
        percent: s.percent.toFixed(1),
        transferred: formatBytes(s.transferred),
        total: formatBytes(s.total)
      });
    case 'downloaded':
      return t('updates.statusDownloaded', { version: s.version });
    case 'error':
      return t('updates.statusError', { message: s.message });
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Persisted via localStorage under `crashReportingOptOut` (Wave 0e cutover
// from removed `window.ccsm.{loadState,saveState}` IPCs; same transitional
// posture as src/stores/persist.ts — re-cuts to SettingsService RPC when
// #228 sub-task 9 ships). Stored value is the OPT-OUT flag (default false
// → reporting ON); missing entry means "send", matching electron/main.ts.
function CrashReportingField() {
  const { t } = useTranslation('settings');
  const [optOut, setOptOut] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw =
        typeof localStorage !== 'undefined'
          ? localStorage.getItem(CRASH_OPT_OUT_KEY)
          : null;
      setOptOut(raw === 'true' || raw === '1');
    } finally {
      setHydrated(true);
    }
  }, []);

  const onChange = (sendReports: boolean) => {
    // UI is "Send crash reports" (positive). Persisted key is the inverse.
    const nextOptOut = !sendReports;
    setOptOut(nextOptOut);
    commitItem(CRASH_OPT_OUT_KEY, String(nextOptOut));
  };

  const checked = !optOut;

  return (
    <label
      className={cn(
        'flex items-start gap-3 cursor-pointer select-none',
        !hydrated && 'opacity-60'
      )}
    >
      <Checkbox.Root
        checked={checked}
        disabled={!hydrated}
        onCheckedChange={(v) => onChange(v === true)}
        className={cn(
          'mt-[3px] h-3.5 w-3.5 shrink-0 rounded-sm border border-border-strong',
          'data-[state=checked]:bg-accent data-[state=checked]:border-accent',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          'focus-visible:ring-offset-1 focus-visible:ring-offset-bg-app',
          'transition-colors duration-150'
        )}
      >
        <Checkbox.Indicator className="flex items-center justify-center text-bg-app">
          <Check size={10} strokeWidth={3} />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <div className="min-w-0 flex-1">
        <div className="text-chrome font-medium text-fg-primary">
          {t('crashReporting.label')}
        </div>
        <div className="text-meta text-fg-tertiary mt-0.5">
          {t('crashReporting.description')}
        </div>
      </div>
    </label>
  );
}
