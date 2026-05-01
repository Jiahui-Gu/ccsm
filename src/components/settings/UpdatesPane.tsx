import React, { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { useTranslation } from '../../i18n/useTranslation';
import type { UpdateStatus } from '../../global';
import { Field } from './Field';

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

// Phase 4 crash observability — tri-state consent (`pending` / `opted-in` /
// `opted-out`) lives in app_state under `crashUploadConsent`. The legacy
// `crashReportingOptOut` boolean is read by `electron/prefs/crashConsent.ts`
// as a fallback so a previously-opted-out user stays opted-out across the
// upgrade. The Settings switch below ONLY writes the new key.
const CONSENT_KEY = 'crashUploadConsent';
type Consent = 'pending' | 'opted-in' | 'opted-out';

function CrashReportingField() {
  const { t } = useTranslation('settings');
  const [consent, setConsent] = useState<Consent>('pending');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await window.ccsm?.loadState(CONSENT_KEY);
        if (cancelled) return;
        if (raw === 'opted-in' || raw === 'opted-out' || raw === 'pending') {
          setConsent(raw);
        } else {
          // Legacy fallback: respect the old boolean if present so the
          // toggle reflects the user's previous choice on first paint
          // after upgrade.
          const legacy = await window.ccsm?.loadState('crashReportingOptOut');
          if (!cancelled && (legacy === 'true' || legacy === '1')) {
            setConsent('opted-out');
          } else {
            setConsent('pending');
          }
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onChange = (sendReports: boolean) => {
    const next: Consent = sendReports ? 'opted-in' : 'opted-out';
    setConsent(next);
    void window.ccsm?.saveState(CONSENT_KEY, next);
  };

  const checked = consent === 'opted-in';

  return (
    <Field label={t('crashReporting.consentLabel')} hint={t('crashReporting.consentHint')}>
      <label
        className={cn(
          'inline-flex items-center gap-2 cursor-pointer select-none',
          !hydrated && 'opacity-60'
        )}
      >
        <Switch
          checked={checked}
          disabled={!hydrated}
          onCheckedChange={onChange}
          aria-label={t('crashReporting.consentLabel')}
          data-crash-consent-toggle
        />
        <span className="text-chrome text-fg-secondary">
          {t('crashReporting.consentLabel')}
        </span>
      </label>
      <SendLastCrashRow />
    </Field>
  );
}

interface IncidentSummary {
  id: string;
  dirName: string;
  ts: string;
  surface: string;
  alreadySent: boolean;
}

type SendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'success' }
  | { kind: 'error'; reason: string };

function SendLastCrashRow() {
  const { t } = useTranslation('settings');
  const [incident, setIncident] = useState<IncidentSummary | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [send, setSend] = useState<SendState>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const got = (await window.ccsm?.crash?.getLastIncident()) ?? null;
        if (!cancelled) setIncident(got);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onClick = async () => {
    if (!incident || send.kind === 'sending') return;
    setSend({ kind: 'sending' });
    const res = await window.ccsm?.crash?.sendLastIncident();
    if (!res) {
      setSend({ kind: 'error', reason: 'no-bridge' });
      return;
    }
    if (res.ok) {
      setSend({ kind: 'success' });
      // Re-fetch to flip alreadySent so the button disables itself.
      const refreshed = (await window.ccsm?.crash?.getLastIncident()) ?? null;
      setIncident(refreshed);
    } else {
      setSend({ kind: 'error', reason: res.reason });
    }
  };

  const disabled =
    !hydrated ||
    !incident ||
    incident.alreadySent ||
    send.kind === 'sending' ||
    send.kind === 'success';

  let status: string;
  if (!hydrated) {
    status = '';
  } else if (!incident) {
    status = t('crashReporting.sendLastNoCrash');
  } else if (send.kind === 'success') {
    status = t('crashReporting.sendLastSuccess');
  } else if (send.kind === 'error') {
    status = t('crashReporting.sendLastError', { reason: send.reason });
  } else if (send.kind === 'sending') {
    status = t('crashReporting.sendLastSending');
  } else if (incident.alreadySent) {
    status = t('crashReporting.sendLastAlreadySent');
  } else {
    status = t('crashReporting.sendLastReady', { ts: incident.ts, surface: incident.surface });
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void onClick()}
        disabled={disabled}
        data-send-last-crash-button
      >
        {t('crashReporting.sendLast')}
      </Button>
      <span className="text-meta text-fg-tertiary" data-send-last-crash-status>
        {status}
      </span>
      <span className="text-meta text-fg-tertiary">
        {t('crashReporting.consentLocalNote')}
      </span>
    </div>
  );
}
