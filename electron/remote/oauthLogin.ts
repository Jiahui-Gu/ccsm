// electron/remote/oauthLogin.ts
import type { SessionStore } from './sessionStore';

export type SessionResponse = {
  token: string;
  userHash: string;
  doUrl: string;
  iceServers: unknown[];
  expiresInSeconds: number;
};

export type MobileRemoteAuthState = {
  loggedIn: boolean;
  userHash: string | null;
  expiresAtMs: number | null;
  persisted: boolean;
};

export async function fetchSession(
  workerOrigin: string,
  authCode: string,
): Promise<SessionResponse> {
  const res = await fetch(new URL('/auth/session', workerOrigin).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authCode }),
  });
  if (!res.ok) throw new Error(`session exchange failed: ${res.status}`);
  return (await res.json()) as SessionResponse;
}

export function loggedOut(): MobileRemoteAuthState {
  return { loggedIn: false, userHash: null, expiresAtMs: null, persisted: false };
}

export async function loginWithGithub(deps: {
  workerOrigin: string;
  runPopup: () => Promise<{ authCode: string }>;
  fetchSession: (workerOrigin: string, authCode: string) => Promise<SessionResponse>;
  store: SessionStore;
}): Promise<MobileRemoteAuthState> {
  let authCode: string;
  try {
    ({ authCode } = await deps.runPopup());
  } catch {
    return loggedOut();
  }
  const s = await deps.fetchSession(deps.workerOrigin, authCode);
  const expiresAtMs = Date.now() + s.expiresInSeconds * 1000;
  deps.store.save({ token: s.token, doUrl: s.doUrl, userHash: s.userHash, expiresAtMs });
  return {
    loggedIn: true,
    userHash: s.userHash,
    expiresAtMs,
    persisted: deps.store.isPersistAvailable(),
  };
}
