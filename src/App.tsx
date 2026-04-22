import React, { useEffect, useMemo } from 'react';
import { Plus, Download } from 'lucide-react';
import { TooltipProvider } from './components/ui/Tooltip';
import { ToastProvider, useToast } from './components/ui/Toast';
import { Button } from './components/ui/Button';
import { Sidebar } from './components/Sidebar';
import { AppShell } from './components/AppShell';
import { ChatStream } from './components/ChatStream';
import { InputBar } from './components/InputBar';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { CommandPalette } from './components/CommandPalette';
import { ImportDialog } from './components/ImportDialog';
import { PrFlowProvider } from './components/PrFlowProvider';
import { DragRegion, WindowControls } from './components/WindowControls';
import { Tutorial } from './components/Tutorial';
import { ClaudeCliMissingDialog } from './components/ClaudeCliMissingDialog';
import { ClaudeCliMissingBanner } from './components/ClaudeCliMissingBanner';
import { useStore } from './stores/store';
import { resolveEffectiveTheme } from './stores/store';
import { setPersistErrorHandler } from './stores/persist';
import { subscribeAgentEvents, setBackgroundWaitingHandler } from './agent/lifecycle';
import { setOpenSettingsListener, type SettingsTab } from './slash-commands/ui-bridge';
import { initI18n } from './i18n';
import { usePreferences } from './store/preferences';

// Initialise i18next once, before any component renders. Subsequent
// language changes flow through `applyLanguage` (called by the store
// setter in src/store/preferences.ts).
initI18n(usePreferences.getState().resolvedLanguage);

subscribeAgentEvents();

if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
  (window as unknown as { __agentoryStore?: typeof useStore }).__agentoryStore = useStore;
}

export default function App() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const focusedGroupId = useStore((s) => s.focusedGroupId);
  const model = useStore((s) => s.model);
  const permission = useStore((s) => s.permission);

  const selectSession = useStore((s) => s.selectSession);
  const focusGroup = useStore((s) => s.focusGroup);
  const moveSession = useStore((s) => s.moveSession);
  const createGroup = useStore((s) => s.createGroup);
  const createSession = useStore((s) => s.createSession);
  const changeCwd = useStore((s) => s.changeCwd);
  const pushRecentProject = useStore((s) => s.pushRecentProject);
  const setModel = useStore((s) => s.setModel);
  const setPermission = useStore((s) => s.setPermission);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const theme = useStore((s) => s.theme);
  const fontSizePx = useStore((s) => s.fontSizePx);
  const density = useStore((s) => s.density);
  const tutorialSeen = useStore((s) => s.tutorialSeen);
  const markTutorialSeen = useStore((s) => s.markTutorialSeen);
  const checkCli = useStore((s) => s.checkCli);

  useEffect(() => {
    void checkCli();
  }, [checkCli]);

  // Theme application — reactive to both the user's explicit choice AND, when
  // the choice is `system`, the OS theme. We set BOTH `.dark` (historical,
  // still referenced by legacy Tailwind variants) AND `.theme-light` (new,
  // drives the light palette overrides in global.css). The mutual exclusion
  // keeps the `html.theme-light` selector unambiguous — no `.dark.theme-light`
  // combo will ever exist.
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const osPrefersDark =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      const effective = resolveEffectiveTheme(theme, osPrefersDark);
      root.classList.toggle('dark', effective === 'dark');
      root.classList.toggle('theme-light', effective === 'light');
      root.dataset.theme = effective;
    };
    apply();
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // Font size slider applies via CSS variable on <html>. Child text utilities
  // honor this transitively through `font-size: var(--app-font-size)` on
  // html/body. Explicit px overrides in components (e.g. text-[11px] labels)
  // intentionally do NOT scale — those are information-density callouts the
  // user's "body font size" shouldn't affect.
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${fontSizePx}px`);
  }, [fontSizePx]);

  // Density class on <html>. Components consume `--density-scale` via
  // .density-row / inline calc() — see global.css.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('density-compact', 'density-normal', 'density-comfortable');
    root.classList.add(`density-${density}`);
  }, [density]);

  // Locale: ask main for the OS locale, feed it into the preferences store
  // so a "system" preference resolves correctly. Falls back to navigator.
  // Then mirror the resolved language to main so OS notifications match.
  const hydrateSystemLocale = usePreferences((s) => s.hydrateSystemLocale);
  const resolvedLanguage = usePreferences((s) => s.resolvedLanguage);
  useEffect(() => {
    let cancelled = false;
    type Bridge = {
      i18n?: {
        getSystemLocale: () => Promise<string | undefined>;
        setLanguage: (l: 'en' | 'zh') => void;
      };
    };
    const bridge = (window as unknown as { agentory?: Bridge }).agentory;
    void (async () => {
      let locale: string | undefined;
      try {
        locale = await bridge?.i18n?.getSystemLocale();
      } catch {
        locale = undefined;
      }
      if (cancelled) return;
      hydrateSystemLocale(
        locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined)
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrateSystemLocale]);
  useEffect(() => {
    type Bridge = { i18n?: { setLanguage: (l: 'en' | 'zh') => void } };
    const bridge = (window as unknown as { agentory?: Bridge }).agentory;
    bridge?.i18n?.setLanguage(resolvedLanguage);
  }, [resolvedLanguage]);

  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<SettingsTab | undefined>(undefined);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);

  // New sessions are created in-place — no modal. The store seeds `cwd`
  // from `recentProjects[0]?.path ?? '~'`; users repick later via the
  // StatusBar cwd chip in chat. See createSession() in stores/store.ts.
  const newSession = React.useCallback(() => {
    createSession(null);
  }, [createSession]);

  // Bridge from the slash-command handlers (`/config`, `/model`) into the
  // local Settings open state.
  useEffect(() => {
    setOpenSettingsListener((tab) => {
      setSettingsTab(tab);
      setSettingsOpen(true);
    });
    return () => setOpenSettingsListener(null);
  }, []);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? sessions[0],
    [sessions, activeId]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k' && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((p) => !p);
      } else if (k === 'b' && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (k === 'n' && e.shiftKey) {
        e.preventDefault();
        const id = createGroup();
        focusGroup(id);
      } else if (k === 'n') {
        e.preventDefault();
        newSession();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createGroup, focusGroup, toggleSidebar, newSession]);

  if (!active) {
    return (
      <TooltipProvider delayDuration={400} skipDelayDuration={100}>
        <ToastProvider>
          <PersistErrorBridge />
          <BackgroundWaitingBridge />
          <UpdateDownloadedBridge />
          <AppShell
            sidebar={
              <Sidebar
                onCreateSession={newSession}
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenPalette={() => setPaletteOpen(true)}
                activeSessionId={activeId}
                focusedGroupId={focusedGroupId}
                onSelectSession={selectSession}
                onFocusGroup={focusGroup}
                sessions={sessions}
                onMoveSession={moveSession}
              />
            }
            main={
              <main className="flex-1 flex flex-col min-w-0 right-pane-frame relative">
                <DragRegion className="relative flex items-center justify-end shrink-0" style={{ height: 32 }}>
                  <WindowControls />
                </DragRegion>
                <ClaudeCliMissingBanner />
                <div className="flex-1 flex items-center justify-center min-h-0">
                  {tutorialSeen ? (
                    <div className="flex items-center gap-3">
                      <Button
                        variant="secondary"
                        size="md"
                        onClick={newSession}
                        className="w-44 justify-center"
                      >
                        <Plus size={14} className="stroke-[2]" />
                        <span>New Session</span>
                      </Button>
                      <Button
                        variant="secondary"
                        size="md"
                        onClick={() => setImportOpen(true)}
                        className="w-44 justify-center"
                      >
                        <Download size={14} className="stroke-[2]" />
                        <span>Import Session</span>
                      </Button>
                    </div>
                  ) : (
                    <Tutorial
                      onNewSession={() => {
                        markTutorialSeen();
                        newSession();
                      }}
                      onImport={() => {
                        markTutorialSeen();
                        setImportOpen(true);
                      }}
                      onSkip={markTutorialSeen}
                    />
                  )}
                </div>
              </main>
            }
          />
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialTab={settingsTab} />
          <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
          <ClaudeCliMissingDialog />
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            onOpenSettings={() => setSettingsOpen(true)}
            onNewSession={newSession}
            onOpenImport={() => setImportOpen(true)}
            onSelectSession={selectSession}
            onFocusGroup={focusGroup}
          />
        </ToastProvider>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={100}>
      <ToastProvider>
        <PersistErrorBridge />
        <BackgroundWaitingBridge />
        <UpdateDownloadedBridge />
        <AppShell
          sidebar={
            <Sidebar
              onCreateSession={newSession}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenPalette={() => setPaletteOpen(true)}
              activeSessionId={activeId}
              focusedGroupId={focusedGroupId}
              onSelectSession={selectSession}
              onFocusGroup={focusGroup}
              sessions={sessions}
              onMoveSession={moveSession}
            />
          }
          main={
            <main className="flex-1 flex flex-col min-w-0 right-pane-frame relative">
              <DragRegion className="relative flex items-center justify-end shrink-0" style={{ height: 32 }}>
                <WindowControls />
              </DragRegion>
              <ClaudeCliMissingBanner />
              <ChatStream />
              <StatusBar
                cwd={active.cwd}
                model={active.model || model}
                permission={permission}
                onChangeCwd={async (p) => {
                  let next = p;
                  if (next === null) {
                    next = (await window.agentory?.pickDirectory()) ?? null;
                  }
                  if (!next) return;
                  changeCwd(next);
                  pushRecentProject(next);
                }}
                onChangeModel={setModel}
                onChangePermission={setPermission}
              />
              <InputBar sessionId={active.id} />
              <div className="px-4 pb-2 font-mono text-xs text-fg-disabled select-none">
                <span>Enter send · Shift+Enter newline</span>
              </div>
            </main>
          }
        />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialTab={settingsTab} />
        <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
        <ClaudeCliMissingDialog />
        <PrFlowProvider />
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onOpenSettings={() => setSettingsOpen(true)}
          onNewSession={newSession}
          onOpenImport={() => setImportOpen(true)}
          onSelectSession={selectSession}
          onFocusGroup={focusGroup}
        />
      </ToastProvider>
    </TooltipProvider>
  );
}

function PersistErrorBridge() {
  const { push } = useToast();
  useEffect(() => {
    let lastShown = 0;
    setPersistErrorHandler(() => {
      const now = Date.now();
      if (now - lastShown < 5000) return;
      lastShown = now;
      push({
        kind: 'error',
        title: 'Failed to save state',
        body: 'Your recent changes may not survive restart. Check disk space.'
      });
    });
    return () => setPersistErrorHandler(() => {});
  }, [push]);
  return null;
}

function BackgroundWaitingBridge() {
  const { push } = useToast();
  const selectSession = useStore((s) => s.selectSession);
  useEffect(() => {
    setBackgroundWaitingHandler((info) => {
      push({
        kind: 'waiting',
        title: `${info.sessionName} needs your input`,
        body: info.prompt
      });
      // The toast is fire-and-forget; we deliberately do NOT auto-jump on
      // click here because the dismiss-on-click in Toast.tsx and a
      // separate "switch session" action would conflict. User clicks the
      // sidebar row to switch — same as today.
      void selectSession;
    });
    return () => setBackgroundWaitingHandler(() => {});
  }, [push, selectSession]);
  // Subscribe to OS notification clicks → focus the session.
  useEffect(() => {
    const off = window.agentory?.onNotificationFocus((sessionId) => {
      const exists = useStore.getState().sessions.some((s) => s.id === sessionId);
      if (exists) selectSession(sessionId);
    });
    return () => {
      if (off) off();
    };
  }, [selectSession]);
  return null;
}

/**
 * Listens for `update:downloaded` from the main process and shows a persistent
 * toast with a Restart button. We only show the toast once per session — the
 * Settings → Updates pane shows the same state for users who dismiss.
 */
function UpdateDownloadedBridge() {
  const { push } = useToast();
  useEffect(() => {
    let shown = false;
    const off = window.agentory?.onUpdateDownloaded((info) => {
      if (shown) return;
      shown = true;
      push({
        kind: 'info',
        title: 'Update downloaded — restart to apply',
        body: `Version ${info.version} is ready.`,
        persistent: true,
        action: {
          label: 'Restart',
          onClick: () => {
            void window.agentory?.updatesInstall();
          }
        }
      });
    });
    return () => {
      if (off) off();
    };
  }, [push]);
  return null;
}
