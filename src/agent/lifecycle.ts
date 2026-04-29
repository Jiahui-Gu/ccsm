// Renderer-side subscriber that pipes per-session state events from main
// (sourced by the JSONL tail-watcher in `electron/sessionWatcher`, fanned
// out over the `session:state` IPC channel and exposed on the preload
// bridge as `window.ccsmSession.onState`) into the zustand store as
// `Session.state` updates.
//
// History:
//   * The previous `subscribeAgentEvents()` lived here and listened to
//     SDK turn-result events to drive `setSessionState(sid, 'waiting')`
//     when claude finished a turn for a non-active session (commit
//     1b32c46 "fix(sidebar): never pulse the active session row" was
//     the last shape of that gate).
//   * The whole file was deleted in commit 08bce04 (ttyd refactor)
//     because ccsm now spawns the CLI as a subprocess instead of
//     consuming SDK events directly. The renderer lost its only writer
//     to `Session.state`, so the AgentIcon halo (which still keys off
//     `state === 'waiting'`) silently went dark for every session.
//   * This file is the minimal re-wiring: same outcome (sidebar halo
//     pulses when claude is waiting on the user) sourced from the
//     replacement signal (JSONL watcher → `session:state` IPC).
//
// Mapping from CLI vocabulary → renderer two-state model:
//   'idle'             (claude finished, user owes next move) → 'waiting'
//   'requires_action'  (permission prompt)                    → 'waiting'
//   'running'          (claude is mid-turn)                   → 'idle'
//
// Active-session suppression lives in the store action
// (`_applySessionState`), not here, so the symmetric `waiting → idle`
// clear in `selectSession` and the active-session guard live next to
// each other and can't drift apart.

import { useStore } from '../stores/store';
import type { SessionState as IPCSessionState } from '../session';

type Unsubscribe = () => void;

function mapState(s: IPCSessionState): 'idle' | 'waiting' {
  // 'idle' from the CLI means "claude finished its turn" — that's
  // exactly when we want the halo to call the user. Likewise
  // 'requires_action'. Only 'running' (claude busy) is non-attention.
  return s === 'running' ? 'idle' : 'waiting';
}

let installed = false;

/**
 * Subscribe the zustand store to `window.ccsmSession.onState` events.
 * Idempotent: a second call is a no-op so React StrictMode double-mount
 * (or a stray HMR re-import) doesn't double-pipe events into the store.
 *
 * Returns an unsubscribe handle; calling it tears down the bridge AND
 * clears the installed-guard so a subsequent `subscribeAgentEvents()`
 * can re-install (used by tests; production calls this once at App
 * mount and never tears down).
 *
 * Returns a no-op unsubscribe in environments where the preload bridge
 * is missing (tests, storybook, the very first frame before
 * contextBridge has run).
 */
export function subscribeAgentEvents(): Unsubscribe {
  if (installed) return () => { /* noop — already installed */ };
  const bridge = (typeof window !== 'undefined'
    ? (window as unknown as { ccsmSession?: { onState?: (cb: (e: { sid: string; state: IPCSessionState }) => void) => Unsubscribe } }).ccsmSession
    : undefined);
  if (!bridge || typeof bridge.onState !== 'function') {
    return () => { /* noop — no bridge in this environment */ };
  }
  installed = true;
  const apply = useStore.getState()._applySessionState;
  const off = bridge.onState((evt) => {
    if (!evt || typeof evt.sid !== 'string' || evt.sid.length === 0) return;
    if (evt.state !== 'idle' && evt.state !== 'running' && evt.state !== 'requires_action') {
      return;
    }
    const sid = evt.sid;
    const mapped = mapState(evt.state);
    // Active-session suppression in `_applySessionState` keeps the row at
    // 'idle' when sid === activeId — which silences the halo for rules
    // 2a / 2b (foreground, the user is here). Rule 4 (window unfocused +
    // any sid finishes) needs the OPPOSITE: even if sid === activeId, when
    // the user is not at the window, the row MUST flash so they see it on
    // return. The store action can't read window focus, so we bypass it
    // here and write `'waiting'` directly when the window is unfocused.
    // `requires_action` and `idle` both map to `'waiting'`; only that
    // bypass is needed because `'idle'` (mapped from CLI 'running') is
    // never an attention signal regardless of focus.
    if (
      mapped === 'waiting' &&
      typeof document !== 'undefined' &&
      typeof document.hasFocus === 'function' &&
      !document.hasFocus()
    ) {
      useStore.setState((s) => {
        let changed = false;
        const sessions = s.sessions.map((x) => {
          if (x.id !== sid) return x;
          if (x.state === 'waiting') return x;
          changed = true;
          return { ...x, state: 'waiting' as const };
        });
        return changed ? { sessions } : {};
      });
      return;
    }
    apply(sid, mapped);
  });
  return () => {
    try { off(); } catch { /* already torn down */ }
    installed = false;
  };
}
