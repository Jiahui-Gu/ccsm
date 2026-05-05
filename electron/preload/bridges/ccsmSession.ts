/**
 * `window.ccsmSession` — preload bridge stub for the v0.3 daemon transition.
 *
 * Stub for wave-2-prep. setActive/setName fire-and-forget against the daemon
 * via `daemonEvent('session/setActive', ...)`-style routes (W2-A registers
 * `/api/event/session/setActive` and `/api/event/session/setName`). Event
 * subscriptions return noop unsubscribe — W2-C wires them to SSE.
 *
 * Renderer's `app-effects/use*Bridge.ts` files do `if (!window.ccsmSession)
 * return` already; with this stub installed, callsites also tolerate
 * "subscribed but never fires" (the noop unsubscribe is fine).
 */

import { contextBridge } from "electron";

function noopUnsubscribe(): () => void {
  return () => {
    /* noop */
  };
}

// Fire-and-forget POST against the daemon. Looks up the daemon port via
// the same channel ccsmCore uses (window.ccsm.getDaemonPort) — but this
// preload runs before window.ccsm is exposed, so we read it lazily.
async function fireEvent(method: string, args: unknown[]): Promise<void> {
  const getPort = (window as unknown as { ccsm?: { getDaemonPort?: () => Promise<number | null> } }).ccsm
    ?.getDaemonPort;
  if (!getPort) return;
  const port = await getPort();
  if (port == null) return;
  try {
    await fetch(`http://127.0.0.1:${port}/api/event/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args }),
    });
  } catch {
    /* fire-and-forget — daemon offline is not fatal here */
  }
}

const ccsmSession = {
  setActive: (sid: string | null): Promise<void> => fireEvent("session/setActive", [sid]),
  setName: (sid: string, name: string): Promise<void> => fireEvent("session/setName", [sid, name]),
  // Event subscriptions: noop until W2-C wires SSE.
  onState: (_cb: (state: unknown) => void): (() => void) => noopUnsubscribe(),
  onTitle: (_cb: (e: unknown) => void): (() => void) => noopUnsubscribe(),
  onActivate: (_cb: (e: unknown) => void): (() => void) => noopUnsubscribe(),
  onCwdRedirected: (_cb: (e: unknown) => void): (() => void) => noopUnsubscribe(),
} as const;

export type CcsmSessionApi = typeof ccsmSession;

export function installCcsmSessionBridge(): void {
  contextBridge.exposeInMainWorld("ccsmSession", ccsmSession);
}
