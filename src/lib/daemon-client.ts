// v0.3 wave 1 — thin fetch wrapper over the local daemon's HTTP API.
//
// Convention agreed with the wave-2 daemon team:
//
//   `window.ccsm.X(arg1, arg2, ...)`  →  POST http://127.0.0.1:<port>/api/X
//                                         body  { args: [arg1, arg2, ...] }
//                                         resp  { result: <whatever> }
//
//   nested: `window.ccsm.window.minimize()`  →  POST /api/window/minimize
//   nested: `window.ccsm.userCwds.get()`     →  POST /api/userCwds/get
//
//   event channels (`session:setActive`, etc.) → POST /api/event/<channel>
//                                                 body { args: [...] }
//                                                 (channel `:` kept as-is in path)
//
// On non-2xx the response body is parsed as JSON and `error` is thrown as
// an Error message; if the body isn't JSON, a generic status-line error
// is thrown. Any network failure (daemon offline, port not yet bound)
// surfaces as `Error('daemon offline: <fetch error>')` so call sites see
// a uniform string regardless of the underlying cause.

import { getDaemonPort } from './daemon-port';

async function callApi(path: string, args: unknown[]): Promise<unknown> {
  let port: number;
  try {
    port = await getDaemonPort();
  } catch (err) {
    throw new Error(
      `daemon offline: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const url = `http://127.0.0.1:${port}/api/${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
    });
  } catch (err) {
    throw new Error(
      `daemon offline: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j && typeof j.error === 'string') msg = j.error;
    } catch {
      /* response wasn't JSON; keep the status line */
    }
    throw new Error(msg);
  }
  // 204 No Content (events) → undefined
  if (res.status === 204) return undefined;
  let parsed: { result?: unknown };
  try {
    parsed = (await res.json()) as { result?: unknown };
  } catch {
    return undefined;
  }
  return parsed?.result;
}

/**
 * Invoke a daemon method. `path` is the URL fragment after `/api/`
 * (slashes for nesting, e.g. `'window/minimize'`).
 */
export function daemonInvoke(path: string, args: unknown[]): Promise<unknown> {
  return callApi(path, args);
}

/**
 * Convenience aliases. The shim transports everything via POST today
 * (uniform body + envelope), but these names match the spec's
 * `daemonGet` / `daemonPost` vocabulary so call sites can self-document
 * intent (read vs. write/event) without us having to wire a real GET
 * route now.
 */
export function daemonGet(path: string, args: unknown[] = []): Promise<unknown> {
  return callApi(path, args);
}

export function daemonPost(path: string, args: unknown[] = []): Promise<unknown> {
  return callApi(path, args);
}

/**
 * Fire an event channel — same envelope as method calls but the response
 * body is ignored. Channel `:` is preserved in the URL path; `event/`
 * prefix scopes it so the daemon can route fire-and-forget signals
 * separately from request/response methods.
 */
export function daemonEvent(channel: string, args: unknown[]): Promise<void> {
  return callApi(`event/${channel}`, args).then(() => undefined);
}
