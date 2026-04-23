import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Hash, Settings, Plus, FolderPlus, PanelLeft, SunMoon, DownloadCloud } from 'lucide-react';
import { cn } from '../lib/cn';
import { Dialog, DialogPortal, DialogOverlay } from './ui/Dialog';
import * as RD from '@radix-ui/react-dialog';
import { AgentIcon } from './AgentIcon';
import { useStore } from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';
import { useFocusRestore } from '../lib/useFocusRestore';

type ResultKind = 'session' | 'group' | 'command';

type Result = {
  id: string;
  kind: ResultKind;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  onPick: () => void;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSettings?: () => void;
  onNewSession?: () => void;
  onOpenImport?: () => void;
  onSelectSession?: (id: string) => void;
  onFocusGroup?: (id: string) => void;
};

export function CommandPalette({
  open,
  onOpenChange,
  onOpenSettings,
  onNewSession,
  onOpenImport,
  onSelectSession,
  onFocusGroup
}: Props) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sessions = useStore((s) => s.sessions);
  const groups = useStore((s) => s.groups);
  const createGroup = useStore((s) => s.createGroup);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  // a11y: palette is opened via Cmd+K (no Radix Trigger), so restore focus
  // to whatever had it before the palette intercepted. Falls back to the
  // active session row in the sidebar.
  const { handleCloseAutoFocus } = useFocusRestore(open, {
    fallbackSelector: '[data-session-id][aria-selected="true"], [data-session-id][tabindex="0"]'
  });

  const results: Result[] = useMemo(() => {
    const nextTheme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    const all: Result[] = [
      ...sessions.map<Result>((s) => ({
        id: `session:${s.id}`,
        kind: 'session',
        label: s.name,
        hint: s.cwd,
        icon: <AgentIcon agentType={s.agentType} state={s.state} size="sm" />,
        onPick: () => {
          onOpenChange(false);
          onSelectSession?.(s.id);
        }
      })),
      ...groups
        .filter((g) => g.kind === 'normal')
        .map<Result>((g) => ({
          id: `group:${g.id}`,
          kind: 'group',
          label: g.name,
          hint: t('commandPalette.groupHint'),
          icon: <Hash size={13} className="stroke-[1.75] text-fg-tertiary" />,
          onPick: () => {
            onOpenChange(false);
            onFocusGroup?.(g.id);
          }
        })),
      {
        id: 'cmd:new-session',
        kind: 'command',
        label: t('commandPalette.cmdNewSession'),
        hint: '⌘N',
        icon: <Plus size={13} className="stroke-[1.75] text-fg-tertiary" />,
        onPick: () => {
          onOpenChange(false);
          onNewSession?.();
        }
      },
      {
        id: 'cmd:new-group',
        kind: 'command',
        label: t('commandPalette.cmdNewGroup'),
        hint: '⌘⇧N',
        icon: <FolderPlus size={13} className="stroke-[1.75] text-fg-tertiary" />,
        onPick: () => {
          onOpenChange(false);
          createGroup();
        }
      },
      {
        id: 'cmd:toggle-sidebar',
        kind: 'command',
        label: t('commandPalette.cmdToggleSidebar'),
        hint: '⌘B',
        icon: <PanelLeft size={13} className="stroke-[1.75] text-fg-tertiary" />,
        onPick: () => {
          onOpenChange(false);
          toggleSidebar();
        }
      },
      {
        id: 'cmd:import',
        kind: 'command',
        label: t('commandPalette.cmdImport'),
        icon: <DownloadCloud size={13} className="stroke-[1.75] text-fg-tertiary" />,
        onPick: () => {
          onOpenChange(false);
          onOpenImport?.();
        }
      },
      {
        id: 'cmd:open-settings',
        kind: 'command',
        label: t('commandPalette.cmdOpenSettings'),
        hint: '⌘,',
        icon: <Settings size={13} className="stroke-[1.75] text-fg-tertiary" />,
        onPick: () => {
          onOpenChange(false);
          onOpenSettings?.();
        }
      },
      {
        id: 'cmd:switch-theme',
        kind: 'command',
        label: t('commandPalette.cmdSwitchTheme', { next: nextTheme }),
        icon: <SunMoon size={13} className="stroke-[1.75] text-fg-tertiary" />,
        onPick: () => {
          onOpenChange(false);
          setTheme(nextTheme);
        }
      }
    ];
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return all.filter(
      (r) => r.label.toLowerCase().includes(needle) || r.hint?.toLowerCase().includes(needle)
    );
  }, [q, sessions, groups, theme, onOpenChange, onNewSession, onOpenSettings, onSelectSession, onFocusGroup, createGroup, toggleSidebar, setTheme, onOpenImport, t]);

  const hasQuery = q.trim().length > 0;

  useEffect(() => {
    if (active >= results.length) setActive(0);
  }, [results.length, active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[active]?.onPick();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <RD.Content
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => {
            // Let Radix's FocusScope own the focus handoff (so it knows
            // which element to release on close), but redirect it to our
            // search input instead of the first tabbable.
            e.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={handleCloseAutoFocus}
          className={cn(
            'fixed left-1/2 top-[18%] z-50 -translate-x-1/2 w-[calc(100vw-2rem)] max-w-xl',
            'rounded-lg border border-border-default bg-bg-panel',
            'surface-highlight',
            'shadow-[var(--surface-shadow)]',
            'outline-none',
            'data-[state=open]:animate-[dialogIn_200ms_cubic-bezier(0.32,0.72,0,1)]',
            'data-[state=closed]:opacity-0'
          )}
        >
          <RD.Title className="sr-only">{t('commandPalette.title')}</RD.Title>
          <div className="flex items-center gap-2 px-3 h-11 border-b border-border-subtle">
            <Search size={14} className="stroke-[1.5] text-fg-tertiary shrink-0" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('commandPalette.searchPlaceholder')}
              className={cn(
                'flex-1 bg-transparent text-base text-fg-primary placeholder:text-fg-tertiary',
                'outline-none'
              )}
            />
            <kbd className="font-mono text-xs px-1.5 py-0.5 rounded-sm border border-border-subtle bg-bg-elevated text-fg-tertiary">
              {t('commandPalette.escKey')}
            </kbd>
          </div>
          <ul className="max-h-[340px] overflow-y-auto py-1" role="listbox">
            {!hasQuery && (
              <li className="px-4 py-6 text-center text-sm text-fg-tertiary">{t('commandPalette.emptyHint')}</li>
            )}
            {hasQuery && results.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-fg-tertiary">{t('commandPalette.noMatches')}</li>
            )}
            {hasQuery &&
              results.map((r, i) => (
                <li
                  key={r.id}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => r.onPick()}
                  className={cn(
                    'flex items-center gap-2.5 h-8 px-3 mx-1 rounded-sm cursor-pointer',
                    'text-sm',
                    i === active
                      ? 'bg-bg-hover text-fg-primary surface-highlight'
                      : 'text-fg-secondary'
                  )}
                >
                  <span className="shrink-0 inline-flex w-4 justify-center">{r.icon}</span>
                  <span className="flex-1 min-w-0 truncate">{r.label}</span>
                  {r.hint && (
                    <span className="text-xs text-fg-disabled font-mono tabular-nums truncate max-w-[180px]">
                      {r.hint}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </RD.Content>
      </DialogPortal>
    </Dialog>
  );
}
