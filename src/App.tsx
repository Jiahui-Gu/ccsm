import React, { useEffect, useMemo } from 'react';
import { Plus, Download } from 'lucide-react';
import { TooltipProvider } from './components/ui/Tooltip';
import { ToastProvider, useToast } from './components/ui/Toast';
import { Button } from './components/ui/Button';
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
import { Tutorial } from './components/Tutorial';
import { InstallerCorruptBanner } from './components/InstallerCorruptBanner';
import { useStore } from './stores/store';
import { resolveEffectiveTheme } from './stores/store';
import { setPersistErrorHandler } from './stores/persist';
import { initI18n } from './i18n';
import { i18next } from './i18n';
import { useTranslation } from './i18n/useTranslation';
import { usePreferences } from './store/preferences';
import { DURATION, EASING } from './lib/motion';

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
  const { t } = useTranslation();
  const sessions = useStore((s) => s.sessions);
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
  const applyPtyExit = useStore((s) => s._applyPtyExit);
  const moveSession = useStore((s) => s.moveSession);
  const createSession = useStore((s) => s.createSession);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const theme = useStore((s) => s.theme);
  const fontSizePx = useStore((s) => s.fontSizePx);
  const tutorialSeen = useStore((s) => s.tutorialSeen);
  const markTutorialSeen = useStore((s) => s.markTutorialSeen);

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

  // Mirror the renderer's active session id to main so the desktop-notify
  // bridge can suppress toasts for the session the user is already looking
  // at. Fires once on mount and on every activeId change. Bridge is a
  // no-op in the test/storybook environments where `window.ccsmSession` is
  // missing.
  useEffect(() => {
    type Bridge = { setActive: (sid: string | null) => void };
    const bridge = (window as unknown as { ccsmSession?: Bridge }).ccsmSession;
    if (!bridge || typeof bridge.setActive !== 'function') return;
    bridge.setActive(activeId || null);
  }, [activeId]);

  // Mirror per-session NAMES to main so the desktop-notify bridge can label
  // toasts with the friendly name (custom rename or SDK auto-summary)
  // instead of the bare UUID. Sister effect to `setActive` above; same
  // reason — main needs a synchronous answer when an OS notification fires
  // and we don't want a renderer round-trip on the notify path. Diffs over
  // the previous snapshot so we only IPC for actual changes (mounts,
  // renames, SDK title arrivals, deletions).
  useEffect(() => {
    type Bridge = { setName: (sid: string, name: string | null) => void };
    const bridge = (window as unknown as { ccsmSession?: Bridge }).ccsmSession;
    if (!bridge || typeof bridge.setName !== 'function') return;
    for (const sess of sessions) {
      bridge.setName(sess.id, sess.name ?? null);
    }
  }, [sessions]);

  // Listen for `session:activate` from main (fired when the user clicks a
  // desktop notification). Re-selects the named session so it lands focused
  // in the sidebar and chat pane. Mirrors the IPC subscription pattern of
  // `UpdateDownloadedBridge`.
  useEffect(() => {
    type Bridge = {
      onActivate: (cb: (e: { sid: string }) => void) => () => void;
    };
    const bridge = (window as unknown as { ccsmSession?: Bridge }).ccsmSession;
    if (!bridge || typeof bridge.onActivate !== 'function') return;
    return bridge.onActivate((evt) => {
      if (evt && typeof evt.sid === 'string' && evt.sid.length > 0) {
        selectSession(evt.sid);
      }
    });
  }, [selectSession]);

  // Pipe `pty:exit` events into the store UNCONDITIONALLY (not filtered
  // by activeSid). TerminalPane has its own filtered listener that drives
  // the active-pane red overlay; this second listener is what surfaces
  // background-session deaths in the sidebar (red dot via
  // `disconnectedSessions[sid]`). Both coexist — different concerns, no
  // duplication risk because the store action is idempotent on payload.
  useEffect(() => {
    const pty = (window as unknown as {
      ccsmPty?: {
        onExit?: (cb: (e: { sessionId: string; code?: number | null; signal?: string | number | null }) => void) => () => void;
      };
    }).ccsmPty;
    if (!pty?.onExit) return;
    return pty.onExit((evt) => {
      if (!evt || typeof evt.sessionId !== 'string' || evt.sessionId.length === 0) return;
      applyPtyExit(evt.sessionId, {
        code: evt.code ?? null,
        signal: evt.signal ?? null,
      });
    });
  }, [applyPtyExit]);

  // Pipe `session:title` IPC events from main into the store. The watcher
  // emits when the SDK-derived `summary` changes for a session; the store
  // applies via `_applyExternalTitle` (no-ops if the row is missing or
  // the name is already current). Bridge is a no-op in the
  // test/storybook environments where `window.ccsmSession` is missing or
  // the older preload didn't expose `onTitle`.
  useEffect(() => {
    type Bridge = {
      onTitle?: (cb: (e: { sid: string; title: string }) => void) => () => void;
    };
    const bridge = (window as unknown as { ccsmSession?: Bridge }).ccsmSession;
    if (!bridge || typeof bridge.onTitle !== 'function') return;
    return bridge.onTitle((evt) => {
      if (!evt || typeof evt.sid !== 'string' || typeof evt.title !== 'string') return;
      if (evt.sid.length === 0 || evt.title.length === 0) return;
      applyExternalTitle(evt.sid, evt.title);
    });
  }, [applyExternalTitle]);

  // Locale: ask main for the OS locale, feed it into the preferences store
  // so a "system" preference resolves correctly. Falls back to navigator.
  // Then mirror the resolved language to main for any OS-level surfaces
  // (tray menu, future notifications) to consume.
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
  // When the user closes the window (Ctrl+W, X button) the Electron main
  // process hides-to-tray instead of destroying. It sends
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
  const newSession = React.useCallback(() => {
    if (typeof document !== 'undefined') {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) {
        try { active.blur(); } catch { /* noop */ }
      }
    }
    createSession(null);
  }, [createSession]);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? sessions[0],
    [sessions, activeId]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Ctrl+/ opens the shortcuts overlay. We handle it BEFORE the
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
        // Ctrl+F opens the global Search / Command Palette. We
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
      }
      // Task #552: Cmd+N (new session), Cmd+Shift+N (new session w/ picker
      // — never shipped), and Cmd+Shift+G (new group) keyboard shortcuts
      // were removed in favour of the chevron+popover affordance on the
      // sidebar `+` triggers. The chevron is the single discoverable
      // entry point for "new session, but with a different cwd"; the
      // group `+` button (always visible) covers new-group.
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  if (!active) {
    // Pre-hydrate: render a content-shaped skeleton (sidebar placeholder
    // rows + main "Loading…" affordance) so the app does not paint as a
    // blank white window during sqlite hydration. See AppSkeleton (#584).
    // The first-run/empty CTA branch below is reserved for when we're
    // CERTAIN there are no persisted sessions (i.e. hydrated === true).
    if (!hydrated) {
      return (
        <TooltipProvider delayDuration={400} skipDelayDuration={100}>
          <ToastProvider>
            <PersistErrorBridge />
            <UpdateDownloadedBridge />
            <AppSkeleton />
          </ToastProvider>
        </TooltipProvider>
      );
    }
    return (
      <TooltipProvider delayDuration={400} skipDelayDuration={100}>
        <ToastProvider>
        <PersistErrorBridge />
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
              <InstallerCorruptBanner />
              <div className="flex-1 flex items-center justify-center min-h-0">
                  {tutorialSeen ? (
                    // First-run / no-active-session empty state. Task #329 — we
                    // explicitly do NOT auto-create a session at boot; instead
                    // the user lands on this clean palette of CTAs. The wording
                    // is sentence case and i18n-driven (firstRun.* keys).
                    // Trimmed in #353 to just the two primary CTAs — the
                    // welcome heading, "Create a new group" link, and tip line
                    // were noise on first launch (group creation is reachable
                    // from the sidebar; the tip didn't unlock any action).
                    <div
                      className="flex items-center gap-3"
                      data-testid="first-run-empty"
                    >
                      <Button
                        variant="primary"
                        size="md"
                        onClick={newSession}
                        className="w-44 justify-center"
                      >
                        <Plus size={14} className="stroke-[2]" />
                        <span>{t('firstRun.newSession')}</span>
                      </Button>
                      <Button
                        variant="secondary"
                        size="md"
                        onClick={() => setImportOpen(true)}
                        className="w-44 justify-center"
                      >
                        <Download size={14} className="stroke-[2]" />
                        <span>{t('firstRun.importSession')}</span>
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
              <InstallerCorruptBanner />
              {claudeAvailable === false ? (
                <ClaudeMissingGuide onResolved={() => setClaudeAvailable(true)} />
              ) : claudeAvailable === true ? (
                <TerminalPane sessionId={active.id} cwd={active.cwd ?? ''} />
              ) : (
                // Probing claude availability — render an empty flex spacer
                // so the layout doesn't jump once the boot check resolves.
                <div className="flex-1 min-h-0" data-testid="claude-availability-probing" />
              )}
            </main>
          }
        />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
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
      // Strings live in `settings:updates.downloadedToast*` so the toast
      // localizes alongside the Settings → Updates pane copy. Using
      // `i18next.t` (not the React hook) keeps this callback pure — it
      // fires from an IPC subscription, not a render.
      push({
        kind: 'info',
        title: i18next.t('settings:updates.downloadedToastTitle'),
        body: i18next.t('settings:updates.downloadedToastBody', { version: info.version }),
        persistent: true,
        action: {
          label: i18next.t('settings:updates.downloadedToastAction'),
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
