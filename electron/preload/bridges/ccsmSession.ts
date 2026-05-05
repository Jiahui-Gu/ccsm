/**
 * `window.ccsmSession` — wave-2-C real bridge.
 *
 * RPC surface (fire-and-forget POST):
 *   - setActive(sid)         → POST /api/event/session/setActive {args:[sid]}
 *   - setName(sid, name)     → POST /api/event/session/setName   {args:[sid,name]}
 *
 * Event surface: wave-2-C registers no daemon-side SSE for session
 * lifecycle — sessionWatcher emits internally to notify/badge inside the
 * daemon, and the renderer-visible state-changed / title-changed /
 * activate / cwd-redirected channels are W2-A's data.ts territory (they
 * ride the sessionTitles fetch surface, not a push channel). The hooks
 * below return noop unsubscribe so renderer cleanup paths run unchanged;
 * a future wave-2 follow-up that adds a `/api/events/sessions` SSE topic
 * can swap them to `openSse(...)` without touching callsites.
 */

import { contextBridge } from 'electron';
import { fireDaemonEvent } from './_daemon';

function noopUnsubscribe(): () => void {
  return () => {
    /* noop */
  };
}

const ccsmSession = {
  setActive: (sid: string | null): Promise<void> =>
    fireDaemonEvent('/api/event/session/setActive', [sid]),
  setName: (sid: string, name: string): Promise<void> =>
    fireDaemonEvent('/api/event/session/setName', [sid, name]),
  // Pending future SSE topics (see header comment).
  onState: (_cb: (state: unknown) => void): (() => void) => noopUnsubscribe(),
  onTitle: (_cb: (e: unknown) => void): (() => void) => noopUnsubscribe(),
  onActivate: (_cb: (e: unknown) => void): (() => void) => noopUnsubscribe(),
  onCwdRedirected: (_cb: (e: unknown) => void): (() => void) => noopUnsubscribe(),
} as const;

export type CcsmSessionApi = typeof ccsmSession;

export function installCcsmSessionBridge(): void {
  contextBridge.exposeInMainWorld('ccsmSession', ccsmSession);
}
