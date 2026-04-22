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
      <Field label="Theme" hint="System follows your OS preference (and reacts live when it changes).">
        <Segmented
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'system', label: 'System' },
          ]}
        />
      </Field>
      <Field label="Font size" hint="Applies to the whole app. Explicit small labels (meta, kbd) keep their intrinsic size.">
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
            aria-label="Font size in pixels"
          />
          <span className="text-xs font-mono text-fg-secondary tabular-nums w-10">{fontSizePx}px</span>
        </div>
      </Field>
      <Field label="Density" hint="Tightens or loosens row padding and spacing across the app.">
        <Segmented
          value={density}
          onChange={setDensity}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'normal', label: 'Normal' },
            { value: 'comfortable', label: 'Comfortable' },
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
      <span className="text-sm text-fg-secondary">{checked ? 'On' : 'Off'}</span>
    </label>
  );

  const onTest = async () => {
    const api = window.agentory;
    if (!api) {
      setTestStatus('IPC unavailable.');
      setTimeout(() => setTestStatus(null), 2000);
      return;
    }
    const ok = await api.notify({
      sessionId: activeId,
      title: 'Agentory test notification',
      body: 'If you can read this, OS notifications are working.',
      eventType: 'test',
      silent: !settings.sound
    });
    setTestStatus(ok ? 'Sent.' : 'Failed - OS notifications unavailable.');
    setTimeout(() => setTestStatus(null), 2500);
  };

  const disableChildren = !settings.enabled;

  return (
    <>
      <div className="text-xs text-fg-tertiary mb-4">
        OS-level toasts when a session needs your attention. Suppressed when
        the window is focused on that same session, and debounced per session
        per event type so a chatty agent cannot spam you.
      </div>
      <Field label="Enable notifications">
        <Toggle
          checked={settings.enabled}
          onChange={(v) => setNotificationSettings({ enabled: v })}
        />
      </Field>
      <Field label="Permission prompts" hint="When a tool call is waiting on your approval.">
        <Toggle
          checked={settings.permission}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ permission: v })}
        />
      </Field>
      <Field label="Questions" hint="When the agent uses AskUserQuestion to ask you something.">
        <Toggle
          checked={settings.question}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ question: v })}
        />
      </Field>
      <Field
        label="Turn done"
        hint="Only fires for long (>15s), errored, or unfocused turns - routine fast turns are skipped."
      >
        <Toggle
          checked={settings.turnDone}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ turnDone: v })}
        />
      </Field>
      <Field label="Sound" hint="Play the OS default notification sound.">
        <Toggle
          checked={settings.sound}
          disabled={disableChildren}
          onChange={(v) => setNotificationSettings({ sound: v })}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="md" onClick={onTest} disabled={disableChildren}>
          Test notification
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

  useEffect(() => {
    window.agentory?.getVersion().then(setVersion).catch(() => setVersion('unknown'));
    void window.agentory?.updatesStatus().then(setStatus).catch(() => {});
    void window.agentory?.updatesGetAutoCheck().then(setAutoCheck).catch(() => {});
    const off = window.agentory?.onUpdateStatus(setStatus);
    return () => off?.();
  }, []);

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
      <Field label="Version">
        <span className="text-sm text-fg-secondary font-mono">{version}</span>
      </Field>
      <Field label="Status">
        <span className="text-sm text-fg-secondary font-mono">{describeStatus(status)}</span>
      </Field>
      <Field
        label="Automatic checks"
        hint="When on, Agentory checks GitHub for updates on launch and every 4 hours."
      >
        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoCheck}
            onChange={(e) => void onToggleAutoCheck(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          <span className="text-sm text-fg-secondary">Check for updates automatically</span>
        </label>
      </Field>
      <div className="flex gap-2">
        <Button variant="secondary" size="md" onClick={onCheck} disabled={!canCheck}>
          {isChecking ? 'Checking…' : 'Check for updates'}
        </Button>
        {status.kind === 'available' && (
          <Button variant="primary" size="md" onClick={onDownload}>
            Download {status.version}
          </Button>
        )}
        {status.kind === 'downloaded' && (
          <Button variant="primary" size="md" onClick={onInstall}>
            Restart & install
          </Button>
        )}
      </div>
    </>
  );
}

function describeStatus(s: LocalUpdateStatus): string {
  switch (s.kind) {
    case 'idle':
      return 'No update check performed yet.';
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Update available: ${s.version}`;
    case 'not-available':
      return 'You are on the latest version.';
    case 'downloading':
      return `Downloading… ${s.percent.toFixed(1)}% (${formatBytes(s.transferred)} / ${formatBytes(s.total)})`;
    case 'downloaded':
      return `Update ${s.version} ready — restart to install.`;
    case 'error':
      return `Update check failed: ${s.message}`;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ConnectionPane() {
  const connection = useStore((s) => s.connection);
  const models = useStore((s) => s.models);
  const modelsLoaded = useStore((s) => s.modelsLoaded);
  const loadConnection = useStore((s) => s.loadConnection);
  const loadModels = useStore((s) => s.loadModels);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  // Re-read on mount so the pane reflects edits the user made externally
  // (claude /config or hand-edit) since the last app boot.
  useEffect(() => {
    void loadConnection();
    void loadModels();
  }, [loadConnection, loadModels]);

  async function onOpenSettings() {
    const api = window.agentory;
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
      <div className="text-xs text-fg-tertiary mb-4 max-w-[520px]">
        Agentory reads connection settings from{' '}
        <code className="font-mono text-fg-secondary">~/.claude/settings.json</code>{' '}
        plus your <code className="font-mono text-fg-secondary">ANTHROPIC_*</code>{' '}
        environment variables. To change them, run{' '}
        <code className="font-mono text-fg-secondary">claude /config</code> or edit
        the file directly. Restart Agentory to pick up changes.
      </div>

      <Field label="Base URL">
        <code
          data-connection-base-url
          className="block px-2 py-1.5 rounded-sm bg-bg-elevated border border-border-subtle text-xs text-fg-secondary font-mono break-all"
        >
          {baseUrl ?? 'https://api.anthropic.com (default)'}
        </code>
      </Field>

      <Field label="Default model">
        <code
          data-connection-model
          className="block px-2 py-1.5 rounded-sm bg-bg-elevated border border-border-subtle text-xs text-fg-secondary font-mono break-all"
        >
          {model ?? '(unset — the CLI will pick its own default)'}
        </code>
      </Field>

      <Field label="Auth token">
        <span className="text-sm text-fg-secondary">
          {hasAuth ? 'Configured' : 'Not configured — run `claude /config` to sign in.'}
        </span>
      </Field>

      <Field
        label={`Discovered models (${modelsLoaded ? models.length : '…'})`}
        hint="Merged from settings.json, env vars, and the CLI’s built-in picker list."
      >
        {!modelsLoaded ? (
          <div className="text-sm text-fg-tertiary">Loading…</div>
        ) : models.length === 0 ? (
          <div className="text-sm text-fg-tertiary">
            No models discovered. Run <code className="font-mono text-fg-secondary">claude /config</code> to set one up.
          </div>
        ) : (
          <ul
            data-connection-models
            className="max-h-40 overflow-auto rounded-sm border border-border-subtle bg-bg-elevated divide-y divide-border-subtle"
          >
            {models.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between px-3 py-1.5 text-xs"
              >
                <span className="font-mono text-fg-primary truncate">{m.id}</span>
                <span className="text-[10px] uppercase tracking-wide text-fg-tertiary ml-2 shrink-0">
                  {m.source}
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
          {opening ? 'Opening…' : 'Open settings.json'}
        </Button>
        {openError && (
          <span className="text-xs text-state-error">{openError}</span>
        )}
      </div>
    </div>
  );
}
