// In-app attention flash.
//
// Complements `electron/notify/index.ts` (OS-level desktop toasts) with the
// "the window IS focused but the user is on a different session" case. The
// two paths are mutually exclusive by design:
//
//   * window UNFOCUSED → notify bridge fires an OS toast.
//   * window FOCUSED  → toast is suppressed by the notify bridge (user is
//                       arguably already paying attention to ccsm); but if
//                       another session in the sidebar transitions to idle /
//                       requires_action, the user has no in-app cue. This
//                       module flashes the OS taskbar / dock icon so the
//                       attention indicator surfaces in their peripheral
//                       vision without spawning a noisy toast.
//
// Platform mapping:
//   * Windows: BrowserWindow.flashFrame(true) — taskbar button starts
//     pulsing until the window receives focus, OR we explicitly call
//     flashFrame(false). Cheap, idempotent, no id to track.
//   * macOS:   app.dock.bounce('informational') — single bounce, returns
//     a request id we can pass to app.dock.cancelBounce(id) when the user
//     focuses the window or activates the affected sid. We deliberately do
//     NOT use 'critical' (bounces forever — unacceptable for a
//     turn-finished signal).
//   * Linux:   no portable dock-bounce primitive. We still call flashFrame
//     because Electron silently no-ops it on platforms without urgency
//     hints, and several Linux WMs (KWin, Mutter via _NET_WM_STATE_DEMANDS_
//     ATTENTION) do honor it.
//
// Test seam: when CCSM_NOTIFY_TEST_HOOK is set, attention events are
// appended to `globalThis.__ccsmAttentionLog` (mirrors the notify pattern in
// `index.ts`). The e2e harness reads the log via `electronApp.evaluate`.

import { app, type BrowserWindow } from 'electron';
import type { EventEmitter } from 'node:events';
import type { WatcherState } from '../sessionWatcher';

export interface AttentionEvent {
  sid: string;
  state: WatcherState;
  ts: number;
  /** Which platform path actually ran ('flashFrame' | 'dockBounce' | 'noop'). */
  kind: 'flashFrame' | 'dockBounce' | 'noop';
}

export interface AttentionImpl {
  /** Trigger the attention cue. Returns an opaque cancel handle (only
   *  meaningful on macOS dock-bounce; other paths return null). */
  flash(payload: AttentionEvent): number | null;
  /** Cancel a pending cue by handle (no-op if handle is null or stale). */
  cancel(handle: number | null, win: BrowserWindow | null): void;
}

export interface InstallAttentionFlashOptions {
  sessionWatcher: EventEmitter;
  getMainWindow: () => BrowserWindow | null;
  isMutedFn: () => boolean;
  getActiveSidFn: () => string | null;
  isWindowFocusedFn: () => boolean;
  /** Optional injected impl — defaults to the real Electron path. The unit
   *  tests inject a fake; the e2e harness uses the test-log impl below. */
  attentionImpl?: AttentionImpl;
}

export interface AttentionHandle {
  /** Detach the state-changed listener and cancel any pending flash. */
  dispose: () => void;
  /** Cancel any pending cue (called from window-focus and session:setActive
   *  in main.ts). Safe to call when nothing is pending. */
  cancel: () => void;
}

function makeElectronAttentionImpl(): AttentionImpl {
  return {
    flash(payload) {
      try {
        if (process.platform === 'darwin') {
          // 'informational' = single bounce. Returns a request id we can
          // pass to cancelBounce when the user re-engages.
          const id = app.dock?.bounce('informational');
          payload.kind = 'dockBounce';
          return typeof id === 'number' ? id : null;
        }
        // Windows (taskbar pulse) + Linux (best-effort urgency hint).
        // Resolved at flash time inside the install fn — see below.
        payload.kind = 'flashFrame';
        return null;
      } catch (err) {
        console.warn('[attention] flash failed', err);
        payload.kind = 'noop';
        return null;
      }
    },
    cancel(handle, win) {
      try {
        if (handle != null && process.platform === 'darwin') {
          app.dock?.cancelBounce(handle);
        }
      } catch (err) {
        console.warn('[attention] cancelBounce failed', err);
      }
      try {
        if (win && !win.isDestroyed()) {
          win.flashFrame(false);
        }
      } catch (err) {
        console.warn('[attention] flashFrame(false) failed', err);
      }
    },
  };
}

function makeTestAttentionImpl(): AttentionImpl {
  const g = globalThis as unknown as { __ccsmAttentionLog?: AttentionEvent[] };
  if (!g.__ccsmAttentionLog) g.__ccsmAttentionLog = [];
  let nextId = 1;
  return {
    flash(payload) {
      g.__ccsmAttentionLog!.push(payload);
      // Return a unique fake handle so cancel() can verify pairing.
      return nextId++;
    },
    cancel(_handle, _win) {
      /* no-op for the log impl */
    },
  };
}

export function installAttentionFlash(opts: InstallAttentionFlashOptions): AttentionHandle {
  const {
    sessionWatcher,
    getMainWindow,
    isMutedFn,
    getActiveSidFn,
    isWindowFocusedFn,
  } = opts;

  const attentionImpl =
    opts.attentionImpl ??
    (process.env.CCSM_NOTIFY_TEST_HOOK ? makeTestAttentionImpl() : makeElectronAttentionImpl());

  // Track the most recent pending handle so a focus / activate event can
  // cancel it. Single slot is fine: only one window today, and a fresh
  // flash supersedes the previous one (a new event already grabbed the
  // user's attention; cancelling the old bounce id silently is harmless).
  let pendingHandle: number | null = null;

  function doCancel(): void {
    const h = pendingHandle;
    pendingHandle = null;
    attentionImpl.cancel(h, getMainWindow());
  }

  const onStateChanged = (evt: { sid: string; state: WatcherState }): void => {
    if (!evt || !evt.sid) return;
    if (evt.state !== 'idle' && evt.state !== 'requires_action') return;

    if (isMutedFn()) return;

    // Exclusive with the notify path: notify fires when UNFOCUSED;
    // attention-flash fires when FOCUSED. If we're not focused, let the
    // toast carry the signal.
    if (!isWindowFocusedFn()) return;

    // The user is already looking at this session — no cue needed.
    if (getActiveSidFn() === evt.sid) return;

    const payload: AttentionEvent = {
      sid: evt.sid,
      state: evt.state,
      ts: Date.now(),
      kind: 'noop', // overwritten by impl
    };

    const handle = attentionImpl.flash(payload);

    // Real flashFrame call lives here (not inside impl) so we can reach
    // the live BrowserWindow without threading it through the impl signature.
    if (payload.kind === 'flashFrame') {
      try {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.flashFrame(true);
        }
      } catch (err) {
        console.warn('[attention] flashFrame(true) failed', err);
      }
    }

    // Replace any prior pending handle. Cancel the old one first so we
    // don't leak a dock-bounce id that nobody will ever cancel.
    if (pendingHandle != null && pendingHandle !== handle) {
      attentionImpl.cancel(pendingHandle, getMainWindow());
    }
    pendingHandle = handle;
  };

  sessionWatcher.on('state-changed', onStateChanged);

  return {
    dispose: () => {
      sessionWatcher.off('state-changed', onStateChanged);
      doCancel();
    },
    cancel: doCancel,
  };
}
