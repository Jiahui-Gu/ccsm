import React, { useEffect, useState } from 'react';
import { cn } from '../lib/cn';
import { Dialog, DialogContent } from './ui/Dialog';
import { Button } from './ui/Button';
import { useStore } from '../stores/store';

type LocalUpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

type Tab = 'general' | 'autopilot' | 'account' | 'data' | 'shortcuts' | 'updates';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'autopilot', label: 'Autopilot' },
  { id: 'account', label: 'Account' },
  { id: 'data', label: 'Data' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'updates', label: 'Updates' }
];

// Shortcut catalog mirrors mvp-design.md §11. Keep in sync when adding keys.
const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: '⌘K', desc: 'Search / Command Palette' },
  { keys: '⌘,', desc: 'Settings' },
  { keys: '⌘N', desc: 'New session' },
  { keys: '⌘⇧N', desc: 'New group' },
  { keys: '⌘B', desc: 'Toggle sidebar' },
  { keys: 'Enter', desc: 'Send message' },
  { keys: '⇧Enter', desc: 'Newline in input' },
  { keys: 'Esc', desc: 'Close dialog / cancel rename' }
];

export function SettingsDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>('general');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Settings" width="720px" hideClose={false}>
        <div className="flex min-h-[380px] border-t border-border-subtle">
          <nav className="w-[160px] shrink-0 border-r border-border-subtle py-2">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'flex w-full items-center h-7 px-3 text-sm rounded-sm mx-1',
                  'transition-[background-color,color] duration-150 ease-out',
                  'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong',
                  tab === t.id
                    ? 'bg-bg-active text-fg-primary font-medium'
                    : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary'
                )}
                style={{ width: 'calc(100% - 0.5rem)' }}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex-1 min-w-0 p-5 overflow-y-auto">
            {tab === 'general' && <GeneralPane />}
            {tab === 'autopilot' && <AutopilotPane />}
            {tab === 'account' && <AccountPane />}
            {tab === 'data' && <DataPane />}
            {tab === 'shortcuts' && <ShortcutsPane />}
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

function Select<T extends string>({
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
        'focus-visible:border-border-strong focus-visible:shadow-[0_0_0_2px_oklch(0.72_0.14_215_/_0.30)]'
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

function GeneralPane() {
  const theme = useStore((s) => s.theme);
  const fontSize = useStore((s) => s.fontSize);
  const setTheme = useStore((s) => s.setTheme);
  const setFontSize = useStore((s) => s.setFontSize);
  return (
    <>
      <Field label="Theme">
        <Select
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' }
          ]}
        />
      </Field>
      <Field label="Font size" hint="Affects chat stream and sidebar">
        <Select
          value={fontSize}
          onChange={setFontSize}
          options={[
            { value: 'sm', label: 'Small (12px)' },
            { value: 'md', label: 'Medium (13px, default)' },
            { value: 'lg', label: 'Large (14px)' }
          ]}
        />
      </Field>
    </>
  );
}

function AutopilotPane() {
  const watchdog = useStore((s) => s.watchdog);
  const setWatchdog = useStore((s) => s.setWatchdog);
  const inputClass = cn(
    'w-full h-8 px-2 rounded-sm bg-bg-elevated border border-border-default',
    'text-sm text-fg-primary placeholder:text-fg-disabled outline-none',
    'focus:border-border-strong focus:shadow-[0_0_0_2px_oklch(0.72_0.14_215_/_0.30)]'
  );
  return (
    <>
      <div className="text-xs text-fg-tertiary mb-4">
        When an agent finishes a turn without saying the done token, Agentory
        will reply on your behalf so it doesn&apos;t sit idle. Capped per session
        to keep runaway loops in check.
      </div>
      <Field label="Enable autopilot" hint="Auto-reply when the agent stops without the done token.">
        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={watchdog.enabled}
            onChange={(e) => setWatchdog({ enabled: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
          <span className="text-sm text-fg-secondary">{watchdog.enabled ? 'On' : 'Off'}</span>
        </label>
      </Field>
      <Field
        label="Done token"
        hint="If the agent's last message contains this exact string, autopilot stops for the turn."
      >
        <input
          type="text"
          value={watchdog.doneToken}
          onChange={(e) => setWatchdog({ doneToken: e.target.value })}
          className={inputClass}
        />
      </Field>
      <Field
        label="Otherwise…"
        hint="Appended after '如果你真的做完了，请回复我：<token>。\\n\\n否则：' in the auto-reply."
      >
        <textarea
          value={watchdog.otherwisePostfix}
          onChange={(e) => setWatchdog({ otherwisePostfix: e.target.value })}
          rows={3}
          className={cn(inputClass, 'h-auto py-2 resize-y leading-snug')}
        />
      </Field>
      <Field
        label="Max auto-replies per session"
        hint="Resets when you send a real message. 0 = unlimited (use with care). Default 20."
      >
        <input
          type="number"
          min={0}
          value={watchdog.maxAutoReplies}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n >= 0) setWatchdog({ maxAutoReplies: n });
          }}
          className={cn(inputClass, 'w-24')}
        />
      </Field>
    </>
  );
}

function AccountPane() {
  const [key, setKey] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [encAvailable, setEncAvailable] = useState(true);

  useEffect(() => {
    const api = window.agentory;
    if (!api) {
      setLoaded(true);
      return;
    }
    Promise.all([api.getApiKey(), api.hasEncryption()]).then(([k, enc]) => {
      setKey(k);
      setEncAvailable(enc);
      setLoaded(true);
    });
  }, []);

  const save = async () => {
    const api = window.agentory;
    if (!api) return;
    const ok = await api.setApiKey(key.trim());
    setStatus(ok ? 'Saved.' : 'Failed to save (encryption unavailable).');
    setTimeout(() => setStatus(null), 2000);
  };

  return (
    <>
      <Field
        label="Anthropic API key"
        hint={
          encAvailable
            ? 'Stored in OS keychain. Required for Claude Code sessions.'
            : 'OS encryption unavailable — key cannot be saved on this system.'
        }
      >
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={loaded ? 'sk-ant-…' : 'Loading…'}
          disabled={!loaded || !encAvailable}
          className={cn(
            'w-full h-8 px-2 rounded-sm bg-bg-elevated border border-border-default',
            'text-sm font-mono text-fg-primary placeholder:text-fg-disabled outline-none',
            'focus:border-border-strong focus:shadow-[0_0_0_2px_oklch(0.72_0.14_215_/_0.30)]',
            'disabled:opacity-60 disabled:cursor-not-allowed'
          )}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="primary" size="md" onClick={save} disabled={!loaded || !encAvailable}>
          Save
        </Button>
        {status && <span className="text-xs text-fg-secondary">{status}</span>}
      </div>
    </>
  );
}

function DataPane() {
  const [dataDir, setDataDir] = useState<string>('Loading…');
  useEffect(() => {
    window.agentory?.getDataDir().then(setDataDir).catch(() => setDataDir('(unavailable)'));
  }, []);
  return (
    <>
      <Field label="Data directory" hint="Where Agentory stores groups, sessions, and preferences.">
        <code className="block px-2 py-1.5 rounded-sm bg-bg-elevated border border-border-subtle text-xs text-fg-secondary font-mono break-all">
          {dataDir}
        </code>
      </Field>
      <Field label="Claude sessions directory" hint="Read-only. Managed by Claude Code SDK.">
        <code className="block px-2 py-1.5 rounded-sm bg-bg-elevated border border-border-subtle text-xs text-fg-secondary font-mono">
          {'~/.claude/projects/'}
        </code>
      </Field>
    </>
  );
}

function ShortcutsPane() {
  return (
    <div>
      <div className="text-xs text-fg-tertiary mb-3">
        Keybindings are fixed in MVP — remapping adds maintenance burden without clear user value.
      </div>
      <ul className="divide-y divide-border-subtle">
        {SHORTCUTS.map((s) => (
          <li key={s.keys} className="flex items-center justify-between h-8 text-sm">
            <span className="text-fg-secondary">{s.desc}</span>
            <kbd className="font-mono text-xs px-1.5 py-0.5 rounded-sm border border-border-subtle bg-bg-elevated text-fg-tertiary">
              {s.keys}
            </kbd>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UpdatesPane() {
  const [version, setVersion] = useState<string>('…');
  const [status, setStatus] = useState<LocalUpdateStatus>({ kind: 'idle' });

  useEffect(() => {
    window.agentory?.getVersion().then(setVersion).catch(() => setVersion('unknown'));
    void window.agentory?.updatesStatus().then(setStatus).catch(() => {});
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

  return (
    <>
      <Field label="Version">
        <span className="text-sm text-fg-secondary font-mono">{version}</span>
      </Field>
      <Field label="Status">
        <span className="text-sm text-fg-secondary font-mono">{describeStatus(status)}</span>
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
