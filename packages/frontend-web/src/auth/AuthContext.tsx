// AuthContext — owns the SPA's view of the cf-worker OAuth session.
//
// Audit F-S-4 (Task #152): the web JWT now lives in an HttpOnly cookie set
// by the cf-worker callback. The SPA never sees the JWT directly; it learns
// "am I signed-in" by calling `GET /api/auth/me` (returns {login, github_id}
// or 401). The previous fragment + sessionStorage path was XSS-readable;
// HttpOnly + SameSite=Strict closes that.
//
// Contract:
//
//   1. On mount: `GET /api/auth/me`. 200 → signed in, surface the login
//      hint; 401 → signed-out, render SignInScreen.
//   2. signIn(): hard-redirect to `/api/auth/github/login`.
//   3. signOut(): `POST /api/auth/logout` (clears the HttpOnly cookies
//      server-side), then `window.location.reload()` so RuntimeProvider
//      tears down cleanly.
//   4. refresh(): re-runs `GET /api/auth/me`. Used by SignInGate after the
//      OAuth callback redirect lands at `/?session=ok` so the freshly-set
//      cookie is reflected without a full page reload.
//
// The context never decodes the JWT — there is no JWT in JS reach. The
// `signedIn` boolean is the only auth signal the UI needs; the WebSocket /
// API layer rides cookies (REST) and `/api/auth/ws-ticket` (ws subprotocol).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { primeWsTicket } from '../hostConfig';

export interface AuthState {
  /** True when `/api/auth/me` returned 200 on the most recent check. */
  signedIn: boolean;
  /** GitHub login from `/api/auth/me`. null when signed out. */
  login: string | null;
  /** True until the initial `/api/auth/me` probe has settled. */
  loading: boolean;
  /** Hard-redirect to `/api/auth/github/login`. */
  signIn: () => void;
  /** POST /api/auth/logout, reload. */
  signOut: () => Promise<void>;
  /** Re-run `/api/auth/me`. SignInGate calls this after a callback redirect. */
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  /** Fetch impl — defaults to window.fetch. Tests inject a stub. */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Skip the initial `/api/auth/me` probe. Set by SignInGate when the SPA
   * just landed at `?session=ok` and we want to defer the probe to its
   * `refresh()` call (avoids a redundant round-trip).
   */
  skipInitialRefresh?: boolean;
}

export function AuthProvider({
  children,
  fetchImpl,
  skipInitialRefresh,
}: AuthProviderProps) {
  const [signedIn, setSignedIn] = useState<boolean>(false);
  const [login, setLogin] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !skipInitialRefresh);

  const fetchRef = useRef<typeof globalThis.fetch>(
    fetchImpl ??
      (typeof window !== 'undefined'
        ? window.fetch.bind(window)
        : ((() => {
            throw new Error('fetch unavailable in this environment');
          }) as typeof globalThis.fetch)),
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetchRef.current('/api/auth/me', {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) {
        setSignedIn(false);
        setLogin(null);
        return;
      }
      const body = (await res.json()) as { login?: unknown };
      if (typeof body.login === 'string' && body.login.length > 0) {
        setSignedIn(true);
        setLogin(body.login);
        // Audit F-S-4: prime the ws-ticket cache so the first WebSocket
        // connect after sign-in does not have to wait on a separate round
        // trip. Failure here doesn't sink sign-in — getCachedWsTicket
        // falls through and a later connect will retry primeWsTicket.
        void primeWsTicket(fetchRef.current);
        return;
      }
      setSignedIn(false);
      setLogin(null);
    } catch {
      setSignedIn(false);
      setLogin(null);
    }
  }, []);

  const signIn = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.location.href = '/api/auth/github/login';
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetchRef.current('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // best-effort
    }
    setSignedIn(false);
    setLogin(null);
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, []);

  // Initial mount probe — skip when SignInGate is going to drive refresh()
  // itself (callback landing path).
  useEffect(() => {
    if (skipInitialRefresh) return;
    let cancelled = false;
    void (async () => {
      await refresh();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, skipInitialRefresh]);

  const value = useMemo<AuthState>(
    () => ({ signedIn, login, loading, signIn, signOut, refresh }),
    [signedIn, login, loading, signIn, signOut, refresh],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (ctx === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
