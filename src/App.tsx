import React, { useEffect, useMemo, useState } from 'react';
import { TooltipProvider } from './components/ui/Tooltip';
import { ToastProvider } from './components/ui/Toast';
import { Sidebar } from './components/Sidebar';
import { ChatStream } from './components/ChatStream';
import { InputBar } from './components/InputBar';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { CommandPalette } from './components/CommandPalette';
import { mockSessions, mockGroups, activeSessionId as initialSessionId } from './mock/data';
import type { Session } from './types';

export default function App() {
  // Local copy of sessions so we can mutate state (waiting → idle on select)
  // without touching the mock module. Real impl will move this into a store.
  const [sessions, setSessions] = useState<Session[]>(() => mockSessions.map((s) => ({ ...s })));
  const [activeId, setActiveId] = useState<string>(initialSessionId);
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [model, setModel] = useState<'claude-opus-4' | 'claude-sonnet-4' | 'claude-haiku-4'>(
    'claude-opus-4'
  );
  const [permission, setPermission] = useState<'auto' | 'ask' | 'plan'>('auto');

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? sessions[0],
    [sessions, activeId]
  );

  useEffect(() => {
    if (sessions.length === 0) return;
    if (!sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0].id);
    }
  }, [sessions, activeId]);

  function selectSession(id: string) {
    setActiveId(id);
    setFocusedGroupId(null);
    setSessions((prev) =>
      prev.map((s) => (s.id === id && s.state === 'waiting' ? { ...s, state: 'idle' } : s))
    );
  }

  function focusGroup(id: string) {
    setFocusedGroupId(id);
  }

  function moveSession(sessionId: string, targetGroupId: string, beforeSessionId: string | null) {
    setSessions((prev) => {
      const moving = prev.find((s) => s.id === sessionId);
      if (!moving) return prev;
      const without = prev.filter((s) => s.id !== sessionId);
      const updated: Session = { ...moving, groupId: targetGroupId };
      const anchorValid =
        beforeSessionId !== null &&
        without.some((s) => s.id === beforeSessionId && s.groupId === targetGroupId);
      if (!anchorValid) {
        let lastIdx = -1;
        without.forEach((s, i) => {
          if (s.groupId === targetGroupId) lastIdx = i;
        });
        const insertAt = lastIdx === -1 ? without.length : lastIdx + 1;
        return [...without.slice(0, insertAt), updated, ...without.slice(insertAt)];
      }
      const anchor = without.findIndex((s) => s.id === beforeSessionId);
      return [...without.slice(0, anchor), updated, ...without.slice(anchor)];
    });
  }

  function changeCwd(nextCwd: string) {
    setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, cwd: nextCwd } : s)));
  }

  function createSession(cwd: string | null) {
    const isUsableGroup = (gid: string | null | undefined) => {
      if (!gid) return false;
      const g = mockGroups.find((x) => x.id === gid);
      return !!g && g.kind !== 'archive';
    };
    const activeGroupId = sessions.find((s) => s.id === activeId)?.groupId;
    const fallbackGroupId = mockGroups.find((g) => g.kind !== 'archive')?.id ?? 'g1';
    const targetGroupId = isUsableGroup(focusedGroupId)
      ? focusedGroupId!
      : isUsableGroup(activeGroupId)
      ? activeGroupId!
      : fallbackGroupId;
    const id = `s-${Date.now()}`;
    const newSession: Session = {
      id,
      name: 'New session',
      state: 'idle',
      cwd: cwd ?? '~',
      model,
      groupId: targetGroupId,
      agentType: 'claude-code'
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveId(id);
    setFocusedGroupId(null);
  }

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

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={100}>
      <ToastProvider>
        <div className="flex h-full w-full bg-bg-app text-fg-primary">
          <Sidebar
            onCreateSession={createSession}
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
