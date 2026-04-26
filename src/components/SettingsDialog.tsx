import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Copy } from 'lucide-react';
import * as Checkbox from '@radix-ui/react-checkbox';
import * as RD from '@radix-ui/react-dialog';
import { cn } from '../lib/cn';
import { Dialog, DialogContent } from './ui/Dialog';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { Switch } from './ui/Switch';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';
import { usePreferences } from '../store/preferences';
import { useFocusRestore } from '../lib/useFocusRestore';
import { DURATION_RAW, EASING } from '../lib/motion';

type LocalUpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

type Tab = 'appearance' | 'notifications' | 'connection' | 'updates';

// Tab catalog. Labels are i18n keys under `settings:tabs.*` rather than
// literal strings, so the nav re-renders when the user flips language.
const TABS: { id: Tab; tabKey: string }[] = [
  { id: 'appearance', tabKey: 'appearance' },
  { id: 'notifications', tabKey: 'notifications' },
  { id: 'connection', tabKey: 'connection' },
  { id: 'updates', tabKey: 'updates' }
];

export function SettingsDialog({
  open,
  onOpenChange,
  initialTab
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'appearance');

  // Sync the tab when the dialog is reopened with a fresh initialTab (e.g.,
  // `/config` vs `/model` — the latter wants the connection tab).
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  // a11y: restore focus to the element that opened this dialog on close.
  // Settings is opened via Ctrl+, / context menu / palette — none of which
  // use Radix's <Dialog.Trigger>, so its built-in restore doesn't fire.
  // Falls back to the active session row in the sidebar.
  const { handleCloseAutoFocus } = useFocusRestore(open, {
    fallbackSelector: '[data-session-id][aria-selected="true"], [data-session-id][tabindex="0"]'
  });

  const { t: tt } = useTranslation('settings');

  // Roving-focus tablist: only the active tab is in the Tab order; arrow
  // keys move between tabs. We render real `role="tab"` / `role="tabpanel"`
  // with `aria-controls` / `aria-labelledby` wiring so screen readers
  // announce "Tab 2 of 4: Notifications, selected".
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    appearance: null,
    notifications: null,
    connection: null,
    updates: null
  });
  const tabIds: Record<Tab, string> = {
    appearance: 'settings-tab-appearance',
    notifications: 'settings-tab-notifications',
    connection: 'settings-tab-connection',
    updates: 'settings-tab-updates'
  };
  const panelIds: Record<Tab, string> = {
    appearance: 'settings-panel-appearance',
    notifications: 'settings-panel-notifications',
    connection: 'settings-panel-connection',
    updates: 'settings-panel-updates'
  };

  const focusTab = (next: Tab) => {
    setTab(next);
    // Defer focus so the new tab button is committed and tabIndex updated.
    window.setTimeout(() => tabRefs.current[next]?.focus(), 0);
  };

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const order = TABS.map((x) => x.id);
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      focusTab(order[(idx + 1) % order.length]);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      focusTab(order[(idx - 1 + order.length) % order.length]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusTab(order[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusTab(order[order.length - 1]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={tt('title')} width="720px" hideClose={false} onCloseAutoFocus={handleCloseAutoFocus}>
        {/* Radix requires either a Description or explicit aria-describedby
            on DialogContent for a11y. Visible layout of Settings is driven
            by the tab list + panel heading, so the description is sr-only;
            screen readers announce it when focus lands in the dialog. */}
        <RD.Description className="sr-only">{tt('description')}</RD.Description>
        <div className="flex min-h-[380px] border-t border-border-subtle">
          <nav
            className="w-[160px] shrink-0 border-r border-border-subtle py-2"
            role="tablist"
            aria-orientation="vertical"
            aria-label={tt('title')}
          >
            {TABS.map((tabEntry, idx) => {
              const isActive = tab === tabEntry.id;
              return (
                <button
                  key={tabEntry.id}
                  ref={(el) => {
                    tabRefs.current[tabEntry.id] = el;
                  }}
                  id={tabIds[tabEntry.id]}
                  role="tab"
                  type="button"
                  aria-selected={isActive}
                  aria-controls={panelIds[tabEntry.id]}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setTab(tabEntry.id)}
                  onKeyDown={(e) => onTabKeyDown(e, idx)}
                  className={cn(
                    'relative flex w-full items-center h-7 px-3 text-chrome rounded-sm mx-1',
                    'transition-[background-color,color] duration-150 ease-out',
                    'outline-none focus-ring',
                    isActive
                      ? 'text-fg-primary font-medium'
                      : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary'
                  )}
                  style={{ width: 'calc(100% - 0.5rem)' }}
                >
                  {isActive && (
                    <motion.span
                      aria-hidden
                      layoutId="settings-tab-indicator"
                      transition={{ duration: DURATION_RAW.ms220, ease: EASING.standard }}
                      className="absolute left-0 top-1 bottom-1 w-[3px] bg-accent rounded-r-sm"
                    />
                  )}
                  {tt(`tabs.${tabEntry.tabKey}`)}
                </button>
              );
            })}
          </nav>
          <div
            className="flex-1 min-w-0 p-5 overflow-y-auto"
            role="tabpanel"
            id={panelIds[tab]}
            aria-labelledby={tabIds[tab]}
            tabIndex={0}
          >
            {tab === 'appearance' && <AppearancePane />}
            {tab === 'notifications' && <NotificationsPane />}
            {tab === 'connection' && <ConnectionPane />}
            {tab === 'updates' && <UpdatesPane />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <label className="block text-chrome font-medium text-fg-primary mb-1">{label}</label>
      {hint && <div className="text-meta text-fg-tertiary mb-1.5">{hint}</div>}
      {children}
    </div>
  );
}

function AppearancePane() {
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
    </>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div
      className={cn(
        'inline-flex h-7 items-center rounded-sm border border-border-default',
        'bg-bg-elevated p-0.5 gap-0.5'
      )}
      role="radiogroup"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-6 px-2.5 text-meta rounded-[3px] transition-[background-color,color,box-shadow] duration-150 ease-out',
              'outline-none focus-ring',
              active
                ? 'bg-bg-app text-fg-primary font-medium shadow-[inset_0_0_0_1px_var(--color-border-default)]'
                : 'text-fg-secondary hover:text-fg-primary hover:bg-bg-hover'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}


function NotificationsPane() {
  const settings = useStore((s) => s.notificationSettings);
  const setNotificationSettings = useStore((s) => s.setNotificationSettings);
  const activeId = useStore((s) => s.activeId);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [moduleStatus, setModuleStatus] = useState<
    { available: boolean; error: string | null } | null
  >(null);
  const { t } = useTranslation('settings');

  useEffect(() => {
    let cancelled = false;
    const api = window.ccsm;
    if (!api?.notifyAvailability) return;
    api.notifyAvailability().then((res) => {
      if (!cancelled) setModuleStatus(res);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const Toggle = ({
    checked,
    onChange,
    disabled,
    ariaLabel
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
    ariaLabel?: string;
  }) => (
    <Switch
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onCheckedChange={onChange}
    />
  );

  const onTest = async () => {
    const api = window.ccsm;
    if (!api) {
      setTestStatus(t('notifications.testIpcUnavailable'));
      setTimeout(() => setTestStatus(null), 2000);
      return;
    }
    const ok = await api.notify({
      sessionId: activeId,
      title: t('notifications.testTitle'),
      body: t('notifications.testBody'),
      eventType: 'test',
      silent: !settings.sound
    });
    setTestStatus(ok ? t('notifications.testSent') : t('notifications.testFailed'));
    setTimeout(() => setTestStatus(null), 2500);
  };

  const disableChildren = !settings.enabled;

  return (
    <>
      <div className="text-meta text-fg-tertiary mb-4">
        {t('notifications.intro')}
      </div>
      <div
        data-testid="notifications-module-status"
        data-available={
          moduleStatus === null ? 'unknown' : moduleStatus.available ? 'true' : 'false'
        }
        className={cn(
          'text-meta mb-4 rounded-md border px-3 py-2',
          moduleStatus === null && 'border-border-subtle text-fg-tertiary',
          moduleStatus?.available && 'border-border-subtle text-fg-secondary',
          moduleStatus && !moduleStatus.available &&
            'border-amber-500/40 bg-amber-500/5 text-fg-secondary'
        )}
      >
        {moduleStatus === null
          ? t('notifications.moduleChecking')
          : moduleStatus.available
            ? t('notifications.moduleAvailable')
            : t('notifications.moduleUnavailable')}
      </div>
      <Field label={t('notifications.enable')}>
        <Toggle
          checked={settings.enabled}
          onChange={(v) => setNotificationSettings({ enabled: v })}
          ariaLabel={t('notifications.enable')}
        />
      </Field>
      <Field label={t('notifications.permission')} hint={t('notifications.permissionHint')}>
        <Toggle
          checked={settings.permission}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ permission: v })}
          ariaLabel={t('notifications.permission')}
        />
      </Field>
      <Field label={t('notifications.question')} hint={t('notifications.questionHint')}>
        <Toggle
          checked={settings.question}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ question: v })}
          ariaLabel={t('notifications.question')}
        />
      </Field>
      <Field label={t('notifications.turnDone')} hint={t('notifications.turnDoneHint')}>
        <Toggle
          checked={settings.turnDone}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ turnDone: v })}
          ariaLabel={t('notifications.turnDone')}
        />
      </Field>
      <Field label={t('notifications.sound')} hint={t('notifications.soundHint')}>
        <Toggle
          checked={settings.sound}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ sound: v })}
          ariaLabel={t('notifications.sound')}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="md" onClick={onTest} disabled={disableChildren}>
          {t('notifications.testButton')}
        </Button>
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="notifications-test-status"
          className="text-meta text-fg-secondary"
        >
          {testStatus ?? ''}
        </span>
      </div>
      <div className="mt-6 pt-5 border-t border-border-subtle">
        <CrashReportingField />
      </div>
    </>
  );
}

// Persisted via the existing `db:save` / `db:load` IPC under the
// `crashReportingOptOut` app_state key. We store the OPT-OUT flag (default
// false → reporting ON) so a missing row means "send"; that matches the
// reading logic in electron/main.ts so the two never disagree.
function CrashReportingField() {
  const { t } = useTranslation('settings');
  const [optOut, setOptOut] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await window.ccsm?.loadState('crashReportingOptOut');
        if (cancelled) return;
        setOptOut(raw === 'true' || raw === '1');
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onChange = (sendReports: boolean) => {
    // UI is "Send crash reports" (positive). Persisted key is the inverse.
    const nextOptOut = !sendReports;
    setOptOut(nextOptOut);
    void window.ccsm?.saveState('crashReportingOptOut', String(nextOptOut));
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

function UpdatesPane() {
  const [version, setVersion] = useState<string>('…');
  const [status, setStatus] = useState<LocalUpdateStatus>({ kind: 'idle' });
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
    </>
  );
}

function describeStatus(s: LocalUpdateStatus, t: (key: string, vars?: Record<string, unknown>) => string): string {
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

function ConnectionPane() {
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
