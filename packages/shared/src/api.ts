// REST API contract types shared by daemon and frontend (DESIGN.md §4).
// Types only — no fetch wrapper, no runtime validation. Network code lives
// in the daemon (T3) and frontend client (T6).

export interface CreateSessionRequest {
  cwd?: string;
}

export interface CreateSessionResponse {
  sid: string;
  createdAt: number;
}

export interface SessionInfo {
  sid: string;
  createdAt: number;
  alive: boolean;
}

export interface ListSessionsResponse {
  sessions: SessionInfo[];
}

export interface DeleteSessionResponse {
  ok: true;
}

// Task #668: explicit response shape for POST /api/sessions/:sid/resume.
// Success returns { ok: true }; failure returns { error: string } (e.g.
// 'pty_spawn_failed', 'not_found'). Kept as a union so callers must branch.
export type ResumeSessionResponse =
  | { ok: true }
  | { error: string };

export const API_PATHS = {
  sessions: '/api/sessions',
  session: (sid: string): string => `/api/sessions/${encodeURIComponent(sid)}`,
  sessionResume: (sid: string): string =>
    `/api/sessions/${encodeURIComponent(sid)}/resume`,
  ws: '/ws',
} as const;
