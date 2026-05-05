/**
 * `window.ccsmPty` — preload bridge stub for the v0.3 daemon transition.
 *
 * Wave-1 deleted the original electron/preload bridges. Wave-2-prep
 * restores them as STUBS so the renderer can mount without crashing on
 * `window.ccsmPty.X is undefined`. Every method throws a uniform
 * `'pty: not yet wired (W2-B)'` error, which the existing renderer
 * try/catch + zustand error state already handle gracefully (terminal
 * pane shows error message, not white screen).
 *
 * Wave-2-B replaces this file with a real fetch+EventSource shim against
 * `/api/pty/*` and `/api/events/pty?sid=...`. Other wave-2 sub-PRs MUST NOT
 * touch this file (only W2-B does).
 */

import { contextBridge } from "electron";

const NOT_WIRED = new Error("pty: not yet wired (W2-B)");

function rejectAsync<T>(): Promise<T> {
  return Promise.reject(NOT_WIRED);
}

function noopUnsubscribe(): () => void {
  return () => {
    /* noop */
  };
}

const ccsmPty = {
  spawn: (_opts: unknown): Promise<unknown> => rejectAsync(),
  attach: (_sid: string): Promise<unknown> => rejectAsync(),
  detach: (_sid: string): Promise<void> => rejectAsync(),
  get: (_sid: string): Promise<unknown> => rejectAsync(),
  list: (): Promise<unknown[]> => Promise.resolve([]),
  input: (_sid: string, _data: string): Promise<void> => rejectAsync(),
  resize: (_sid: string, _cols: number, _rows: number): Promise<void> => rejectAsync(),
  kill: (_sid: string): Promise<void> => rejectAsync(),
  checkClaudeAvailable: (): Promise<{ available: boolean; reason?: string }> =>
    Promise.resolve({ available: false, reason: "pty: not yet wired (W2-B)" }),
  getBufferSnapshot: (_sid: string): Promise<string> => Promise.resolve(""),
  // Event subscriptions: return noop unsubscribe so renderer cleanup paths
  // run without throwing. Real W2-B wires these to EventSource.
  onData: (_sid: string, _cb: (data: string) => void): (() => void) => noopUnsubscribe(),
  onExit: (_sid: string, _cb: (code: number | null) => void): (() => void) => noopUnsubscribe(),
  onAck: (_sid: string, _cb: (seq: number) => void): (() => void) => noopUnsubscribe(),
  // Clipboard helper used by xterm.ts. Delegate to navigator.clipboard in
  // renderer rather than IPC — this method works even without daemon.
  clipboard: {
    writeText: (text: string): Promise<void> =>
      navigator.clipboard?.writeText(text) ?? Promise.resolve(),
  },
} as const;

export type CcsmPtyApi = typeof ccsmPty;

export function installCcsmPtyBridge(): void {
  contextBridge.exposeInMainWorld("ccsmPty", ccsmPty);
}
