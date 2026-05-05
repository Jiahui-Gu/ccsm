// Wave-2-C: shared helper for the daemon SSE bridges. Hides the EventSource
// reconnect glue + the daemon-port lookup so each bridge doesn't re-implement
// it.
//
// Why a manual reconnect loop: the renderer's preload runs before
// window.ccsm.getDaemonPort is exposed, AND the daemon port can change
// across daemon restarts (the daemon binds 127.0.0.1:0 so each spawn picks
// a fresh port). We re-resolve the port on every reconnect attempt so the
// stream re-anchors after a daemon restart.
//
// Backoff is 1s → 5s capped — short enough that a transient daemon restart
// reconnects within a single user blink, long enough that a hard daemon
// outage doesn't spin a tight POST loop.

import { ipcRenderer } from 'electron';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 5_000;

async function resolvePort(): Promise<number | null> {
  try {
    const p = (await ipcRenderer.invoke('daemon:getPort')) as number | null;
    return typeof p === 'number' ? p : null;
  } catch {
    return null;
  }
}

export interface SseStream {
  /** Cancel any active source + stop reconnect loop. */
  close(): void;
}

/**
 * Open an SSE stream against the daemon. Reconnects on error / close;
 * caller's `onMessage` is invoked once per `event.data` JSON-parsed payload.
 *
 * `path` should start with `/api/events/...`. Query string is forwarded as-is.
 *
 * The implementation is fire-and-forget on parse errors — if a frame doesn't
 * round-trip JSON.parse, we log via console.warn and skip the frame rather
 * than poison the stream. The daemon writes only well-formed JSON, so any
 * parse failure here is a wire-corruption signal worth surfacing in devtools
 * but never worth tearing the stream down for.
 */
export function openSse(
  path: string,
  onMessage: (data: unknown) => void,
): SseStream {
  let closed = false;
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = RECONNECT_MIN_MS;

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    const port = await resolvePort();
    if (port == null) {
      scheduleReconnect();
      return;
    }
    try {
      source = new EventSource(`http://127.0.0.1:${port}${path}`);
    } catch {
      scheduleReconnect();
      return;
    }
    source.onopen = (): void => {
      backoff = RECONNECT_MIN_MS;
    };
    source.onmessage = (evt: MessageEvent): void => {
      try {
        const data = JSON.parse(evt.data as string);
        onMessage(data);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[ccsm:sse] parse error on', path, err);
      }
    };
    source.onerror = (): void => {
      try {
        source?.close();
      } catch {
        /* ignore */
      }
      source = null;
      scheduleReconnect();
    };
  };

  void connect();

  return {
    close(): void {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        source?.close();
      } catch {
        /* ignore */
      }
      source = null;
    },
  };
}

/** Fire-and-forget POST against the daemon. Looks up the port lazily so
 *  this works even during the wave-1 / wave-2 startup gap when ccsm.* is
 *  not yet exposed on window. */
export async function fireDaemonEvent(
  path: string,
  args: unknown[],
): Promise<void> {
  const port = await resolvePort();
  if (port == null) return;
  try {
    await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
    });
  } catch {
    /* fire-and-forget — daemon offline is not fatal */
  }
}

/** Synchronous JSON GET against the daemon. Returns null on any error. */
export async function getDaemon<T = unknown>(path: string): Promise<T | null> {
  const port = await resolvePort();
  if (port == null) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
