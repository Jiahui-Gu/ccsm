// `window.ccsmNotify` — Phase C of the notify pipeline (Task #689). The
// transient "flash" signal is an attention pulse on a session's AgentIcon
// halo independent of `Session.state`. Sourced from the main-process flash
// sink (`electron/notify/sinks/flashSink.ts`) over IPC channel
// `notify:flash` with payload `{sid, on}`.
//
// Renderer subscribes via `window.ccsmNotify.onFlash` and writes the
// zustand store's `flashStates: Record<sid, boolean>`. AgentIcon ORs
// `flashStates[sid]` against `state === 'waiting'` so the halo breathes
// for both persistent waiting AND short-task flashes (Rule 2).
//
// Also exposes `markUserInput(sid)` so the renderer can declare "user
// just touched this session" (new/import/resume) — feeds the decider's
// 60s post-input mute (Rule 1).
//
// Extracted from `electron/preload.ts` in #769 (SRP wave-2 PR-A).

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type NotifyFlashPayload = { sid: string; on: boolean };
const notifyFlashListeners = new Set<(e: NotifyFlashPayload) => void>();

const ccsmNotify = {
  onFlash: (cb: (e: NotifyFlashPayload) => void): (() => void) => {
    notifyFlashListeners.add(cb);
    return () => {
      notifyFlashListeners.delete(cb);
    };
  },
  /** Announce that the user just initiated/touched this session (new /
   *  import / resume / select). Drives the decider's Rule 1 60s post-input
   *  mute so toasts don't fire during the user's own setup actions. */
  markUserInput: (sid: string): void => {
    if (!sid) return;
    ipcRenderer.send('notify:userInput', sid);
  },
};

export type CCSMNotifyAPI = typeof ccsmNotify;

export function installCcsmNotifyBridge(): void {
  ipcRenderer.on('notify:flash', (_e: IpcRendererEvent, payload: NotifyFlashPayload) => {
    for (const cb of notifyFlashListeners) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[ccsmNotify] onFlash listener threw', err);
      }
    }
  });

  contextBridge.exposeInMainWorld('ccsmNotify', ccsmNotify);
}
