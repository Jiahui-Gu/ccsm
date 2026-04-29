// `window.ccsmPty` — in-process node-pty bridge that replaces the ttyd
// HTTP/WebSocket detour. Folded the former `window.ccsmCliBridge` surface
// (just `checkClaudeAvailable`) in PR-8 — there is now a single CLI host
// namespace.
//
// `onData` / `onExit` use a listener-set fan-out pattern (see spike
// `xterm-attach/src/preload.cjs`) so multiple subscribers can attach
// without each registering its own ipcRenderer listener — important
// because every TerminalPane mount would otherwise leak a handler on
// the single shared 'pty:data' channel.
//
// Extracted from `electron/preload.ts` in #769 (SRP wave-2 PR-A).

import { contextBridge, ipcRenderer, clipboard, type IpcRendererEvent } from 'electron';

type PtyDataPayload = { sid: string; chunk: string };
type PtyExitPayload = {
  sessionId: string;
  code: number | null;
  signal: number | null;
};

type CheckClaudeAvailableResult =
  | { available: true; path: string }
  | { available: false };

const ptyDataListeners = new Set<(e: PtyDataPayload) => void>();
const ptyExitListeners = new Set<(e: PtyExitPayload) => void>();

const ccsmPty = {
  list: (): Promise<unknown> => ipcRenderer.invoke('pty:list'),
  spawn: (sid: string, cwd: string): Promise<unknown> =>
    ipcRenderer.invoke('pty:spawn', sid, cwd),
  attach: (sid: string): Promise<unknown> => ipcRenderer.invoke('pty:attach', sid),
  detach: (sid: string): Promise<void> => ipcRenderer.invoke('pty:detach', sid),
  input: (sid: string, data: string): Promise<void> =>
    ipcRenderer.invoke('pty:input', sid, data),
  resize: (sid: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('pty:resize', sid, cols, rows),
  kill: (sid: string): Promise<unknown> => ipcRenderer.invoke('pty:kill', sid),
  get: (sid: string): Promise<unknown> => ipcRenderer.invoke('pty:get', sid),
  onData: (cb: (e: PtyDataPayload) => void): (() => void) => {
    ptyDataListeners.add(cb);
    return () => {
      ptyDataListeners.delete(cb);
    };
  },
  onExit: (cb: (e: PtyExitPayload) => void): (() => void) => {
    ptyExitListeners.add(cb);
    return () => {
      ptyExitListeners.delete(cb);
    };
  },
  clipboard: {
    readText: (): string => clipboard.readText(),
    writeText: (text: string): void => clipboard.writeText(text),
  },
  checkClaudeAvailable: (opts?: { force?: boolean }): Promise<CheckClaudeAvailableResult> =>
    ipcRenderer.invoke('pty:checkClaudeAvailable', opts ?? {}),
};

export type CCSMPtyAPI = typeof ccsmPty;

export function installCcsmPtyBridge(): void {
  ipcRenderer.on('pty:data', (_e: IpcRendererEvent, payload: PtyDataPayload) => {
    for (const cb of ptyDataListeners) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[ccsmPty] onData listener threw', err);
      }
    }
  });

  ipcRenderer.on('pty:exit', (_e: IpcRendererEvent, payload: PtyExitPayload) => {
    for (const cb of ptyExitListeners) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[ccsmPty] onExit listener threw', err);
      }
    }
  });

  contextBridge.exposeInMainWorld('ccsmPty', ccsmPty);
}
