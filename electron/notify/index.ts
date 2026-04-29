// Desktop notification bridge.
//
// Subscribes to the in-process `sessionWatcher` ('state-changed' events) and
// fires an OS notification via Electron's built-in `Notification` API when a
// session transitions to a state the user actually cares about — `'idle'`
// (the agent finished its turn) and `'requires_action'` (the agent is asking
// for permission / input). `'running'` events are ignored: nobody wants a
// toast for "the agent started typing".
//
// Architecture notes:
//   * The producer of state events is `electron/sessionWatcher`, NOT the
//     renderer. We listen to its EventEmitter directly in main so we don't
//     have to round-trip through IPC just to read a value the main process
//     already has.
//   * Suppression is intentionally main-side: window focus belongs in main
//     because the OS already knows whether our window is focused, and the
//     renderer pushes its `activeId` here on every change via
//     `'session:setActive'`. The primary gate is **app-level**: if the
//     ccsm window is focused, NO session fires an OS notification (the
//     user is already in the app — surface it in-app instead via sidebar
//     dot / icon flash). The per-session active-sid check remains as
//     defense-in-depth in case focus reporting is stale.
//   * Click → focus + activate. We re-show / re-focus the BrowserWindow and
//     send `'session:activate'` to the renderer; the renderer subscribes via
//     `window.ccsmSession.onActivate` and calls `selectSession(sid)`.
//   * Per-sid dedupe (5s). The JSONL classifier sometimes bounces between
//     idle and requires_action briefly while the CLI writes the next turn
//     boundary frames; we don't want a popcorn of toasts for one event.
//   * Test seam: when `CCSM_NOTIFY_TEST_HOOK` is set, we replace the real
//     Notification with an in-memory log accessible from the main process
//     (`globalThis.__ccsmNotifyLog`). The e2e harness reads it via
//     `electronApp.evaluate(() => globalThis.__ccsmNotifyLog)`. This
//     keeps the production code path identical to dev — the only branch is
//     the impl factory.

import { Notification, type BrowserWindow } from 'electron';
import type { EventEmitter } from 'node:events';
import { tNotification } from '../i18n';
import type { WatcherState } from '../sessionWatcher';

export interface NotifyPayload {
  sid: string;
  title: string;
  body: string;
  state: WatcherState;
  ts: number;
}

export interface NotifyImpl {
  show(payload: NotifyPayload, onClick: () => void): void;
}

export interface InstallNotifyBridgeOptions {
  /** Returns the main BrowserWindow (or null). Used for focus on click. */
  getMainWindow: () => BrowserWindow | null;
  /** The same sessionWatcher singleton main wires into ptyHost. */
  sessionWatcher: EventEmitter;
  /** Returns the user's current global mute setting. Read FRESH on each
   *  event so the toggle takes effect without a restart. */
  isMutedFn: () => boolean;
  /** Returns the renderer's currently-active session id. Used to suppress
   *  notifications for the session the user is already looking at. */
  getActiveSidFn: () => string | null;
  /** Returns whether the main window currently has OS focus. */
  isWindowFocusedFn: () => boolean;
  /** Optional injected Notification impl — defaults to Electron's. The
   *  e2e test seam swaps this for an in-memory log. */
  notifyImpl?: NotifyImpl;
  /** Optional unread-badge sink. When the bridge actually fires a
   *  notification (i.e. it survived mute / focus / dedupe), the bridge
   *  bumps unread for that sid. The badge sink owns its own clearing
   *  via focus / active-sid listeners installed in main. */
  onNotified?: (sid: string) => void;
}

const DEDUPE_WINDOW_MS = 5_000;

// Default real-OS implementation. Wraps Electron's Notification with a click
// handler. We `.show()` immediately — Electron coalesces identical
// notifications via the title/body on some platforms, which is harmless.
function makeElectronNotifyImpl(): NotifyImpl {
  return {
    show(payload, onClick) {
      try {
        if (!Notification.isSupported()) return;
        const n = new Notification({
          title: payload.title,
          body: payload.body,
          silent: false,
        });
        n.on('click', () => {
          try {
            onClick();
          } catch (err) {
            console.warn('[notify] click handler threw', err);
          }
        });
        n.show();
      } catch (err) {
        console.warn('[notify] failed to show notification', err);
      }
    },
  };
}

// Test impl — appends to a global array the e2e harness can read.
function makeTestNotifyImpl(): NotifyImpl {
  const g = globalThis as unknown as { __ccsmNotifyLog?: NotifyPayload[] };
  if (!g.__ccsmNotifyLog) g.__ccsmNotifyLog = [];
  return {
    show(payload, _onClick) {
      g.__ccsmNotifyLog!.push(payload);
    },
  };
}

export function installNotifyBridge(opts: InstallNotifyBridgeOptions): () => void {
  const {
    getMainWindow,
    sessionWatcher,
    isMutedFn,
    isWindowFocusedFn,
  } = opts;
  // `getActiveSidFn` is accepted for backward compatibility with callers
  // that already wire it (e.g. main.ts) but is no longer consulted: as of
  // #611 the focus check is app-level. See header comment for rationale.

  const notifyImpl =
    opts.notifyImpl ??
    (process.env.CCSM_NOTIFY_TEST_HOOK ? makeTestNotifyImpl() : makeElectronNotifyImpl());

  const lastNotifiedAt = new Map<string, number>();

  function buildCopy(sid: string, state: WatcherState): { title: string; body: string } | null {
    // Best-effort name lookup: the renderer owns session names but we don't
    // want a synchronous IPC round-trip here. Fall back to the short sid
    // (first 8 chars) so the user can at least correlate.
    const name = shortSid(sid);
    if (state === 'idle') {
      return {
        title: tNotification('sessionDoneTitle'),
        body: tNotification('sessionDoneBody', { name }),
      };
    }
    if (state === 'requires_action') {
      return {
        title: tNotification('sessionWaitingTitle'),
        body: tNotification('sessionWaitingBody', { name }),
      };
    }
    return null; // 'running' — never notify.
  }

  const onStateChanged = (evt: { sid: string; state: WatcherState }): void => {
    if (!evt || !evt.sid) return;
    if (evt.state !== 'idle' && evt.state !== 'requires_action') return;

    if (isMutedFn()) return;

    // App-focus gate: when the ccsm window has OS focus, the user is
    // already in the app — any session's transition can be surfaced
    // in-app (sidebar dot, icon flash via the attention bridge, etc.).
    // An OS toast on top of that is noisy and redundant. This holds
    // regardless of which session is the active one in the renderer; the
    // user explicitly asked for app-level suppression (#611).
    //
    // Note: getActiveSidFn is intentionally NOT used as a fallback gate
    // here. A user with the app minimised but with a session "active" in
    // the renderer still wants the OS ping when that session finishes —
    // otherwise they'd never know.
    // TODO(multi-window): this assumes a single main BrowserWindow. If we
    // ever support multiple windows, "focused" must be checked per-window.
    if (isWindowFocusedFn()) return;

    // Per-sid dedupe: ignore a second notification for the same sid
    // within 5s of the previous one (covers idle ↔ requires_action
    // bounces while the CLI writes the next turn frames).
    const now = Date.now();
    const prev = lastNotifiedAt.get(evt.sid);
    if (prev && now - prev < DEDUPE_WINDOW_MS) return;
    lastNotifiedAt.set(evt.sid, now);

    const copy = buildCopy(evt.sid, evt.state);
    if (!copy) return;

    notifyImpl.show(
      { sid: evt.sid, state: evt.state, ts: now, title: copy.title, body: copy.body },
      () => focusAndActivate(getMainWindow(), evt.sid),
    );

    if (opts.onNotified) {
      try {
        opts.onNotified(evt.sid);
      } catch (err) {
        console.warn('[notify] onNotified threw', err);
      }
    }
  };

  sessionWatcher.on('state-changed', onStateChanged);

  return () => {
    sessionWatcher.off('state-changed', onStateChanged);
    lastNotifiedAt.clear();
  };
}

function shortSid(sid: string): string {
  return sid.length > 8 ? sid.slice(0, 8) : sid;
}

function focusAndActivate(win: BrowserWindow | null, sid: string): void {
  if (!win || win.isDestroyed()) return;
  try {
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  } catch (err) {
    console.warn('[notify] focus failed', err);
  }
  try {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('session:activate', { sid });
    }
  } catch (err) {
    console.warn('[notify] session:activate send failed', err);
  }
}
