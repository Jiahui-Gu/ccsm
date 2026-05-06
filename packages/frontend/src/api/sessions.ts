// Thin fetch wrapper for the daemon REST API. Types come from @ccsm/shared so
// the frontend and daemon stay in lockstep on the contract (DESIGN.md §4).

import {
  API_PATHS,
  type CreateSessionRequest,
  type CreateSessionResponse,
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
