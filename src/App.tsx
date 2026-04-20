import React, { useEffect, useMemo } from 'react';
import { TooltipProvider } from './components/ui/Tooltip';
import { ToastProvider } from './components/ui/Toast';
import { Sidebar } from './components/Sidebar';
import { ChatStream } from './components/ChatStream';
import { InputBar } from './components/InputBar';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { CommandPalette } from './components/CommandPalette';
import { useStore } from './stores/store';

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
  const changeCwd = useStore((s) => s.changeCwd);
  const setModel = useStore((s) => s.setModel);
  const setPermission = useStore((s) => s.setPermission);

  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

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
      } else if (e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!active) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-app text-fg-secondary">
        No sessions
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={100}>
      <ToastProvider>
        <div className="flex h-full w-full bg-bg-app text-fg-primary">
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
              onChangeCwd={(p) => p && changeCwd(p)}
              onChangeModel={setModel}
              onChangePermission={setPermission}
            />
            <InputBar sessionId={active.id} />
            <div className="px-4 pb-2 flex items-center justify-between font-mono text-xs text-fg-disabled select-none">
              <span>Enter send · Shift+Enter newline</span>
              <span>12k / 200k tokens · 6% used</span>
            </div>
          </main>
        </div>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onOpenSettings={() => setSettingsOpen(true)}
          onNewSession={() => createSession(null)}
          onSelectSession={selectSession}
          onFocusGroup={focusGroup}
        />
      </ToastProvider>
    </TooltipProvider>
  );
}
