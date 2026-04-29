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
//   * Unconditional fire. Earlier iterations suppressed when the window was
//     focused AND the user was already looking at the transitioned session.
//     We dropped that: the user's actual workflow is "app foreground while I
//     check my phone" — they NEED the OS toast to know a session is done,
//     even when the matching tab is on screen. Only the user's global mute
//     toggle and `Notification.isSupported()` (an OS capability check, not
//     suppression) gate the fire.
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
  /** Optional injected Notification impl — defaults to Electron's. The
   *  e2e test seam swaps this for an in-memory log. */
  notifyImpl?: NotifyImpl;
  /** Optional unread-badge sink. When the bridge actually fires a
   *  notification (i.e. it survived mute / dedupe), the bridge bumps unread
   *  for that sid. The badge sink owns its own clearing via focus /
   *  active-sid listeners installed in main. */
  onNotified?: (sid: string) => void;
  /** Returns the user-visible session name for a sid (custom rename or
   *  SDK-derived auto-summary, whichever the renderer is showing). When
   *  the lookup returns null/undefined/empty, or the placeholder
   *  'New session' / '新会话', we fall back to the short sid prefix so the
   *  toast still carries something correlatable. The renderer is the source
   *  of truth for names; main keeps a mirror updated via 'session:setName'
   *  IPC, exactly like activeSid. */
  getNameFn?: (sid: string) => string | null | undefined;
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
  } = opts;

  const notifyImpl =
    opts.notifyImpl ??
    (process.env.CCSM_NOTIFY_TEST_HOOK ? makeTestNotifyImpl() : makeElectronNotifyImpl());

  const lastNotifiedAt = new Map<string, number>();

  // Per-sid arm gate (#631 / #633).
  //
  // The watcher emits `user-prompt {sid}` whenever it sees a NEW user(text)
  // frame appear in the JSONL (or a user(tool_result) right after a
  // permission prompt). We flip armed=true on that signal and consume it on
  // the NEXT idle/requires_action. This collapses the multi-segment-turn
  // case (#2) — only the FINAL idle of a user-initiated turn fires a
  // notification, not every intermediate idle the inference engine emits.
  //
  // Why not just trust the watcher's idle event? The CLI sometimes splits
  // one user-initiated reply into multiple end_turn boundaries (text segment
  // → tool_use → end_turn) with >5s gaps that our dedupe window can't catch.
  // The disk-side "did the user just type?" signal is the only reliable
  // disambiguation between "user-initiated turn finished" and "CLI is doing
  // its own multi-step work that happens to have an end_turn marker".
  const armed = new Map<string, boolean>();

  function buildCopy(sid: string, state: WatcherState): { title: string; body: string } | null {
    // Resolve the user-visible name. Renderer pushes its name map to main
    // via 'session:setName' (see electron/main.ts), mirroring the activeSid
    // pattern; we read that mirror via the injected getNameFn. Falls back
    // to the short sid prefix when the mirror has nothing meaningful — e.g.
    // a brand-new 'New session' that hasn't been renamed and hasn't yet
    // produced an SDK summary, or test environments without a renderer.
    const name = resolveName(opts.getNameFn?.(sid), sid);
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

    // Arm-gate (#631):
    //   * idle → fire ONLY if armed; consume the arm regardless. The arm
    //     was set when the watcher saw a user(text) appear on disk; the
    //     idle we're handling now is the final boundary of that turn.
    //   * requires_action → ALWAYS fires (per case #3 contract: every
    //     permission prompt pings the user). Reset the arm so the
    //     subsequent tool_result doesn't double-fire on the same turn —
    //     case #4 explicitly re-arms via the watcher's `user-prompt` after
    //     the user answers.
    if (evt.state === 'idle') {
      if (!armed.get(evt.sid)) return;
      armed.set(evt.sid, false);
    } else if (evt.state === 'requires_action') {
      armed.set(evt.sid, false);
    }

    // Per-sid dedupe: ignore a second notification for the same sid
    // within 5s of the previous one (covers idle ↔ requires_action
    // bounces while the CLI writes the next turn frames). Belt-and-
    // suspenders alongside the arm gate.
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

  const onUserPrompt = (evt: { sid: string } | null | undefined): void => {
    if (!evt || !evt.sid) return;
    armed.set(evt.sid, true);
  };

  sessionWatcher.on('state-changed', onStateChanged);
  sessionWatcher.on('user-prompt', onUserPrompt);

  return () => {
    sessionWatcher.off('state-changed', onStateChanged);
    sessionWatcher.off('user-prompt', onUserPrompt);
    lastNotifiedAt.clear();
    armed.clear();
  };
}

function shortSid(sid: string): string {
  return sid.length > 8 ? sid.slice(0, 8) : sid;
}

// Names considered "no real name" — should fall back to short sid. The
// renderer initialises new rows with these placeholders (en/zh) until either
// the user renames or the SDK summary lands. Lowercased + trimmed for the
// compare so casing/spacing drift doesn't slip past.
const PLACEHOLDER_NAMES = new Set(['new session', '新会话']);

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
