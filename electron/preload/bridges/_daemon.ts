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

// Task #629 — A1 lazy port cache + fetch helper.
//
// Why a separate cache (not folded into resolvePort): the existing SSE
// reconnect loop in `openSse` re-resolves the port on every reconnect to
// recover from daemon restarts (daemon binds 127.0.0.1:0, picks a fresh
// port each spawn). Caching there would defeat that recovery. The cache
// here is for one-shot RPC-style calls (`daemonFetch`) where the renderer
// just wants the port once per session and any daemon-restart fallout
// shows up as a fetch failure that the caller already handles.
//
// `null` resolutions are NOT cached — first invocation can land before
// `daemon:getPort` is wired (preload runs before main-process IPC handlers
// finish registering on cold boot). Caching null would freeze that race
// permanently. Successful (numeric) resolutions are cached for the
// lifetime of the renderer; call `__resetDaemonPortCacheForTest` from
// tests to drop it.
let cachedPortPromise: Promise<number | null> | null = null;

/**
 * Resolve the daemon HTTP port, caching the first successful lookup.
 *
 * Concurrent first calls share the same in-flight invoke promise (so we
 * never issue two `daemon:getPort` IPC calls in parallel during the
 * preload-startup race window). If the resolve yields `null` (handler
 * not yet registered) we drop the cache so the next caller retries.
 */
export async function getCachedDaemonPort(): Promise<number | null> {
  if (cachedPortPromise) {
    const cached = await cachedPortPromise;
    if (cached != null) return cached;
    // Previous attempt resolved to null — fall through to retry.
    cachedPortPromise = null;
  }
  const inflight = resolvePort();
  cachedPortPromise = inflight;
  const port = await inflight;
  if (port == null) {
    // Don't lock in a null result; next caller should re-invoke.
    cachedPortPromise = null;
  }
  return port;
}

/**
 * Test seam — drop the cached port so a fresh `getCachedDaemonPort`
 * call re-invokes `daemon:getPort`. Not exported via the bridge surface;
 * intended only for unit tests that swap out the `electron` module mock
 * between assertions.
 */
export function __resetDaemonPortCacheForTest(): void {
  cachedPortPromise = null;
}

export interface DaemonFetchOptions {
  method?: string;
  /** JSON-serializable body. Sets `Content-Type: application/json`
   *  automatically; omit for GET / no-body requests. */
  json?: unknown;
  /** Extra headers merged on top of the JSON content-type (when applicable). */
  headers?: Record<string, string>;
  /** AbortSignal forwarded to `fetch`. */
  signal?: AbortSignal;
}

export class DaemonUnavailableError extends Error {
  constructor() {
    super('daemon port unavailable');
    this.name = 'DaemonUnavailableError';
  }
}

export class DaemonHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
  ) {
    super(`daemon HTTP ${status} ${statusText}`);
    this.name = 'DaemonHttpError';
  }
}

/**
 * Generic loopback fetch against the daemon. Resolves the port via the
 * lazy cache, builds `http://127.0.0.1:${port}${path}`, and parses the
 * response as JSON.
 *
 * Errors are surfaced (unlike `fireDaemonEvent` / `getDaemon` which
 * swallow), so callers can decide retry / surface UX. Throws:
 *   - `DaemonUnavailableError` when the port lookup fails (handler not
 *     registered or main-process refused — caller can retry later)
 *   - `DaemonHttpError` on non-2xx response
 *   - the underlying `fetch` rejection (network / abort) otherwise
 */
export async function daemonFetch<T = unknown>(
  path: string,
  opts: DaemonFetchOptions = {},
): Promise<T> {
  const port = await getCachedDaemonPort();
  if (port == null) throw new DaemonUnavailableError();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    signal: opts.signal,
  });
  if (!res.ok) throw new DaemonHttpError(res.status, res.statusText);
  // Empty body (204 / 205) → return undefined as T. JSON.parse of '' throws.
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }
  const text = await res.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
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
