import React, { useEffect, useMemo } from 'react';
import { Plus, Download } from 'lucide-react';
import { TooltipProvider } from './components/ui/Tooltip';
import { ToastProvider, useToast } from './components/ui/Toast';
import { Button } from './components/ui/Button';
import { Sidebar } from './components/Sidebar';
import { ChatStream } from './components/ChatStream';
import { InputBar } from './components/InputBar';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { CommandPalette } from './components/CommandPalette';
import { ImportDialog } from './components/ImportDialog';
import { TitleBar } from './components/TitleBar';
import { Tutorial } from './components/Tutorial';
import { useStore } from './stores/store';
import { setPersistErrorHandler } from './stores/persist';
import { subscribeAgentEvents, setBackgroundWaitingHandler } from './agent/lifecycle';

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
  const createSession = useStore((s) => s.createSession);
  const createGroup = useStore((s) => s.createGroup);
  const changeCwd = useStore((s) => s.changeCwd);
  const pushRecentProject = useStore((s) => s.pushRecentProject);
  const setModel = useStore((s) => s.setModel);
  const setPermission = useStore((s) => s.setPermission);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const theme = useStore((s) => s.theme);
  const fontSize = useStore((s) => s.fontSize);
  const tutorialSeen = useStore((s) => s.tutorialSeen);
  const markTutorialSeen = useStore((s) => s.markTutorialSeen);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark =
        theme === 'dark' ||
        (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.classList.toggle('dark', dark);
    };
    apply();
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    const px = fontSize === 'sm' ? '12px' : fontSize === 'lg' ? '14px' : '13px';
    document.documentElement.style.setProperty('--app-font-size', px);
  }, [fontSize]);

  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);

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
        createSession(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createSession, createGroup, focusGroup, toggleSidebar]);

  if (!active) {
    return (
      <TooltipProvider delayDuration={400} skipDelayDuration={100}>
        <ToastProvider>
          <PersistErrorBridge />
          <BackgroundWaitingBridge />
          <div className="flex h-full w-full flex-col bg-bg-app text-fg-primary">
            <TitleBar />
            <div className="flex flex-1 min-h-0">
            <Sidebar
              onCreateSession={(cwd) => createSession(cwd)}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenPalette={() => setPaletteOpen(true)}
              activeSessionId={activeId}
              focusedGroupId={focusedGroupId}
              onSelectSession={selectSession}
              onFocusGroup={focusGroup}
              sessions={sessions}
              onMoveSession={moveSession}
            />
            <main className="flex-1 flex items-center justify-center my-2 mr-2 ml-0 rounded-lg bg-bg-panel border border-border-subtle surface-card overflow-hidden">
              {tutorialSeen ? (
                <div className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => createSession(null)}
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
                    createSession(null);
                  }}
                  onImport={() => {
                    markTutorialSeen();
                    setImportOpen(true);
                  }}
                  onSkip={markTutorialSeen}
                />
              )}
            </main>
            </div>
          </div>
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
          <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            onOpenSettings={() => setSettingsOpen(true)}
            onNewSession={() => createSession(null)}
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
        <div className="flex h-full w-full flex-col bg-bg-app text-fg-primary">
          <TitleBar />
          <div className="flex flex-1 min-h-0">
          <Sidebar
            onCreateSession={(cwd) => createSession(cwd)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
            activeSessionId={activeId}
            focusedGroupId={focusedGroupId}
            onSelectSession={selectSession}
            onFocusGroup={focusGroup}
            sessions={sessions}
            onMoveSession={moveSession}
          />
          <main className="flex-1 flex flex-col min-w-0 my-2 mr-2 ml-0 rounded-lg overflow-hidden bg-bg-panel border border-border-subtle surface-card">
            <ChatStream />
            <StatusBar
              cwd={active.cwd}
              model={model}
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
          </div>
        </div>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onOpenSettings={() => setSettingsOpen(true)}
          onNewSession={() => createSession(null)}
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
  return null;
}
