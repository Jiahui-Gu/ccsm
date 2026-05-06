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

export const API_PATHS = {
  sessions: '/api/sessions',
  session: (sid: string): string => `/api/sessions/${encodeURIComponent(sid)}`,
  ws: '/ws',
} as const;
