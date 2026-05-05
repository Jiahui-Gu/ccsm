/**
 * `window.ccsmNotify` — wave-2-C real bridge.
 *
 * RPC surface: fire-and-forget POST against the daemon.
 *   - userInput(sid)         → POST /api/event/notify/userInput {args:[sid]}
 *
 * Event surface: long-lived EventSource against `/api/events/notify`. The
 * daemon (daemon/notify/hub.ts) fans out a `Decision` per qualifying OSC
 * waiting transition; this bridge re-emits to the renderer subscribers.
 *
 * Topic split:
 *   - onNotified         → notify decision frames (`{toast,flash,sid}`)
 *   - onUnwatched        → currently no daemon-side emitter (sessionWatcher
 *                          'unwatched' is consumed inside the daemon for
 *                          badgeStore.forget). Kept as a bridge surface so
 *                          existing renderer cleanup hooks don't crash;
 *                          becomes a real channel when sessionWatcher
 *                          gains a public 'unwatched' SSE topic.
 *   - onBadgeChanged     → daemon /api/events/badge frames (`{total}`)
 *
 * Reconnect glue lives in `_daemon.ts` (shared with ccsmSession +
 * ccsmSessionTitles).
 */

import { contextBridge } from 'electron';
import { fireDaemonEvent, openSse } from './_daemon';

type Listener = (e: unknown) => void;

interface MultiSse {
  add(cb: Listener): () => void;
}

/** Lazily open one SSE per topic and multiplex its frames to local
 *  listeners. The first add() opens the underlying EventSource; the last
 *  remove() closes it. This avoids one EventSource per renderer hook
 *  (each EventSource is a TCP connection + a daemon-side listener entry). */
function multiplexedSse(path: string): MultiSse {
  const listeners = new Set<Listener>();
  let stream: ReturnType<typeof openSse> | null = null;
  return {
    add(cb): () => void {
      listeners.add(cb);
      if (!stream) {
        stream = openSse(path, (data) => {
          for (const l of listeners) {
            try {
              l(data);
            } catch {
              /* ignore listener errors */
            }
          }
        });
      }
      return (): void => {
        listeners.delete(cb);
        if (listeners.size === 0 && stream) {
          stream.close();
          stream = null;
        }
      };
    },
  };
}

const notifySse = multiplexedSse('/api/events/notify');
const badgeSse = multiplexedSse('/api/events/badge');

const ccsmNotify = {
  userInput: (sid: string): Promise<void> =>
    fireDaemonEvent('/api/event/notify/userInput', [sid]),
  onNotified: (cb: (e: unknown) => void): (() => void) => notifySse.add(cb),
  // Wave-2-C: no daemon-side 'unwatched' SSE topic yet; wired as a noop
  // so renderer cleanup paths don't crash. Becomes real once
  // sessionWatcher gains a public unwatched stream.
  onUnwatched: (_cb: (e: unknown) => void): (() => void) => () => {},
  onBadgeChanged: (cb: (e: unknown) => void): (() => void) => badgeSse.add(cb),
} as const;

export type CcsmNotifyApi = typeof ccsmNotify;

export function installCcsmNotifyBridge(): void {
  contextBridge.exposeInMainWorld('ccsmNotify', ccsmNotify);
}
