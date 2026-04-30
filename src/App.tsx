import React, { useEffect, useMemo } from 'react';
import { TooltipProvider } from './components/ui/Tooltip';
import { ToastProvider, useToast } from './components/ui/Toast';
import { Sidebar } from './components/Sidebar';
import { AppShell } from './components/AppShell';
import { AppSkeleton } from './components/AppSkeleton';
import { TerminalPane } from './components/TerminalPane';
import { ClaudeMissingGuide } from './components/ClaudeMissingGuide';
import { SettingsDialog } from './components/SettingsDialog';
import { CommandPalette } from './components/CommandPalette';
import { ImportDialog } from './components/ImportDialog';
import { ShortcutOverlay } from './components/ShortcutOverlay';
import { DragRegion, WindowControls } from './components/WindowControls';
import { InstallerCorruptBanner } from './components/InstallerCorruptBanner';
import { useStore } from './stores/store';
import { initI18n } from './i18n';
import { useTranslation } from './i18n/useTranslation';
import { usePreferences } from './store/preferences';
import { useThemeEffect } from './app-effects/useThemeEffect';
import { useLanguageEffect } from './app-effects/useLanguageEffect';
import { useAgentEventBridge } from './app-effects/useAgentEventBridge';
import { useShortcutHandlers } from './app-effects/useShortcutHandlers';
import { useSessionActivateBridge } from './app-effects/useSessionActivateBridge';
import { useFocusBridge } from './app-effects/useFocusBridge';
import { useUpdateDownloadedBridge } from './app-effects/useUpdateDownloadedBridge';
import { usePersistErrorBridge } from './app-effects/usePersistErrorBridge';
import { useSessionActiveBridge } from './app-effects/useSessionActiveBridge';
import { useSessionNameBridge } from './app-effects/useSessionNameBridge';
import { usePtyExitBridge } from './app-effects/usePtyExitBridge';
import { useSessionTitleBridge } from './app-effects/useSessionTitleBridge';
import { useNotifyFlashBridge } from './app-effects/useNotifyFlashBridge';
import { useCwdRedirectedBridge } from './app-effects/useCwdRedirectedBridge';
import { useHydrateSystemLocale } from './app-effects/useHydrateSystemLocale';
import { useExitAnimation } from './app-effects/useExitAnimation';

// Initialise i18next once, before any component renders. Subsequent
// language changes flow through `applyLanguage` (called by the store
// setter in src/store/preferences.ts).
initI18n(usePreferences.getState().resolvedLanguage);

// Expose the zustand store on `window` so E2E probes can introspect /
// drive state directly. We set this UNCONDITIONALLY (not gated on
// NODE_ENV) because webpack production builds dead-strip the gated
// branch — leaving probes that exercise a production-built renderer with
// no way to seed state. The exposure is a debug affordance, not a
// security boundary; same trade-off as `window.__ccsmI18n`.
if (typeof window !== 'undefined') {
  (window as unknown as { __ccsmStore?: typeof useStore }).__ccsmStore = useStore;
}

/**
 * Inner zero-render component that lives inside `<ToastProvider>` so it
 * can call `useToast()`. Hosts the two toast-bound effect hooks
 * (`useUpdateDownloadedBridge` + `usePersistErrorBridge`) that previously
 * lived in standalone `<UpdateDownloadedBridge />` / `<PersistErrorBridge />`
 * components at the bottom of this file. Keeping them in a single inner
 * component (rather than two) avoids a second `useToast()` call and the
 * extra component boundary.
 */
function AppEffectsBridge(): null {
  const { push } = useToast();
  useUpdateDownloadedBridge({ push });
  usePersistErrorBridge({ push });
  return null;
}

export default function App() {
  const { t } = useTranslation();
  const sessions = useStore((s) => s.sessions);
  const flashStates = useStore((s) => s.flashStates);
  const activeId = useStore((s) => s.activeId);
  const focusedGroupId = useStore((s) => s.focusedGroupId);
  // perf/startup-render-gate: App now mounts BEFORE `hydrateStore()`
  // resolves (index.tsx no longer awaits hydration). For the sub-frame
  // window where `hydrated` is still false, sessions/groups are at their
  // empty defaults — we must NOT render the first-run "no sessions yet"
  // landing in that gap, otherwise a user with persisted sessions on disk
  // sees a flash of the empty CTA before their real session list pops in.
  // Render a neutral skeleton (sidebar shell + blank main) until the
  // persisted snapshot lands.
  const hydrated = useStore((s) => s.hydrated);

  const selectSession = useStore((s) => s.selectSession);
  const focusGroup = useStore((s) => s.focusGroup);
  const applyExternalTitle = useStore((s) => s._applyExternalTitle);
  const applyCwdRedirect = useStore((s) => s._applyCwdRedirect);
  const applyPtyExit = useStore((s) => s._applyPtyExit);
  const moveSession = useStore((s) => s.moveSession);
  const createSession = useStore((s) => s.createSession);
  const theme = useStore((s) => s.theme);
  const fontSizePx = useStore((s) => s.fontSizePx);

  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  // ---- Extracted effect hooks (Task #732 Phase B + Task #758 Phase C) ----
  // Theme application — reactive to user choice + (when system) OS scheme.
  useThemeEffect(theme);

  // Pipe `session:state` IPC events into the store via subscribeAgentEvents.
  // Drives the AgentIcon attention halo for non-active sessions.
  useAgentEventBridge();

  // `session:activate` from main → re-select the named session (desktop
  // notification click).
  useSessionActivateBridge(selectSession);

  // OS focus regained → drop the active session's attention halo per
  // notify spec (`_applySessionState` carries the symmetric suppression).
  useFocusBridge(React.useCallback(() => {
    const st = useStore.getState();
    const id = st.activeId;
    if (!id) return;
    const sess = st.sessions.find((x) => x.id === id);
    if (!sess || sess.state !== 'waiting') return;
    useStore.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id && x.state === 'waiting' ? { ...x, state: 'idle' } : x
      ),
    }));
  }, []));

  // Global keyboard shortcuts (Ctrl+/, "?", Ctrl+F, Ctrl+,).
  useShortcutHandlers({
    toggleShortcuts: React.useCallback(() => setShortcutsOpen((p) => !p), []),
    togglePalette: React.useCallback(() => setPaletteOpen((p) => !p), []),
    openSettings: React.useCallback(() => setSettingsOpen(true), []),
  });

  // Mirror resolved language to main for OS-level surfaces (tray menu,
  // future native notifications).
  const hydrateSystemLocale = usePreferences((s) => s.hydrateSystemLocale);
  const resolvedLanguage = usePreferences((s) => s.resolvedLanguage);
  useLanguageEffect(resolvedLanguage);

  // Mirror the renderer's active session id to main so the desktop-notify
  // bridge can suppress toasts for the session the user is already on.
  useSessionActiveBridge(activeId);

  // Mirror per-session names to main; diffs over previous render and
  // emits clears for sids that have disappeared.
  useSessionNameBridge(sessions);

  // Pipe `pty:exit` events into the store unconditionally (drives the
  // sidebar red dot for background-session deaths).
  usePtyExitBridge(applyPtyExit);

  // Pipe `session:title` IPC events from main into the store (SDK-derived
  // summary changes).
  useSessionTitleBridge(applyExternalTitle);

  // Pipe `notify:flash` IPC events from main into the store (transient
  // pulses driven by the 7-rule decider).
  useNotifyFlashBridge();

  // Pipe `session:cwdRedirected` IPC events into the store (import-resume
  // copy helper relocates a JSONL into the spawn cwd's projectDir).
  useCwdRedirectedBridge(applyCwdRedirect);

  // Boot-time: ask main for the OS locale and feed preferences. Falls
  // back to navigator.
  useHydrateSystemLocale(hydrateSystemLocale);

  // Window hide-to-tray exit animation: fade <html> opacity in/out on
  // `window:beforeHide` / `window:afterShow`.
  useExitAnimation();

  // -----------------------------------------------------------------------
  // Remaining inline effects (intentionally NOT extracted — couple to
  // local React state too tightly to be worth a hook indirection).
  // -----------------------------------------------------------------------

  // Font size slider applies via CSS variable on <html>. Child text utilities
  // honor this transitively through `font-size: var(--app-font-size)` on
  // html/body. Explicit px overrides in components (e.g. text-[11px] labels)
  // intentionally do NOT scale — those are information-density callouts the
  // user's "body font size" shouldn't affect.
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${fontSizePx}px`);
  }, [fontSizePx]);

  // E2E debug seam: project the per-sid attention state onto
  // `window.__ccsmFlashStates` as `{ sid: 'flashing' | undefined }` for the
  // notify-rule probes in scripts/harness-real-cli.mjs. The probe reads this
  // map directly to assert the sidebar row icon is in its attention state
  // (rules 3 / 4 / 6 / 7) or NOT (rules 1 / 2a / 2b / 5). The visual state
  // is the AgentIcon amber halo driven by `Session.state === 'waiting'` OR
  // the transient `flashStates[sid]` signal from the new notify pipeline
  // (#689). Keeping this as a derived projection (not a separate slice)
  // means the halo and the seam can never disagree — same source of truth.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const map: Record<string, 'flashing' | undefined> = {};
    for (const sess of sessions) {
      if (sess.state === 'waiting') map[sess.id] = 'flashing';
    }
    for (const sid of Object.keys(flashStates)) {
      if (flashStates[sid]) map[sid] = 'flashing';
    }
    (window as unknown as { __ccsmFlashStates?: Record<string, 'flashing' | undefined> }).__ccsmFlashStates = map;
  }, [sessions, flashStates]);

  // Boot-time check: is the `claude` CLI on PATH? Cached in App-level
  // state because the install state doesn't change mid-session — only
  // when the user runs `npm install -g …` in another terminal and hits
  // "Re-check" inside ClaudeMissingGuide, which calls
  // `ccsmPty.checkClaudeAvailable` itself and signals success via
  // its `onResolved` prop.
  //
  // `undefined` = still probing (render nothing claude-gated yet);
  // `true`/`false` = resolved.
  const [claudeAvailable, setClaudeAvailable] = React.useState<boolean | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const bridge = window.ccsmPty;
    if (!bridge?.checkClaudeAvailable) {
      // Preload missing — treat as unavailable so the guide surfaces
      // rather than silently rendering an empty TerminalPane.
      setClaudeAvailable(false);
      return;
    }
    void (async () => {
      try {
        const result = await bridge.checkClaudeAvailable();
        if (!cancelled) setClaudeAvailable(result.available);
      } catch {
        if (!cancelled) setClaudeAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // New sessions are created in-place — no modal. The store seeds `cwd` from
  // `userHome` (always-true default per spec). Users repick via the StatusBar
  // cwd chip; the chosen path lands in the ccsm-owned `userCwds` LRU and
  // surfaces in the popover's recent column on subsequent opens. See
  // createSession() in stores/store.ts.
  //
  // The pre-direct-xterm TtydPane needed an external "focus the CLI now"
  // counter prop (cliFocusNonce) to bridge React state into a webview that
  // mounted asynchronously. TerminalPane (post-PR-8) hosts xterm in-process
  // and takes focus naturally on click/keyboard, so the counter is gone.
  //
  // We still blur the trigger element synchronously so repeated Enter
  // presses on the "New session" button do not spawn extra sessions
  // before xterm has had a chance to take focus.
  // `claudeAvailableRef` mirrors the boot probe state for the gate below.
  // We read it inside `newSession` instead of closing over the React state
  // because the callback is also passed down to long-lived consumers
  // (Sidebar, CommandPalette) and we want the latest probe value without
  // re-rendering them when it flips.
  const claudeAvailableRef = React.useRef(claudeAvailable);
  React.useEffect(() => {
    claudeAvailableRef.current = claudeAvailable;
  }, [claudeAvailable]);

  const newSession = React.useCallback(() => {
    // Bug #852 / Task #900: clicking "new session" while the boot probe
    // (`claudeAvailable === undefined`) is still pending would swap the
    // right pane to the blank `[data-testid="claude-availability-probing"]`
    // spacer (no PTY spawn). Short-circuit until the probe resolves so the
    // user can't strand themselves on a blank pane. The probing spacer
    // below now also shows a visible "Checking Claude CLI…" affordance
    // for any pre-existing active session caught in the same window.
    if (claudeAvailableRef.current !== true) {
      return;
    }
    if (typeof document !== 'undefined') {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) {
        try { active.blur(); } catch { /* noop */ }
      }
    }
    createSession(null);
  }, [createSession]);

  // Sibling of `newSession` for the sidebar cwd-chevron path. PR #623 only
  // gated the `+` button; the chevron in <NewSessionButton> bypassed the
  // gate by calling `createSession({ cwd })` directly from <Sidebar>, so
  // clicking the chevron during the boot probe still stranded the user on
  // a blank pane (#910 / #911). Apply the same `claudeAvailableRef` short-
  // circuit here. Kept as a separate callback (vs. broadening `newSession`'s
  // signature) so the LRU-default flow stays identical to PR #623's shape.
  const newSessionWithCwd = React.useCallback((cwd: string) => {
    if (claudeAvailableRef.current !== true) {
      return;
    }
    if (typeof document !== 'undefined') {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) {
        try { active.blur(); } catch { /* noop */ }
      }
    }
    createSession({ cwd });
  }, [createSession]);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? sessions[0],
    [sessions, activeId]
  );

  // Pre-hydrate: render a content-shaped skeleton (sidebar placeholder
  // rows + main "Loading…" affordance) so the app does not paint as a
  // blank white window during sqlite hydration. See AppSkeleton (#584).
  // The first-run/empty CTA branch below is reserved for when we're
  // CERTAIN there are no persisted sessions (i.e. hydrated === true).
  if (!active && !hydrated) {
    return (
      <TooltipProvider delayDuration={400} skipDelayDuration={100}>
        <ToastProvider>
          <AppEffectsBridge />
          <AppSkeleton />
        </ToastProvider>
      </TooltipProvider>
    );
  }

  // Body that fills the right pane below the drag region + corrupt-installer
  // banner. Two cases:
  //   - no active session (post-hydrate) → empty pane (sidebar `+` is the only
  //     entry; the central CTA / Tutorial path was removed in #894).
  //   - active session → ClaudeMissingGuide / TerminalPane / probing spacer
  const mainBody = !active ? (
    <div className="flex-1 min-h-0" data-testid="no-active-session-empty" />
  ) : claudeAvailable === false ? (
    <ClaudeMissingGuide onResolved={() => setClaudeAvailable(true)} />
  ) : claudeAvailable === true ? (
    <TerminalPane sessionId={active.id} cwd={active.cwd ?? ''} />
  ) : (
    // Probing claude availability — the right pane would otherwise be a
    // blank flex spacer for the duration of the boot probe, which made the
    // pane look broken when a user clicked "new session" before the probe
    // resolved (Task #900 / bug #852). Render a low-key "Checking…" line
    // instead so the user understands the pane is intentional. The
    // outer testid is preserved so existing harness probes that wait for
    // it to disappear still work.
    <div
      className="flex-1 min-h-0 flex items-center justify-center text-xs text-[var(--muted-fg)]"
      data-testid="claude-availability-probing"
    >
      <span>{t('claudeAvailability.probing')}</span>
    </div>
  );

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={100}>
      <ToastProvider>
        <AppEffectsBridge />
        <AppShell
          sidebar={
            <Sidebar
              onCreateSession={newSession}
              onCreateSessionWithCwd={newSessionWithCwd}
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
              <InstallerCorruptBanner />
              {mainBody}
            </main>
          }
        />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenImport={() => setImportOpen(true)}
          onSelectSession={selectSession}
          onFocusGroup={focusGroup}
        />
        <ShortcutOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </ToastProvider>
    </TooltipProvider>
  );
}
