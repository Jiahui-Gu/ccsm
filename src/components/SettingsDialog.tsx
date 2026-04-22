import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '../lib/cn';
import { Dialog, DialogContent } from './ui/Dialog';
import { Button } from './ui/Button';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';
import { usePreferences } from '../store/preferences';

type LocalUpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

type Tab = 'appearance' | 'notifications' | 'endpoints' | 'updates';

// Tab catalog. Labels are i18n keys under `settings:tabs.*` rather than
// literal strings, so the nav re-renders when the user flips language.
const TABS: { id: Tab; tabKey: string }[] = [
  { id: 'appearance', tabKey: 'appearance' },
  { id: 'notifications', tabKey: 'notifications' },
  { id: 'endpoints', tabKey: 'endpoints' },
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
  // `/config` vs `/model` — the latter wants the endpoints tab).
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  const { t: tt } = useTranslation('settings');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={tt('title')} width="720px" hideClose={false}>
        <div className="flex min-h-[380px] border-t border-border-subtle">
          <nav className="w-[160px] shrink-0 border-r border-border-subtle py-2">
            {TABS.map((tabEntry) => (
              <button
                key={tabEntry.id}
                onClick={() => setTab(tabEntry.id)}
                className={cn(
                  'relative flex w-full items-center h-7 px-3 text-sm rounded-sm mx-1',
                  'transition-[background-color,color] duration-150 ease-out',
                  'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong',
                  tab === tabEntry.id
                    ? 'bg-bg-hover text-fg-primary font-medium'
                    : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary'
                )}
                style={{ width: 'calc(100% - 0.5rem)' }}
              >
                {tab === tabEntry.id && (
                  <motion.span
                    aria-hidden
                    layoutId="settings-tab-indicator"
                    transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                    className="absolute left-0 top-1 bottom-1 w-[3px] bg-accent rounded-r-sm"
                  />
                )}
                {tt(`tabs.${tabEntry.tabKey}`)}
              </button>
            ))}
          </nav>
          <div className="flex-1 min-w-0 p-5 overflow-y-auto">
            {tab === 'appearance' && <AppearancePane />}
            {tab === 'notifications' && <NotificationsPane />}
            {tab === 'endpoints' && <EndpointsPane />}
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
      <label className="block text-sm font-medium text-fg-primary mb-1">{label}</label>
      {hint && <div className="text-xs text-fg-tertiary mb-1.5">{hint}</div>}
      {children}
    </div>
  );
}

function _Select<T extends string>({
  value,
  onChange,
  options
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        'h-7 px-2 pr-6 rounded-sm bg-bg-elevated border border-border-default',
        'text-sm text-fg-primary outline-none cursor-pointer',
        'hover:border-border-strong',
        'focus-visible:border-border-strong focus-visible:shadow-[0_0_0_2px_var(--color-focus-ring)]'
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function AppearancePane() {
  const theme = useStore((s) => s.theme);
  const fontSizePx = useStore((s) => s.fontSizePx);
  const density = useStore((s) => s.density);
  const setTheme = useStore((s) => s.setTheme);
  const setFontSizePx = useStore((s) => s.setFontSizePx);
  const setDensity = useStore((s) => s.setDensity);
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
      <Field label={t('fontSize')} hint={t('fontSizeAppliesHint')}>
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
            aria-label={t('fontSizeAria')}
          />
          <span className="text-xs font-mono text-fg-secondary tabular-nums w-10">{fontSizePx}px</span>
        </div>
      </Field>
      <Field label={t('density')} hint={t('densityHint')}>
        <Segmented
          value={density}
          onChange={setDensity}
          options={[
            { value: 'compact', label: t('densityOptions.compact') },
            { value: 'normal', label: t('densityOptions.normal') },
            { value: 'comfortable', label: t('densityOptions.comfortable') },
          ]}
        />
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
              'h-6 px-2.5 text-xs rounded-[3px] transition-[background-color,color,box-shadow] duration-150 ease-out',
              'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60',
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
  const { t } = useTranslation('settings');

  const Toggle = ({
    checked,
    onChange,
    disabled
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <label
      className={cn(
        'inline-flex items-center gap-2 select-none',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-accent"
      />
      <span className="text-sm text-fg-secondary">{checked ? t('notifications.toggleOn') : t('notifications.toggleOff')}</span>
    </label>
  );

  const onTest = async () => {
    const api = window.agentory;
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
      <div className="text-xs text-fg-tertiary mb-4">
        {t('notifications.intro')}
      </div>
      <Field label={t('notifications.enable')}>
        <Toggle
          checked={settings.enabled}
          onChange={(v) => setNotificationSettings({ enabled: v })}
        />
      </Field>
      <Field label={t('notifications.permissionPrompts')} hint={t('notifications.permissionPromptsHint')}>
        <Toggle
          checked={settings.permission}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ permission: v })}
        />
      </Field>
      <Field label={t('notifications.questions')} hint={t('notifications.questionsHint')}>
        <Toggle
          checked={settings.question}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ question: v })}
        />
      </Field>
      <Field
        label={t('notifications.turnDone')}
        hint={t('notifications.turnDoneHint')}
      >
        <Toggle
          checked={settings.turnDone}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ turnDone: v })}
        />
      </Field>
      <Field label={t('notifications.sound')} hint={t('notifications.soundHint')}>
        <Toggle
          checked={settings.sound}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ sound: v })}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="md" onClick={onTest} disabled={disableChildren}>
          {t('notifications.testButton')}
        </Button>
        {testStatus && <span className="text-xs text-fg-secondary">{testStatus}</span>}
      </div>
    </>
  );
}

function UpdatesPane() {
  const [version, setVersion] = useState<string>('…');
  const [status, setStatus] = useState<LocalUpdateStatus>({ kind: 'idle' });
  const [autoCheck, setAutoCheck] = useState<boolean>(true);
  const { t } = useTranslation('settings');

  useEffect(() => {
    window.agentory?.getVersion().then(setVersion).catch(() => setVersion(t('updates.versionUnknown')));
    void window.agentory?.updatesStatus().then(setStatus).catch(() => {});
    void window.agentory?.updatesGetAutoCheck().then(setAutoCheck).catch(() => {});
    const off = window.agentory?.onUpdateStatus(setStatus);
    return () => off?.();
  }, [t]);

  const isChecking = status.kind === 'checking';
  const isDownloading = status.kind === 'downloading';
  const canCheck = !isChecking && !isDownloading && status.kind !== 'downloaded';

  async function onCheck() {
    if (!window.agentory) return;
    setStatus({ kind: 'checking' });
    await window.agentory.updatesCheck();
    // Real status arrives via the push event; nothing to do here.
  }

  async function onDownload() {
    await window.agentory?.updatesDownload();
  }

  function onInstall() {
    void window.agentory?.updatesInstall();
  }

  async function onToggleAutoCheck(next: boolean) {
    setAutoCheck(next);
    if (window.agentory) {
      const applied = await window.agentory.updatesSetAutoCheck(next);
      setAutoCheck(applied);
    }
  }

  return (
    <>
      <Field label={t('version')}>
        <span className="text-sm text-fg-secondary font-mono">{version}</span>
      </Field>
      <Field label={t('updates.status')}>
        <span className="text-sm text-fg-secondary font-mono">{describeStatus(status, t)}</span>
      </Field>
      <Field
        label={t('updates.automaticChecks')}
        hint={t('updates.automaticChecksHint')}
      >
        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoCheck}
            onChange={(e) => void onToggleAutoCheck(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          <span className="text-sm text-fg-secondary">{t('updates.automaticChecksToggle')}</span>
        </label>
      </Field>
      <div className="flex gap-2">
        <Button variant="secondary" size="md" onClick={onCheck} disabled={!canCheck}>
          {isChecking ? t('updates.checking') : t('checkForUpdates')}
        </Button>
        {status.kind === 'available' && (
          <Button variant="primary" size="md" onClick={onDownload}>
            {t('updates.downloadVersion', { version: status.version })}
          </Button>
        )}
        {status.kind === 'downloaded' && (
          <Button variant="primary" size="md" onClick={onInstall}>
            {t('updates.restartAndInstall')}
          </Button>
        )}
      </div>
    </>
  );
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function describeStatus(s: LocalUpdateStatus, t: TFn): string {
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
        total: formatBytes(s.total),
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

function relativeTime(ts: number | null, t: TFn): string {
  if (!ts) return t('endpoints.relativeNever');
  const delta = Date.now() - ts;
  if (delta < 60_000) return t('endpoints.relativeJustNow');
  if (delta < 3_600_000) return t('endpoints.relativeMinutes', { n: Math.floor(delta / 60_000) });
  if (delta < 86_400_000) return t('endpoints.relativeHours', { n: Math.floor(delta / 3_600_000) });
  return t('endpoints.relativeDays', { n: Math.floor(delta / 86_400_000) });
}

type EditingEndpoint = {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  isDefault: boolean;
  hasExistingKey?: boolean;
  manualModelIds?: string[];
};

// Labels for the detected endpoint kind. `unknown` is a real outcome (most
// 中转 relays that only forward /v1/messages), not an error — show it plainly.
// All values stay English brand names except `unknown` which is i18n'd via
// the `endpoints.kindUnknown` key at render time.
const KIND_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  'openai-compat': 'OpenAI-compat',
  ollama: 'Ollama',
  bedrock: 'Bedrock',
  vertex: 'Vertex',
};

function KindBadge({ kind }: { kind: string | null }) {
  const { t } = useTranslation('settings');
  if (!kind) return null;
  const label = KIND_LABEL[kind] ?? (kind === 'unknown' ? t('endpoints.kindUnknown') : kind);
  return (
    <span
      className="text-[10px] uppercase tracking-wide px-1 rounded-sm bg-bg-hover text-fg-secondary"
      title={t('endpoints.kindLabelTooltip', { label })}
    >
      {label}
    </span>
  );
}

function SourceBreakdown({
  counts,
  total,
}: {
  counts: {
    fallback: number;
    listed: number;
    manual: number;
    cliPicker: number;
    envOverride: number;
  };
  total: number;
}) {
  const { t } = useTranslation('settings');
  const parts: string[] = [];
  if (counts.listed) parts.push(t('endpoints.sourceListed', { count: counts.listed }));
  if (counts.cliPicker) parts.push(t('endpoints.sourceCliPicker', { count: counts.cliPicker }));
  if (counts.envOverride) parts.push(t('endpoints.sourceEnvOverride', { count: counts.envOverride }));
  if (counts.fallback) parts.push(t('endpoints.sourceFallback', { count: counts.fallback }));
  if (counts.manual) parts.push(t('endpoints.sourceManual', { count: counts.manual }));
  const tooltip = parts.length ? parts.join(' \u00B7 ') : t('endpoints.sourceNoData');
  return (
    <span title={tooltip} className="cursor-help">
      {t('endpoints.modelCount', { count: total })}
    </span>
  );
}

function EndpointsPane() {
  const endpoints = useStore((s) => s.endpoints);
  const modelsByEndpoint = useStore((s) => s.modelsByEndpoint);
  const endpointsLoaded = useStore((s) => s.endpointsLoaded);
  const reloadEndpoints = useStore((s) => s.reloadEndpoints);
  const refreshEndpointModels = useStore((s) => s.refreshEndpointModels);
  const { t } = useTranslation('settings');

  const [editor, setEditor] = useState<EditingEndpoint | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRefresh(id: string) {
    setRefreshingId(id);
    setError(null);
    const res = await refreshEndpointModels(id);
    setRefreshingId(null);
    if (!res.ok) setError(res.error ?? t('endpoints.refreshFailed'));
  }

  async function onRemove(id: string) {
    const api = window.agentory;
    if (!api) return;
    await api.endpoints.remove(id);
    await reloadEndpoints();
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs text-fg-tertiary max-w-[440px]">
          {t('endpoints.intro')}
          <code className="font-mono text-fg-secondary mx-1">GET /v1/models</code>.
        </div>
        <Button variant="primary" size="md" onClick={() => setEditor(emptyEditor())}>
          {t('endpoints.addBtn')}
        </Button>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-sm border border-state-error/40 bg-state-error/10 text-xs text-state-error">
          {error}
        </div>
      )}

      {!endpointsLoaded ? (
        <div className="text-sm text-fg-tertiary">{t('endpoints.loading')}</div>
      ) : endpoints.length === 0 ? (
        <div className="text-sm text-fg-tertiary">
          {t('endpoints.empty')}
        </div>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-sm border border-border-subtle bg-bg-elevated">
          {endpoints.map((e) => {
            const models = modelsByEndpoint[e.id] ?? [];
            const counts = {
              fallback: models.filter((m) => m.source === 'fallback').length,
              listed: models.filter((m) => m.source === 'listed').length,
              manual: models.filter((m) => m.source === 'manual').length,
              cliPicker: models.filter((m) => m.source === 'cli-picker').length,
              envOverride: models.filter((m) => m.source === 'env-override').length,
            };
            const is401 = e.lastStatus === 'error' && (e.lastError ?? '').toLowerCase().includes('auth');
            const noneFound = e.lastStatus === 'ok' && models.length === 0;
            return (
              <li key={e.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-fg-primary truncate">{e.name}</span>
                    {e.isDefault && (
                      <span className="text-[10px] uppercase tracking-wide px-1 rounded-sm bg-accent/15 text-accent">
                        {t('endpoints.defaultBadge')}
                      </span>
                    )}
                    <StatusBadge status={e.lastStatus} />
                    <KindBadge kind={e.detectedKind ?? e.kind} />
                  </div>
                  <div className="text-[11px] font-mono text-fg-tertiary truncate" title={e.baseUrl}>
                    {e.baseUrl}
                  </div>
                  <div className="text-[11px] text-fg-tertiary mt-0.5">
                    <SourceBreakdown counts={counts} total={models.length} /> ·{' '}
                    {t('endpoints.refreshed', { when: relativeTime(e.lastRefreshedAt, t) })}
                    {e.lastRefreshedAt ? t('endpoints.cachedSuffix') : ''}
                  </div>
                  {is401 && (
                    <div className="mt-1.5 px-2 py-1 rounded-sm border border-state-error/40 bg-state-error/10 text-[11px] text-state-error">
                      {t('endpoints.authFailed')}
                    </div>
                  )}
                  {noneFound && (
                    <div className="mt-1.5 px-2 py-1 rounded-sm border border-state-warning/40 bg-state-warning/10 text-[11px] text-fg-secondary">
                      {t('endpoints.noModelsFound')}
                    </div>
                  )}
                  {e.lastStatus === 'error' && !is401 && e.lastError ? (
                    <div className="mt-1.5 text-[11px] text-state-error truncate" title={e.lastError}>
                      {e.lastError}
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onRefresh(e.id)}
                    disabled={refreshingId === e.id}
                  >
                    {refreshingId === e.id ? t('endpoints.refreshing') : t('endpoints.refreshModels')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setEditor({
                        id: e.id,
                        name: e.name,
                        baseUrl: e.baseUrl,
                        apiKey: '',
                        isDefault: e.isDefault,
                        hasExistingKey: true,
                        manualModelIds: e.manualModelIds,
                      })
                    }
                  >
                    {t('endpoints.edit')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      if (window.confirm(t('endpoints.removeConfirm', { name: e.name }))) void onRemove(e.id);
                    }}
                  >
                    {t('endpoints.remove')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editor && (
        <EndpointEditorDialog
          value={editor}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            await reloadEndpoints();
          }}
        />
      )}
    </>
  );
}

function emptyEditor(): EditingEndpoint {
  return { name: '', baseUrl: 'https://api.anthropic.com', apiKey: '', isDefault: false };
}

function StatusBadge({ status }: { status: 'ok' | 'error' | 'unchecked' }) {
  const { t } = useTranslation('settings');
  const cls =
    status === 'ok'
      ? 'bg-state-success/15 text-state-success'
      : status === 'error'
      ? 'bg-state-error/15 text-state-error'
      : 'bg-bg-hover text-fg-tertiary';
  const label =
    status === 'ok'
      ? t('endpoints.statusConnected')
      : status === 'error'
      ? t('endpoints.statusError')
      : t('endpoints.statusUnchecked');
  return (
    <span className={cn('text-[10px] uppercase tracking-wide px-1 rounded-sm', cls)}>{label}</span>
  );
}

function EndpointEditorDialog({
  value,
  onClose,
  onSaved,
}: {
  value: EditingEndpoint;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [name, setName] = useState(value.name);
  const [baseUrl, setBaseUrl] = useState(value.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [isDefault, setIsDefault] = useState(value.isDefault);
  const [revealKey, setRevealKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [manualIdsRaw, setManualIdsRaw] = useState<string>(
    (value.manualModelIds ?? []).join('\n')
  );
  const isEdit = !!value.id;
  // API key is optional — local relays and some self-hosted endpoints do not
  // require auth. See endpoints-manager: empty key omits the x-api-key header.
  const canTest = baseUrl.trim().length > 0;

  async function onTest() {
    if (!window.agentory) return;
    setTesting(true);
    setTestResult(null);
    const res = await window.agentory.endpoints.testConnection({
      baseUrl: baseUrl.trim(),
      apiKey: apiKey || '',
    });
    setTesting(false);
    setTestResult(res.ok ? 'ok' : res.error);
  }

  async function onSave() {
    if (!window.agentory) return;
    if (!name.trim() || !baseUrl.trim()) return;
    setSaving(true);
    try {
      const manualIds = parseManualIds(manualIdsRaw);
      let endpointId: string | undefined;
      if (isEdit && value.id) {
        await window.agentory.endpoints.update(value.id, {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiKey: apiKey ? apiKey : undefined,
          isDefault,
        });
        endpointId = value.id;
      } else {
        const row = await window.agentory.endpoints.add({
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          kind: 'anthropic',
          apiKey: apiKey || undefined,
          isDefault,
        });
        endpointId = row.id;
      }
      if (endpointId) {
        await window.agentory.endpoints.setManualModels(endpointId, manualIds);
        // Kick discovery so the manual IDs are probe-validated right away.
        await window.agentory.endpoints.refreshModels(endpointId);
      }
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  const inputClass = cn(
    'w-full h-8 px-2 rounded-sm bg-bg-elevated border border-border-default',
    'text-sm text-fg-primary placeholder:text-fg-disabled outline-none',
    'focus:border-border-strong focus:shadow-[0_0_0_2px_var(--color-focus-ring)]'
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={isEdit ? t('endpoints.editorEditTitle') : t('endpoints.editorAddTitle')} width="520px">
        <div className="px-5 pb-4">
          <Field label={t('endpoints.fieldName')}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('endpoints.fieldNamePlaceholder')}
              className={inputClass}
              autoFocus
            />
          </Field>
          <Field label={t('endpoints.fieldProtocol')}>
            <span className="text-sm text-fg-secondary">{t('endpoints.fieldProtocolValue')}</span>
          </Field>
          <Field label={t('endpoints.fieldBaseUrl')} hint={t('endpoints.fieldBaseUrlHint')}>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t('endpoints.fieldBaseUrlPlaceholder')}
              className={cn(inputClass, 'font-mono')}
            />
          </Field>
          <Field
            label={t('endpoints.fieldApiKey')}
            hint={
              value.hasExistingKey
                ? t('endpoints.fieldApiKeyHintExisting')
                : t('endpoints.fieldApiKeyHintNew')
            }
          >
            <div className="flex items-center gap-2">
              <input
                type={revealKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={value.hasExistingKey ? t('endpoints.fieldApiKeyPlaceholderUnchanged') : t('apiKeyPlaceholder')}
                className={cn(inputClass, 'font-mono')}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRevealKey((r) => !r)}
                aria-label={revealKey ? t('endpoints.hideKey') : t('endpoints.revealKey')}
              >
                {revealKey ? t('endpoints.hideBtn') : t('endpoints.showBtn')}
              </Button>
            </div>
          </Field>
          <Field label={t('endpoints.fieldDefault')} hint={t('endpoints.fieldDefaultHint')}>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              <span className="text-sm text-fg-secondary">{t('endpoints.fieldDefaultMake')}</span>
            </label>
          </Field>
          <Field
            label={t('endpoints.fieldManualIds')}
            hint={t('endpoints.fieldManualIdsHint')}
          >
            <textarea
              value={manualIdsRaw}
              onChange={(e) => setManualIdsRaw(e.target.value)}
              rows={3}
              placeholder={'claude-opus-4-5\nclaude-sonnet-4-5'}
              className={cn(
                inputClass,
                'h-auto py-2 resize-y leading-snug font-mono text-xs'
              )}
            />
          </Field>
          <div className="flex items-center gap-3 mt-4">
            <Button variant="secondary" size="md" onClick={onTest} disabled={!canTest || testing}>
              {testing ? t('endpoints.testing') : t('testConnection')}
            </Button>
            {testResult === 'ok' && (
              <span className="text-xs text-state-success">{t('endpoints.testOk')}</span>
            )}
            {testResult && testResult !== 'ok' && (
              <span className="text-xs text-state-error">{testResult}</span>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle">
          <Button variant="ghost" size="md" onClick={onClose}>
            {t('endpoints.cancel')}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={onSave}
            disabled={
              !name.trim() || !baseUrl.trim() || saving
            }
          >
            {saving ? t('endpoints.saving') : isEdit ? t('endpoints.save') : t('endpoints.add')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}


function parseManualIds(raw: string): string[] {
  // Split on newlines or commas; normalise whitespace so a pasted list like
  // "a,b ,\n c" yields ["a","b","c"].
  return Array.from(
    new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    )
  );
}
