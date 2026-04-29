// `window.ccsmSession` — per-session signals sourced from the JSONL
// tail-watcher (electron/sessionWatcher). Forwarded over `session:state`
// IPC as `{sid, state: 'idle' | 'running' | 'requires_action'}` and
// fan-ed out here to all renderer subscribers (Sidebar today; ccsm-notify
// integration tomorrow). Mirrors the listener-set fan-out pattern used
// for ccsmPty.onData / onExit so multiple subscribers don't each register
// an ipcRenderer listener on the same channel.
//
// Also carries `session:title`, `session:cwdRedirected`, `session:activate`
// signals plus the `setActive` / `setName` setters the renderer pushes back
// to main so the notify bridge can mute toasts for the focused session and
// label them with the friendly name.
//
// Extracted from `electron/preload.ts` in #769 (SRP wave-2 PR-A).

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export type SessionState = 'idle' | 'running' | 'requires_action';
type SessionStatePayload = { sid: string; state: SessionState };
type SessionActivatePayload = { sid: string };
type SessionTitlePayload = { sid: string; title: string };
type SessionCwdRedirectedPayload = { sid: string; newCwd: string };

const sessionStateListeners = new Set<(e: SessionStatePayload) => void>();
const sessionActivateListeners = new Set<(e: SessionActivatePayload) => void>();
const sessionTitleListeners = new Set<(e: SessionTitlePayload) => void>();
const sessionCwdRedirectedListeners = new Set<(e: SessionCwdRedirectedPayload) => void>();

const ccsmSession = {
  onState: (cb: (e: SessionStatePayload) => void): (() => void) => {
    sessionStateListeners.add(cb);
    return () => {
      sessionStateListeners.delete(cb);
    };
  },
  onActivate: (cb: (e: SessionActivatePayload) => void): (() => void) => {
    sessionActivateListeners.add(cb);
    return () => {
      sessionActivateListeners.delete(cb);
    };
  },
  onTitle: (cb: (e: SessionTitlePayload) => void): (() => void) => {
    sessionTitleListeners.add(cb);
    return () => {
      sessionTitleListeners.delete(cb);
    };
  },
  onCwdRedirected: (cb: (e: SessionCwdRedirectedPayload) => void): (() => void) => {
    sessionCwdRedirectedListeners.add(cb);
    return () => {
      sessionCwdRedirectedListeners.delete(cb);
    };
  },
  // Renderer pushes its active session id to main so the notify bridge can
  // suppress toasts for the session the user is currently viewing. Fire on
  // every selectSession; main caches the latest value.
  setActive: (sid: string | null): void => {
    ipcRenderer.send('session:setActive', sid ?? '');
  },
  // Renderer pushes the user-visible name for a sid so notify toasts can
  // label the toast with the friendly name (rename or SDK auto-summary)
  // rather than the UUID. Fire on every name change (rename, external
  // title apply, new session creation). Empty name clears the mirror.
  setName: (sid: string, name: string | null): void => {
    if (!sid) return;
    ipcRenderer.send('session:setName', { sid, name: name ?? '' });
  },
};

export type CCSMSessionAPI = typeof ccsmSession;

export function installCcsmSessionBridge(): void {
  ipcRenderer.on('session:state', (_e: IpcRendererEvent, payload: SessionStatePayload) => {
    for (const cb of sessionStateListeners) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[ccsmSession] onState listener threw', err);
      }
    }
  });

  // Title pushes from main: sourced by the JSONL tail-watcher
  // (electron/sessionWatcher) when the SDK-derived `summary` for a session
  // changes. Renderer subscribes via `window.ccsmSession.onTitle` and pipes
  // into the store's `_applyExternalTitle` action.
  ipcRenderer.on('session:title', (_e: IpcRendererEvent, payload: SessionTitlePayload) => {
    for (const cb of sessionTitleListeners) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[ccsmSession] onTitle listener threw', err);
      }
    }
  });

  // Main pushes `session:cwdRedirected` after the import-resume copy helper
  // (#603) relocates a JSONL into the spawn cwd's projectDir. The renderer
  // patches `session.cwd` so the sessionTitles bridge (rename / list /
  // backfill) reads/writes the COPY rather than the now-frozen SOURCE.
  ipcRenderer.on(
    'session:cwdRedirected',
    (_e: IpcRendererEvent, payload: SessionCwdRedirectedPayload) => {
      for (const cb of sessionCwdRedirectedListeners) {
        try {
          cb(payload);
        } catch (err) {
          console.error('[ccsmSession] onCwdRedirected listener threw', err);
        }
      }
    },
  );

  // Main pushes `session:activate` when the user clicks a desktop notification.
  // Renderer subscribes via `window.ccsmSession.onActivate` and calls its
  // `selectSession(sid)` so the chosen session lands focused.
  ipcRenderer.on('session:activate', (_e: IpcRendererEvent, payload: SessionActivatePayload) => {
    for (const cb of sessionActivateListeners) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[ccsmSession] onActivate listener threw', err);
      }
    }
  });

  contextBridge.exposeInMainWorld('ccsmSession', ccsmSession);
}
