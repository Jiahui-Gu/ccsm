/**
 * `window.ccsmNotify` — preload bridge stub for the v0.3 daemon transition.
 *
 * Wave-2-C replaces this file with a real SSE shim against `/api/events/notify`.
 * Until then, subscriptions return noop unsubscribe (renderer cleanup paths run).
 */

import { contextBridge } from "electron";

function noopUnsubscribe(): () => void {
  return () => {
    /* noop */
  };
}

async function fireUserInput(sid: string): Promise<void> {
  const getPort = (window as unknown as { ccsm?: { getDaemonPort?: () => Promise<number | null> } }).ccsm
    ?.getDaemonPort;
  if (!getPort) return;
  const port = await getPort();
  if (port == null) return;
  try {
    await fetch(`http://127.0.0.1:${port}/api/event/notify/userInput`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: [sid] }),
    });
  } catch {
    /* fire-and-forget */
  }
}

const ccsmNotify = {
  userInput: (sid: string): Promise<void> => fireUserInput(sid),
  onNotified: (_cb: (e: unknown) => void): (() => void) => noopUnsubscribe(),
  onUnwatched: (_cb: (e: unknown) => void): (() => void) => noopUnsubscribe(),
  onBadgeChanged: (_cb: (e: unknown) => void): (() => void) => noopUnsubscribe(),
} as const;

export type CcsmNotifyApi = typeof ccsmNotify;

export function installCcsmNotifyBridge(): void {
  contextBridge.exposeInMainWorld("ccsmNotify", ccsmNotify);
}
