// Thin fetch wrapper for the daemon REST API. Types come from @ccsm/shared so
// the frontend and daemon stay in lockstep on the contract (DESIGN.md §4).

import {
  API_PATHS,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type DeleteSessionResponse,
  type ListSessionsResponse,
  type ResumeSessionResponse,
} from '@ccsm/shared';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
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
  fetchImpl: typeof fetch = fetch,
): Promise<CreateSessionResponse> {
  const res = await fetchImpl(API_PATHS.sessions, {
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
      `POST ${API_PATHS.sessions} failed: ${res.status} ${text}`.trim(),
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
  fetchImpl: typeof fetch = fetch,
): Promise<DeleteSessionResponse> {
  const res = await fetchImpl(API_PATHS.session(sid), {
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
      `DELETE ${API_PATHS.session(sid)} failed: ${res.status} ${text}`.trim(),
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
  fetchImpl: typeof fetch = fetch,
): Promise<ListSessionsResponse> {
  const res = await fetchImpl(API_PATHS.sessions, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(
      res.status,
      `GET ${API_PATHS.sessions} failed: ${res.status} ${text}`.trim(),
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
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true }> {
  const res = await fetchImpl(API_PATHS.sessionResume(sid), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(
      res.status,
      `POST ${API_PATHS.sessionResume(sid)} failed: ${res.status} ${text}`.trim(),
    );
  }
  // Narrow the union from @ccsm/shared down to the success arm. The error
  // arm is unreachable on a 2xx by the daemon's own contract (#668).
  const body = (await res.json()) as ResumeSessionResponse;
  if (!('ok' in body) || body.ok !== true) {
    throw new HttpError(
      res.status,
      `POST ${API_PATHS.sessionResume(sid)} returned 2xx without ok:true`,
    );
  }
  return { ok: true };
}
