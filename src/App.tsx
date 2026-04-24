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
import { ShortcutOverlay } from './components/ShortcutOverlay';
import { DragRegion, WindowControls } from './components/WindowControls';
import { Tutorial } from './components/Tutorial';
import { ClaudeCliMissingDialog } from './components/ClaudeCliMissingDialog';
import { ClaudeCliMissingBanner } from './components/ClaudeCliMissingBanner';
import { AgentDiagnosticBanner } from './components/AgentDiagnosticBanner';
import { AgentInitFailedBanner } from './components/AgentInitFailedBanner';
import { useStore } from './stores/store';
import { resolveEffectiveTheme } from './stores/store';
import { setPersistErrorHandler } from './stores/persist';
import { subscribeAgentEvents, setBackgroundWaitingHandler, maybeAutoResolveAllowAlways } from './agent/lifecycle';
import { initI18n } from './i18n';
import { i18next } from './i18n';
import { usePreferences } from './store/preferences';
import { DURATION, EASING } from './lib/motion';

// Initialise i18next once, before any component renders. Subsequent
// language changes flow through `applyLanguage` (called by the store
// setter in src/store/preferences.ts).
initI18n(usePreferences.getState().resolvedLanguage);

subscribeAgentEvents();

// Expose the zustand store on `window` so E2E probes can introspect /
// drive state directly. We set this UNCONDITIONALLY (not gated on
// NODE_ENV) because webpack production builds dead-strip the gated
// branch — leaving probes that exercise a production-built renderer with
// no way to seed state. The exposure is a debug affordance, not a
// security boundary; same trade-off as `window.__ccsmI18n`.
if (typeof window !== 'undefined') {
  (window as unknown as { __ccsmStore?: typeof useStore }).__ccsmStore = useStore;
  (window as unknown as {
    __ccsmMaybeAutoResolveAllowAlways?: typeof maybeAutoResolveAllowAlways;
  }).__ccsmMaybeAutoResolveAllowAlways = maybeAutoResolveAllowAlways;
}

/**
 * True when the event target is a text-editable surface where printable
 * keys (like "?") should remain composition input rather than trigger a
 * global shortcut. Checked by the document-level `keydown` listener in
 * `App` to gate the modifier-free "?" shortcut-overlay binding.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    // checkbox/radio/button-like inputs don't capture printable keys;
    // treat them as non-editable so "?" still opens the overlay there.
    const nonText = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);
    return !nonText.has(type);
  }
  return false;
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
  const setSessionModel = useStore((s) => s.setSessionModel);
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
    const bridge = window.ccsm;
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
    window.ccsm?.i18n?.setLanguage(resolvedLanguage);
  }, [resolvedLanguage]);

  // Exit animation (UI-10 / #213):
  // When the user closes the window (Cmd/Ctrl+W, X button, OS X red dot)
  // the Electron main process hides-to-tray instead of destroying. It sends
  // `window:beforeHide` with a duration first so we can fade the whole
  // document out, then hides ~180ms later — giving the user a graceful
  // exit rather than an abrupt disappearance. On restore, `window:afterShow`
  // resets opacity. Uses the shared motion tokens (DURATION.standard /
  // EASING.exit) for consistency with the rest of the app.
  //
  // Implementation note: we drive `document.documentElement.style.opacity`
  // directly instead of wrapping the React tree in a `<motion.div>` — a
  // root-level wrapper would be invasive and risk layout regressions,
  // while this approach is zero-DOM, zero-rerender, and survives when
  // React state is about to be torn down.
  useEffect(() => {
    const bridge = window.ccsm?.window;
    if (!bridge?.onBeforeHide || !bridge?.onAfterShow) return;
    const root = document.documentElement;
    const transition = `opacity ${DURATION.standard}s cubic-bezier(${EASING.exit.join(',')})`;
    const offHide = bridge.onBeforeHide(() => {
      root.style.transition = transition;
      root.style.opacity = '0';
    });
    const offShow = bridge.onAfterShow(() => {
      root.style.transition = transition;
      root.style.opacity = '1';
    });
    return () => {
      offHide();
      offShow();
      root.style.transition = '';
      root.style.opacity = '';
    };
  }, []);

  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  // New sessions are created in-place — no modal. The store seeds `cwd`
  // from `recentProjects[0]?.path ?? '~'`; users repick later via the
  // StatusBar cwd chip in chat. See createSession() in stores/store.ts.
  const newSession = React.useCallback(() => {
    createSession(null);
  }, [createSession]);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? sessions[0],
    [sessions, activeId]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Cmd/Ctrl+/ opens the shortcuts overlay. We handle it BEFORE the
      // `if (!mod) return` guard below so it sits alongside the other
      // modified-key bindings, even though the `?` alternative handled
      // further down is modifier-free.
      if (mod && e.key === '/' && !e.shiftKey) {
        e.preventDefault();
        setShortcutsOpen((p) => !p);
        return;
      }
      if (!mod) {
        // Modifier-free bindings: the "?" shortcut for the shortcuts
        // overlay. We deliberately DO NOT fire when the user is typing
        // into a text field — "?" is a printable glyph and must not be
        // stolen mid-composition. Activating only when focus is on body
        // or a non-editable element matches macOS/GitHub conventions.
        if (e.key === '?' && !isEditableTarget(e.target)) {
          e.preventDefault();
          setShortcutsOpen((p) => !p);
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'f' && !e.shiftKey) {
        // Cmd/Ctrl+F opens the global Search / Command Palette. We
        // explicitly preventDefault so the browser/Electron's default
        // find-in-page (when present) doesn't also fire.
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
                onOpenImport={() => setImportOpen(true)}
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
                        variant="primary"
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
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
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
          <ShortcutOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
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
              onOpenImport={() => setImportOpen(true)}
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
              <AgentInitFailedBanner onRequestReconfigure={() => setSettingsOpen(true)} />
              <AgentDiagnosticBanner />
              <ChatStream />
              <StatusBar
                cwd={active.cwd}
                cwdMissing={active.cwdMissing}
                model={active.model || model}
                permission={permission}
                onChangeCwdToPath={(p) => {
                  if (!p) return;
                  changeCwd(p);
                  pushRecentProject(p);
                }}
                onBrowseForCwd={async () => {
                  const next = (await window.ccsm?.pickDirectory()) ?? null;
                  if (!next) return;
                  changeCwd(next);
                  pushRecentProject(next);
                }}
                onChangeModel={(m) => setSessionModel(active.id, m)}
                onChangePermission={setPermission}
              />
              <InputBar sessionId={active.id} />
            </main>
          }
        />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
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
        <ShortcutOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
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
        title: i18next.t('notifications.backgroundWaitingToastTitle', { name: info.sessionName }),
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
    const off = window.ccsm?.onNotificationFocus((sessionId) => {
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
    const off = window.ccsm?.onUpdateDownloaded((info) => {
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
            void window.ccsm?.updatesInstall();
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
