// Toast sink — single-responsibility executor that, given a Decision from
// `notifyDecider.decide`, fires an OS notification (via Electron's
// `Notification`) when `decision.toast === true`.
//
// This sink is the executor end of the notify pipeline (Task #689):
//
//   producer  : ptyHost.onData → OscTitleSniffer (#688)
//   decider   : notifyDecider.decide(event, ctx) (#687) → Decision | null
//   sinks     : toastSink (this file) + flashSink (renderer push)
//
// The sink does NOT decide. It only:
//   1. Builds the user-visible toast copy (title/body) via `getNameFn`.
//   2. Calls `notifyImpl.show` with a click handler that focuses the window
//      + sends 'session:activate' to the renderer.
//   3. Bumps the unread badge via the optional `onNotified` hook.
//   4. Pushes a probe entry to `globalThis.__ccsmNotifyLog` when the
//      `CCSM_NOTIFY_TEST_HOOK` env is set (e2e seam — the existing
//      `notify-fires-on-idle` case reads this array, and the new
//      `notify-pipeline-*` cases below read it too so the seam doubles as
//      the contract surface for both old and new pipelines).

import { Notification, type BrowserWindow } from 'electron';
import { tNotification } from '../../i18n';
import type { Decision } from '../notifyDecider';

export interface ToastPayload {
  sid: string;
  title: string;
  body: string;
  // Carried for parity with the old NotifyPayload shape so the e2e probe
  // assertions (entry.state, entry.ts) keep working unchanged.
  state: 'idle' | 'requires_action';
  ts: number;
  // Decision metadata — useful for the new pipeline's probe assertions.
  decision: Decision;
}

export interface ToastImpl {
  show(payload: ToastPayload, onClick: () => void): void;
}

export interface ToastSinkOptions {
  getMainWindow: () => BrowserWindow | null;
  /** Returns the user-visible session name; falls back to short sid prefix
   *  on null/empty/placeholder. */
  getNameFn?: (sid: string) => string | null | undefined;
  /** Optional injected impl — defaults to Electron's Notification (or the
   *  test seam when CCSM_NOTIFY_TEST_HOOK is set). */
  toastImpl?: ToastImpl;
  /** Bump unread badge counter when a toast actually fires. */
  onNotified?: (sid: string) => void;
}

const PLACEHOLDER_NAMES = new Set(['new session', '新会话']);

function shortSid(sid: string): string {
  return sid.length > 8 ? sid.slice(0, 8) : sid;
}

function resolveName(name: string | null | undefined, sid: string): string {
  if (typeof name !== 'string') return shortSid(sid);
  const trimmed = name.trim();
  if (trimmed.length === 0) return shortSid(sid);
  if (PLACEHOLDER_NAMES.has(trimmed.toLowerCase())) return shortSid(sid);
  return trimmed;
}

function focusAndActivate(win: BrowserWindow | null, sid: string): void {
  if (!win || win.isDestroyed()) return;
  try {
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  } catch (err) {
    console.warn('[toastSink] focus failed', err);
  }
  try {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('session:activate', { sid });
    }
  } catch (err) {
    console.warn('[toastSink] session:activate send failed', err);
  }
}

function makeElectronToastImpl(): ToastImpl {
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
            console.warn('[toastSink] click handler threw', err);
          }
        });
        n.show();
      } catch (err) {
        console.warn('[toastSink] failed to show notification', err);
      }
    },
  };
}

// Test seam — appends to the same `__ccsmNotifyLog` array the legacy bridge
// uses, so the existing `notify-fires-on-idle` e2e case works unchanged when
// the new pipeline replaces the legacy toast emission.
function makeTestToastImpl(): ToastImpl {
  type Entry = Omit<ToastPayload, 'decision'> & { decision?: Decision };
  const g = globalThis as unknown as { __ccsmNotifyLog?: Entry[] };
  if (!g.__ccsmNotifyLog) g.__ccsmNotifyLog = [];
  return {
    show(payload, _onClick) {
      g.__ccsmNotifyLog!.push({
        sid: payload.sid,
        title: payload.title,
        body: payload.body,
        state: payload.state,
        ts: payload.ts,
        decision: payload.decision,
      });
    },
  };
}

export interface ToastSink {
  /** Apply a Decision: fires a toast iff `decision.toast === true`. */
  apply(decision: Decision): void;
}

export function createToastSink(opts: ToastSinkOptions): ToastSink {
  const impl =
    opts.toastImpl ??
    (process.env.CCSM_NOTIFY_TEST_HOOK ? makeTestToastImpl() : makeElectronToastImpl());

  return {
    apply(decision) {
      if (!decision || !decision.toast) return;
      const sid = decision.sid;
      const name = resolveName(opts.getNameFn?.(sid), sid);
      const payload: ToastPayload = {
        sid,
        // Match the legacy 'requires_action' copy — OSC waiting always means
        // "the CLI wants something from you" (permission prompt or the next
        // turn). The two branches in the legacy bridge produced the same UX
        // in practice; we keep the more informative copy.
        state: 'requires_action',
        ts: Date.now(),
        title: tNotification('sessionWaitingTitle'),
        body: tNotification('sessionWaitingBody', { name }),
        decision,
      };
      impl.show(payload, () => focusAndActivate(opts.getMainWindow(), sid));
      if (opts.onNotified) {
        try {
          opts.onNotified(sid);
        } catch (err) {
          console.warn('[toastSink] onNotified threw', err);
        }
      }
    },
  };
}
