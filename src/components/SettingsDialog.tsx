import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import * as RD from '@radix-ui/react-dialog';
import { cn } from '../lib/cn';
import { Dialog, DialogContent } from './ui/Dialog';
import { useTranslation } from '../i18n/useTranslation';
import { useFocusRestore } from '../lib/useFocusRestore';
import { DURATION_RAW, EASING } from '../lib/motion';
import { AppearancePane } from './settings/AppearancePane';
import { NotificationsPane } from './settings/NotificationsPane';
import { UpdatesPane } from './settings/UpdatesPane';

type Tab = 'appearance' | 'notifications' | 'updates';

// Tab catalog. Labels are i18n keys under `settings:tabs.*` rather than
// literal strings, so the nav re-renders when the user flips language.
const TABS: { id: Tab; tabKey: string }[] = [
  { id: 'appearance', tabKey: 'appearance' },
  { id: 'notifications', tabKey: 'notifications' },
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

  // Sync the tab when the dialog is reopened with a fresh initialTab.
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  // Defensive Escape handler. On Electron 41 macOS the Radix DismissableLayer
  // Esc handler intermittently misses the keydown when the focused element at
  // open time is `<body>` (e.g. dialog opened via the Cmd+, global shortcut
  // rather than a Radix Trigger). The window-level capture-phase listener
  // below mirrors what Radix does internally so close is deterministic across
  // all entry points / platforms after the Electron 33→41 bump (PR #582).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onOpenChange]);

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
  // announce the current tab and total count.
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    appearance: null,
    notifications: null,
    updates: null
  });
  const tabIds: Record<Tab, string> = {
    appearance: 'settings-tab-appearance',
    notifications: 'settings-tab-notifications',
    updates: 'settings-tab-updates'
  };
  const panelIds: Record<Tab, string> = {
    appearance: 'settings-panel-appearance',
    notifications: 'settings-panel-notifications',
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
      focusTab(order[(idx + 1) % order.length]!);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      focusTab(order[(idx - 1 + order.length) % order.length]!);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusTab(order[0]!);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusTab(order[order.length - 1]!);
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
            {tab === 'updates' && <UpdatesPane />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
