// Thin fetch wrapper for the daemon REST API. Types come from @ccsm/shared so
// the frontend and the daemon stay in lockstep on the contract (DESIGN.md §4).
//
// Wave-2 T4 (#689): moved from packages/frontend/src/api/sessions.ts into the
// framework-agnostic @ccsm/core package. The behavioural delta vs. the
// frontend version is *only* the host injection — every function now takes
// `{ baseUrl, fetch? }` so the same code can target either the web origin
// (`baseUrl = ''` for same-origin) or the Tauri-spawned daemon
// (`baseUrl = 'http://127.0.0.1:<port>'`). HTTP method, path, headers,
// body and error semantics are byte-identical to the frontend impl.
//
// `fetch` defaults to `globalThis.fetch` so node tests can inject a vitest
// `vi.fn()` mock without polluting globals.

import {
  API_PATHS,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type DeleteSessionResponse,
  type ListSessionsResponse,
  type ResumeSessionResponse,
} from '@ccsm/shared';

/**
 * Host options injected by the adapter (web / Tauri).
 *
 * `baseUrl` is concatenated verbatim with `API_PATHS.*` (which start with
 * `/api/...`) so callers should pass an origin like `http://127.0.0.1:17832`
 * (no trailing slash) or `''` for same-origin. We do NOT normalize trailing
 * slashes — keeping it dumb avoids surprising URL canonicalization bugs;
 * adapters are expected to hand us a canonical origin.
 *
 * `fetch` defaults to `globalThis.fetch`. Node tests can pass a vitest
 * `vi.fn()` here instead of mutating globals; the runtime in browsers and
 * Node 22 (engines >=22) both ship a global fetch so the default works
 * everywhere we run.
 */
export interface SessionsApiOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function resolveFetch(opts: SessionsApiOptions): typeof globalThis.fetch {
  return opts.fetch ?? globalThis.fetch;
}

/**
 * POST /api/sessions — spawn a new PTY session and return its sid.
 * The token is sent as `Authorization: Bearer <token>` per DESIGN.md §F2.
 *
 * `cwd` is optional; the daemon falls back to its launch cwd when omitted.
 */
export async function createSession(
  token: string,
  body: CreateSessionRequest = {},
  opts: SessionsApiOptions,
): Promise<CreateSessionResponse> {
  const url = `${opts.baseUrl}${API_PATHS.sessions}`;
  const res = await resolveFetch(opts)(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(
      res.status,
      `POST ${url} failed: ${res.status} ${text}`.trim(),
    );
  }
  return (await res.json()) as CreateSessionResponse;
}

/**
 * DELETE /api/sessions/:sid — ask the daemon to tear down a PTY session.
 * The daemon responds 200 `{ ok: true }` on success or 404 if the sid is
 * unknown. Either is treated as "session is gone" by the caller; only true
 * transport / 5xx errors throw.
 */
export async function deleteSession(
  token: string,
  sid: string,
  opts: SessionsApiOptions,
): Promise<DeleteSessionResponse> {
  const url = `${opts.baseUrl}${API_PATHS.session(sid)}`;
  const res = await resolveFetch(opts)(url, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 404) {
    // The session was already gone on the daemon side. Treat as success so
    // the caller can prune it from the store without surfacing an error.
    return { ok: true };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(
      res.status,
      `DELETE ${url} failed: ${res.status} ${text}`.trim(),
    );
  }
  return (await res.json()) as DeleteSessionResponse;
}

/**
 * GET /api/sessions — list every session the daemon currently knows about.
 * Used by App bootstrap (#670) to hydrate the store on page load so a
 * browser refresh doesn't appear to wipe the user's session list.
 *
 * Auth + error semantics mirror createSession: 200 → parsed body, anything
 * else → HttpError carrying the status. Network failures (fetch reject)
 * propagate unchanged so callers can distinguish transport vs. HTTP.
 */
export async function listSessions(
  token: string,
  opts: SessionsApiOptions,
): Promise<ListSessionsResponse> {
  const url = `${opts.baseUrl}${API_PATHS.sessions}`;
  const res = await resolveFetch(opts)(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(
      res.status,
      `GET ${url} failed: ${res.status} ${text}`.trim(),
    );
  }
  return (await res.json()) as ListSessionsResponse;
}

/**
 * POST /api/sessions/:sid/resume — task #668. Asks the daemon to (re-)spawn
 * a PTY runtime for an already-known sid (typically a row that was hydrated
 * from `listSessions` on bootstrap but never attached this page lifetime).
 *
 * Success → `{ ok: true }`. The daemon also responds 404 when the sid is
 * unknown (caller should prune the row) and 5xx on spawn failure (caller
 * should keep the row + let the user retry); both surface as `HttpError`
 * with the matching status so the UI can branch on it.
 */
export async function resumeSession(
  token: string,
  sid: string,
  opts: SessionsApiOptions,
): Promise<{ ok: true }> {
  const url = `${opts.baseUrl}${API_PATHS.sessionResume(sid)}`;
  const res = await resolveFetch(opts)(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(
      res.status,
      `POST ${url} failed: ${res.status} ${text}`.trim(),
    );
  }
  // Narrow the union from @ccsm/shared down to the success arm. The error
  // arm is unreachable on a 2xx by the daemon's own contract (#668).
  const body = (await res.json()) as ResumeSessionResponse;
  if (!('ok' in body) || body.ok !== true) {
    throw new HttpError(
      res.status,
      `POST ${url} returned 2xx without ok:true`,
    );
  }
  return { ok: true };
}
