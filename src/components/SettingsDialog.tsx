import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '../lib/cn';
import { Dialog, DialogContent } from './ui/Dialog';
import { Button } from './ui/Button';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';
import { usePreferences } from '../store/preferences';
import {
  PERMISSION_PRESETS,
  TOOL_CATALOG,
  deriveToolState,
  parsePatternLines,
  renderEffectiveFlags,
  serializePatternLines,
  setToolState,
  validatePatterns,
  type PresetId,
  type ToolState
} from '../agent/permission-presets';
import { EMPTY_PERMISSION_RULES } from '../types';

type LocalUpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

type Tab = 'appearance' | 'memory' | 'notifications' | 'endpoints' | 'autopilot' | 'permissions' | 'data' | 'shortcuts' | 'updates';

// Tab catalog. Labels are i18n keys under `settings:tabs.*` rather than
// literal strings, so the nav re-renders when the user flips language.
const TABS: { id: Tab; tabKey: string }[] = [
  { id: 'appearance', tabKey: 'appearance' },
  { id: 'memory', tabKey: 'memory' },
  { id: 'notifications', tabKey: 'notifications' },
  { id: 'endpoints', tabKey: 'endpoints' },
  { id: 'autopilot', tabKey: 'autopilot' },
  { id: 'permissions', tabKey: 'permissions' },
  { id: 'data', tabKey: 'data' },
  { id: 'shortcuts', tabKey: 'shortcuts' },
  { id: 'updates', tabKey: 'updates' }
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
            {tab === 'memory' && <MemoryPane />}
            {tab === 'notifications' && <NotificationsPane />}
            {tab === 'endpoints' && <EndpointsPane />}
            {tab === 'autopilot' && <AutopilotPane />}
            {tab === 'permissions' && <PermissionsPane />}
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

function MemoryPane() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const active = sessions.find((s) => s.id === activeId);
  const cwd = active?.cwd ?? '';
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [userPath, setUserPath] = useState<string>('');

  useEffect(() => {
    const api = window.agentory;
    if (!api) return;
    api.memory.userPath().then(setUserPath).catch(() => setUserPath(''));
  }, []);

  useEffect(() => {
    const api = window.agentory;
    if (!api) return;
    api.memory.projectPath(cwd).then(setProjectPath).catch(() => setProjectPath(null));
  }, [cwd]);

  return (
    <div className="flex flex-col gap-5">
      <div className="text-xs text-fg-tertiary">
        CLAUDE.md files bias what the agent remembers between turns. Project
        memory travels with the repo; user memory is global to your machine.
        Writes here save directly to disk — no reload needed.
      </div>
      {projectPath ? (
        <MemoryEditor
          title="Project memory"
          hint="Committed with the repo. Visible to anyone with access to the codebase."
          path={projectPath}
        />
      ) : (
        <div className="rounded-sm border border-border-subtle bg-bg-elevated px-3 py-4 text-xs text-fg-tertiary opacity-70">
          <div className="font-medium text-fg-secondary mb-1">Project memory</div>
          Open a session to edit project memory.
        </div>
      )}
      {userPath && (
        <MemoryEditor
          title="User memory"
          hint="Applies to every session on this machine, regardless of repo."
          path={userPath}
        />
      )}
    </div>
  );
}

function MemoryEditor({
  title,
  hint,
  path,
}: {
  title: string;
  hint: string;
  path: string;
}) {
  const [content, setContent] = useState<string>('');
  const [exists, setExists] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [dirty, setDirty] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState<number>(0);

  const reload = React.useCallback(async () => {
    const api = window.agentory;
    if (!api) return;
    setLoading(true);
    setError(null);
    const res = await api.memory.read(path);
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setContent(res.content);
    setExists(res.exists);
    setDirty(false);
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = React.useCallback(async () => {
    const api = window.agentory;
    if (!api) return;
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    const res = await api.memory.write(path, content);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setExists(true);
    setDirty(false);
    setSavedTick(Date.now());
  }, [dirty, saving, path, content]);

  // Rough token estimate. For MVP we use the common length/4 heuristic —
  // the real count varies by tokenizer but is close enough for a "this
  // file is getting long" cue. If the user cares, they'll feel it.
  const estTokens = Math.ceil(content.length / 4);

  return (
    <div className="rounded-sm border border-border-subtle bg-bg-elevated">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg-primary">{title}</div>
          <div
            className="text-[11px] font-mono text-fg-tertiary truncate"
            title={path}
          >
            {path}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={cn(
              'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-sm font-mono',
              estTokens > 8000
                ? 'bg-status-warning-muted text-status-warning-foreground'
                : 'bg-bg-hover text-fg-tertiary'
            )}
            title="Rough estimate (chars / 4). Not a real tokenizer."
          >
            ~{estTokens.toLocaleString()} tok
          </span>
          {!exists && !loading && (
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                const api = window.agentory;
                if (!api) return;
                const res = await api.memory.write(path, content || '');
                if (!res.ok) setError(res.error);
                else {
                  setExists(true);
                  setDirty(false);
                }
              }}
            >
              Create
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={!dirty || saving}
            title={dirty ? 'Save' : 'No changes'}
          >
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </Button>
        </div>
      </div>
      <div className="px-3 pt-2 pb-3">
        <div className="text-[11px] text-fg-tertiary mb-1.5">{hint}</div>
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
          }}
          onBlur={() => void save()}
          disabled={loading}
          spellCheck={false}
          rows={10}
          placeholder={exists ? '' : 'This file will be created on save.'}
          className={cn(
            'w-full px-2.5 py-2 rounded-sm bg-bg-panel border border-border-default',
            'text-xs font-mono leading-relaxed text-fg-primary placeholder:text-fg-disabled',
            'outline-none resize-y',
            'focus:border-border-strong focus:shadow-[0_0_0_2px_var(--color-focus-ring)]',
            'disabled:opacity-60 disabled:cursor-progress'
          )}
        />
        <div className="flex items-center justify-between mt-1.5 h-4">
          <span className="text-[11px] text-fg-tertiary">
            {loading
              ? 'Loading…'
              : error
              ? <span className="text-status-error-foreground">{error}</span>
              : !exists
              ? 'Not yet created on disk.'
              : dirty
              ? 'Unsaved changes.'
              : savedTick > 0
              ? 'Saved.'
              : ''}
          </span>
          <span className="text-[11px] text-fg-tertiary tabular-nums">
            {content.length.toLocaleString()} chars
          </span>
        </div>
      </div>
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

function AutopilotPane() {
  const watchdog = useStore((s) => s.watchdog);
  const setWatchdog = useStore((s) => s.setWatchdog);
  const inputClass = cn(
    'w-full h-8 px-2 rounded-sm bg-bg-elevated border border-border-default',
    'text-sm text-fg-primary placeholder:text-fg-disabled outline-none',
    'focus:border-border-strong focus:shadow-[0_0_0_2px_var(--color-focus-ring)]'
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

function PermissionsPane() {
  const permission = useStore((s) => s.permission);
  const rules = useStore((s) => s.permissionRules);
  const setPermissionRules = useStore((s) => s.setPermissionRules);
  const resetPermissionRules = useStore((s) => s.resetPermissionRules);

  const [showPatterns, setShowPatterns] = useState(false);
  // Textareas are local-state-driven for responsive typing; we commit to the
  // store on blur (or when validation passes on every keystroke — trivial).
  const [allowText, setAllowText] = useState('');
  const [denyText, setDenyText] = useState('');

  // Sync local textarea state with store rules. Scoped patterns (Tool(...))
  // live in the textareas; bare tool entries are driven by the table above.
  useEffect(() => {
    const scopedAllow = rules.allowedTools.filter((p) => p.includes('('));
    const scopedDeny = rules.disallowedTools.filter((p) => p.includes('('));
    setAllowText(serializePatternLines(scopedAllow));
    setDenyText(serializePatternLines(scopedDeny));
    if (scopedAllow.length > 0 || scopedDeny.length > 0) setShowPatterns(true);
  }, [rules]);

  // Detect which preset the current rules correspond to, for the radio's
  // "checked" highlight. Falls through to `custom` whenever the exact sets
  // don't match a known preset.
  const activePresetId: PresetId = useMemo(() => {
    for (const p of PERMISSION_PRESETS) {
      if (p.id === 'custom') continue;
      if (arraysEqualSet(p.rules.allowedTools, rules.allowedTools) &&
          arraysEqualSet(p.rules.disallowedTools, rules.disallowedTools)) {
        return p.id;
      }
    }
    return 'custom';
  }, [rules]);

  const applyPreset = (id: PresetId) => {
    if (id === 'custom') {
      // Custom = leave rules as-is; it's the user's edit surface.
      return;
    }
    const preset = PERMISSION_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setPermissionRules({
      allowedTools: [...preset.rules.allowedTools],
      disallowedTools: [...preset.rules.disallowedTools]
    });
  };

  const onToolStateChange = (tool: string, state: ToolState) => {
    const next = setToolState(rules, tool, state);
    setPermissionRules(next);
  };

  const commitPatterns = () => {
    const allowScoped = parsePatternLines(allowText);
    const denyScoped = parsePatternLines(denyText);
    const val = validatePatterns([...allowScoped, ...denyScoped]);
    if (!val.ok) return; // keep the user's text; errors shown inline
    // Keep bare-tool entries from the table; replace scoped entries.
    const bareAllow = rules.allowedTools.filter((p) => !p.includes('('));
    const bareDeny = rules.disallowedTools.filter((p) => !p.includes('('));
    setPermissionRules({
      allowedTools: [...bareAllow, ...allowScoped],
      disallowedTools: [...bareDeny, ...denyScoped]
    });
  };

  const validation = useMemo(
    () => validatePatterns([...parsePatternLines(allowText), ...parsePatternLines(denyText)]),
    [allowText, denyText]
  );

  const effective = useMemo(
    () => renderEffectiveFlags(permission, rules),
    [permission, rules]
  );

  return (
    <div data-perm-pane>
      <div className="text-xs text-fg-tertiary mb-4 max-w-[520px]">
        Per-tool rules layer on top of the permission mode in the sidebar. They
        map 1:1 to claude.exe&apos;s <code className="font-mono text-fg-secondary">--allowedTools</code> /{' '}
        <code className="font-mono text-fg-secondary">--disallowedTools</code> flags
        and apply to new sessions. Running sessions keep whatever rules they
        were started with.
      </div>

      <Field label="Preset">
        <div className="flex flex-wrap gap-2" data-perm-presets>
          {PERMISSION_PRESETS.map((p) => {
            const active = activePresetId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                data-preset={p.id}
                onClick={() => applyPreset(p.id)}
                title={p.description}
                className={cn(
                  'h-7 px-3 rounded-sm text-xs border select-none',
                  'transition-[background-color,border-color,color] duration-150 ease-out',
                  'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong',
                  active
                    ? 'bg-accent/15 border-accent/50 text-accent font-medium'
                    : 'bg-bg-elevated border-border-default text-fg-secondary hover:bg-bg-hover hover:text-fg-primary hover:border-border-strong active:bg-bg-active'
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Per-tool rules" hint="Allow = auto-approve. Deny = always block. Ask = follow the permission mode.">
        <div
          className="rounded-sm border border-border-subtle bg-bg-elevated divide-y divide-border-subtle"
          data-perm-table
        >
          {TOOL_CATALOG.map((tool) => {
            const state = deriveToolState(rules, tool);
            return (
              <div key={tool} className="flex items-center justify-between h-8 px-3">
                <span className="font-mono text-xs text-fg-primary">{tool}</span>
                <ThreeStateRadio
                  value={state}
                  onChange={(v) => onToolStateChange(tool, v)}
                  tool={tool}
                />
              </div>
            );
          })}
        </div>
      </Field>

      <details
        open={showPatterns}
        onToggle={(e) => setShowPatterns(e.currentTarget.open)}
        className="mb-5"
      >
        <summary className="cursor-pointer select-none text-sm font-medium text-fg-primary py-1 outline-none focus-visible:ring-1 focus-visible:ring-border-strong rounded-sm">
          Pattern overrides
        </summary>
        <div className="text-xs text-fg-tertiary mt-1 mb-2">
          One pattern per line. Examples:{' '}
          <code className="font-mono text-fg-secondary">Bash(git:*)</code>,{' '}
          <code className="font-mono text-fg-secondary">Read(**/*.secret)</code>.
          Patterns from the table above override these on conflict.
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs text-fg-tertiary mb-1">Allow patterns</span>
            <textarea
              value={allowText}
              onChange={(e) => setAllowText(e.target.value)}
              onBlur={commitPatterns}
              rows={5}
              spellCheck={false}
              placeholder={'Bash(git:*)\nRead(**/*.md)'}
              data-perm-allow-patterns
              className={cn(
                'w-full px-2 py-1.5 rounded-sm bg-bg-elevated border border-border-default',
                'text-xs font-mono text-fg-primary placeholder:text-fg-disabled outline-none',
                'focus:border-border-strong focus:shadow-[0_0_0_2px_var(--color-focus-ring)]',
                'resize-y leading-snug'
              )}
            />
          </label>
          <label className="block">
            <span className="block text-xs text-fg-tertiary mb-1">Deny patterns</span>
            <textarea
              value={denyText}
              onChange={(e) => setDenyText(e.target.value)}
              onBlur={commitPatterns}
              rows={5}
              spellCheck={false}
              placeholder={'Bash(rm:*)\nWrite(**/.env*)'}
              data-perm-deny-patterns
              className={cn(
                'w-full px-2 py-1.5 rounded-sm bg-bg-elevated border border-border-default',
                'text-xs font-mono text-fg-primary placeholder:text-fg-disabled outline-none',
                'focus:border-border-strong focus:shadow-[0_0_0_2px_var(--color-focus-ring)]',
                'resize-y leading-snug'
              )}
            />
          </label>
        </div>
        {!validation.ok && (
          <ul className="mt-2 text-xs text-state-error list-disc list-inside">
            {validation.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </details>

      <Field label="Effective CLI flags" hint="What Agentory will pass to claude.exe on the next spawn.">
        <code
          data-perm-effective
          className="block px-2 py-1.5 rounded-sm bg-bg-elevated border border-border-subtle text-[11px] text-fg-secondary font-mono break-all whitespace-pre-wrap"
        >
          {effective}
        </code>
      </Field>

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="md"
          onClick={() => {
            resetPermissionRules();
            setAllowText('');
            setDenyText('');
          }}
          disabled={
            rules.allowedTools.length === 0 && rules.disallowedTools.length === 0
          }
          data-perm-reset
        >
          Reset to mode defaults
        </Button>
      </div>
    </div>
  );
}

function ThreeStateRadio({
  value,
  onChange,
  tool
}: {
  value: ToolState;
  onChange: (v: ToolState) => void;
  tool: string;
}) {
  const options: { value: ToolState; label: string }[] = [
    { value: 'allow', label: 'Allow' },
    { value: 'ask', label: 'Ask' },
    { value: 'deny', label: 'Deny' }
  ];
  return (
    <div
      role="radiogroup"
      aria-label={`${tool} permission`}
      className="inline-flex rounded-sm border border-border-default bg-bg-elevated p-0.5"
      data-perm-tool-row={tool}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-perm-tool-state={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-6 px-2.5 rounded-sm text-[11px] font-medium select-none',
              'transition-[background-color,color] duration-120 ease-out',
              'outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-strong',
              active
                ? o.value === 'allow'
                  ? 'bg-state-success/20 text-state-success'
                  : o.value === 'deny'
                  ? 'bg-state-error/20 text-state-error'
                  : 'bg-bg-active text-fg-primary'
                : 'text-fg-tertiary hover:bg-bg-hover hover:text-fg-primary active:bg-bg-active'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function arraysEqualSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  for (const x of b) if (!seen.has(x)) return false;
  return true;
}

// Prevent "unused import" on EMPTY_PERMISSION_RULES — referenced indirectly by
// resetPermissionRules() but kept visible so a future PR that wants to diff
// against "known empty" doesn't have to hunt. Pure doc aid; no behavior.
void EMPTY_PERMISSION_RULES;

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

function relativeTime(ts: number | null): string {
  if (!ts) return 'never';
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
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
const KIND_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  'openai-compat': 'OpenAI-compat',
  ollama: 'Ollama',
  bedrock: 'Bedrock',
  vertex: 'Vertex',
  unknown: 'Unknown',
};

function KindBadge({ kind }: { kind: string | null }) {
  if (!kind) return null;
  const label = KIND_LABEL[kind] ?? kind;
  return (
    <span
      className="text-[10px] uppercase tracking-wide px-1 rounded-sm bg-bg-hover text-fg-secondary"
      title={`Detected endpoint kind: ${label}`}
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
  const parts: string[] = [];
  if (counts.listed) parts.push(`${counts.listed} listed`);
  if (counts.cliPicker) parts.push(`${counts.cliPicker} CLI picker`);
  if (counts.envOverride) parts.push(`${counts.envOverride} env override`);
  if (counts.fallback) parts.push(`${counts.fallback} fallback`);
  if (counts.manual) parts.push(`${counts.manual} manual`);
  const tooltip = parts.length ? parts.join(' \u00B7 ') : 'no discovery data yet';
  return (
    <span title={tooltip} className="cursor-help">
      {total} model{total === 1 ? '' : 's'}
    </span>
  );
}

function EndpointsPane() {
  const endpoints = useStore((s) => s.endpoints);
  const modelsByEndpoint = useStore((s) => s.modelsByEndpoint);
  const endpointsLoaded = useStore((s) => s.endpointsLoaded);
  const reloadEndpoints = useStore((s) => s.reloadEndpoints);
  const refreshEndpointModels = useStore((s) => s.refreshEndpointModels);

  const [editor, setEditor] = useState<EditingEndpoint | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRefresh(id: string) {
    setRefreshingId(id);
    setError(null);
    const res = await refreshEndpointModels(id);
    setRefreshingId(null);
    if (!res.ok) setError(res.error ?? 'Refresh failed');
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
          Agentory talks to any server that speaks the Anthropic REST API:
          anthropic.com, a self-hosted gateway, or a LiteLLM / Kimi / DeepSeek
          shim. Add one here and Agentory will discover its models via
          <code className="font-mono text-fg-secondary mx-1">GET /v1/models</code>.
        </div>
        <Button variant="primary" size="md" onClick={() => setEditor(emptyEditor())}>
          Add endpoint
        </Button>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-sm border border-state-error/40 bg-state-error/10 text-xs text-state-error">
          {error}
        </div>
      )}

      {!endpointsLoaded ? (
        <div className="text-sm text-fg-tertiary">Loading endpoints…</div>
      ) : endpoints.length === 0 ? (
        <div className="text-sm text-fg-tertiary">
          No endpoints yet. Click &quot;Add endpoint&quot; to point Agentory at Anthropic
          or your own gateway.
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
                        default
                      </span>
                    )}
                    <StatusBadge status={e.lastStatus} />
                    <KindBadge kind={e.detectedKind ?? e.kind} />
                  </div>
                  <div className="text-[11px] font-mono text-fg-tertiary truncate" title={e.baseUrl}>
                    {e.baseUrl}
                  </div>
                  <div className="text-[11px] text-fg-tertiary mt-0.5">
                    <SourceBreakdown counts={counts} total={models.length} /> · refreshed{' '}
                    {relativeTime(e.lastRefreshedAt)}
                    {e.lastRefreshedAt ? ' (cached)' : ''}
                  </div>
                  {is401 && (
                    <div className="mt-1.5 px-2 py-1 rounded-sm border border-state-error/40 bg-state-error/10 text-[11px] text-state-error">
                      Auth failed — check your API key for this endpoint.
                    </div>
                  )}
                  {noneFound && (
                    <div className="mt-1.5 px-2 py-1 rounded-sm border border-state-warning/40 bg-state-warning/10 text-[11px] text-fg-secondary">
                      Could not auto-discover any models. Edit this endpoint and add manual model IDs below.
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
                    {refreshingId === e.id ? 'Refreshing…' : 'Refresh models'}
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
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      if (window.confirm(`Remove endpoint "${e.name}"?`)) void onRemove(e.id);
                    }}
                  >
                    Remove
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
  const cls =
    status === 'ok'
      ? 'bg-state-success/15 text-state-success'
      : status === 'error'
      ? 'bg-state-error/15 text-state-error'
      : 'bg-bg-hover text-fg-tertiary';
  const label = status === 'ok' ? 'connected' : status === 'error' ? 'error' : 'unchecked';
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
      <DialogContent title={isEdit ? 'Edit endpoint' : 'Add endpoint'} width="520px">
        <div className="px-5 pb-4">
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Anthropic, My LiteLLM"
              className={inputClass}
              autoFocus
            />
          </Field>
          <Field label="Base URL" hint="Agentory appends /v1/models. Paste the root or include /v1.">
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.anthropic.com"
              className={cn(inputClass, 'font-mono')}
            />
          </Field>
          <Field label="Protocol">
            <div className="flex items-center gap-3 text-sm">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="radio" checked readOnly className="accent-accent" />
                <span className="text-fg-primary">Anthropic</span>
              </label>
              <label
                title="Phase 2 — not yet supported"
                className="inline-flex items-center gap-1.5 opacity-50 cursor-not-allowed"
              >
                <input type="radio" disabled className="accent-accent" />
                <span>OpenAI-compatible</span>
              </label>
              <label
                title="Phase 2 — not yet supported"
                className="inline-flex items-center gap-1.5 opacity-50 cursor-not-allowed"
              >
                <input type="radio" disabled className="accent-accent" />
                <span>Ollama</span>
              </label>
            </div>
          </Field>
          <Field
            label="API key (optional)"
            hint={
              value.hasExistingKey
                ? 'Leave blank to keep the existing key.'
                : 'Optional \u2014 leave blank if your endpoint does not require authentication.'
            }
          >
            <div className="flex items-center gap-2">
              <input
                type={revealKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={value.hasExistingKey ? '••••••• (unchanged)' : 'sk-ant-…'}
                className={cn(inputClass, 'font-mono')}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRevealKey((r) => !r)}
                aria-label={revealKey ? 'Hide key' : 'Reveal key'}
              >
                {revealKey ? 'Hide' : 'Show'}
              </Button>
            </div>
          </Field>
          <Field label="Default endpoint" hint="Used for new sessions that don't pick one.">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              <span className="text-sm text-fg-secondary">Make default</span>
            </label>
          </Field>
          <Field
            label="Manual model IDs"
            hint="Optional. One ID per line (or comma-separated). Used as additional model picks alongside whatever claude.exe reports — IDs that aren't in claude's catalogue are still kept in the picker, marked unverified."
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
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            {testResult === 'ok' && (
              <span className="text-xs text-state-success">Connected.</span>
            )}
            {testResult && testResult !== 'ok' && (
              <span className="text-xs text-state-error">{testResult}</span>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle">
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={onSave}
            disabled={
              !name.trim() || !baseUrl.trim() || saving
            }
          >
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Add'}
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
