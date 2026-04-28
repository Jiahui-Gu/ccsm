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
//   * Suppression is intentionally main-side: window-focus + active-sid
//     belongs in main because the OS already knows whether our window is
//     focused, and the renderer pushes its `activeId` here on every change
//     via `'session:setActive'`. No notification fires when the user is
//     already looking at the session that just transitioned.
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
    getActiveSidFn,
    isWindowFocusedFn,
  } = opts;

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

    // Suppress when the user is already looking at this session in a
    // focused window — they don't need a desktop ping for something
    // that's already on screen.
    if (isWindowFocusedFn() && getActiveSidFn() === evt.sid) return;

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

// Test-only: read + clear the internal dedupe state. Lets unit tests assert
// independent behaviour case-by-case without leaking state between tests.
export function __resetForTest(): void {
  // No module-level state to reset — bridge is constructed per-install. The
  // test impl's globalThis log is owned by the test; reset it there.
}
