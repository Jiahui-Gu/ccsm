// Title-state bridge.
//
// Wires the renderer's `session:title-state` IPC pushes (sourced from
// `xterm.onTitleChange` in TerminalPane) into a per-sid state machine and
// re-emits a `'state-changed'` event for the notify bridge whenever the CLI
// transitions to `idle` (= the user's attention is required: turn done or
// permission prompt).
//
// Why a separate bridge instead of pushing IPC straight into notify:
//   1. Notify keeps its existing EventEmitter input contract — no surgery
//      to its 5s dedupe / mute / name-resolution logic.
//   2. The state machine here is stateful (last-state per sid) and unit
//      testable in isolation from Electron's IPC types.
//   3. We only fire on `running → idle` and `unknown → idle`. Repeated
//      `idle` titles (the CLI re-emits the same OSC 0 every keypress while
//      it is waiting) MUST NOT all trigger notifications.
//
// The producer side — wiring `ipcMain.on('session:title-state', ...)` — is
// installed by `installTitleStateIpc` in main.ts. Tests bypass IPC and
// drive `feedTitleState` directly.

import { EventEmitter } from 'node:events';
import { classifyTitleState, type TitleState } from './titleStateClassifier';

export interface TitleStateBridge {
  /** EventEmitter the notify bridge subscribes to. Emits `'state-changed'`
   *  with `{ sid, state: 'idle' }` on each running→idle / unknown→idle
   *  transition. We deliberately do not emit anything for `running` — the
   *  notify bridge does not care about it. */
  emitter: EventEmitter;
  /** Feed a raw title for a sid. Classifies the title, updates the per-sid
   *  state, and emits a transition event when applicable. Exported for
   *  unit tests and the IPC handler in main.ts. */
  feedTitle: (sid: string, title: string) => void;
  /** Drop the per-sid state for a session that has been closed. Prevents
   *  stale state from suppressing the first idle event of a future session
   *  that happens to reuse the sid (unlikely with UUIDs, but cheap). */
  forgetSid: (sid: string) => void;
}

export function createTitleStateBridge(): TitleStateBridge {
  const emitter = new EventEmitter();
  const lastState = new Map<string, TitleState>();

  const feedTitle = (sid: string, title: string): void => {
    if (typeof sid !== 'string' || sid.length === 0) return;
    const next = classifyTitleState(title);
    const prev = lastState.get(sid);
    lastState.set(sid, next);
    if (next !== 'idle') return;
    if (prev === 'idle') return; // Already idle — repeated OSC 0 while waiting.
    // running → idle, or unknown → idle (first signal of a fresh session that
    // booted straight into a turn). Both are user-attention transitions.
    emitter.emit('state-changed', { sid, state: 'idle' as const });
  };

  const forgetSid = (sid: string): void => {
    lastState.delete(sid);
  };

  return { emitter, feedTitle, forgetSid };
}
