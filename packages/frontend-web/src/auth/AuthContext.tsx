// AuthContext — owns the SPA's view of the cf-worker OAuth session.
//
// Task #139 (S4-T7) wires up the browser side of the OAuth flow that
// landed in Task #140 (S4-T3). The cf-worker mints a short-lived web JWT
// after `/api/auth/github/callback` and redirects to `/?session=ok#jwt=...`
// with an HttpOnly refresh cookie. This context:
//
//   1. On mount: reads the persisted web JWT + login from sessionStorage.
//      If absent, attempts a silent `POST /api/auth/refresh` so a returning
//      visitor with a still-valid refresh cookie skips the SignInScreen.
//   2. signIn(): hard-redirects to `/api/auth/github/login`.
//   3. signOut(): `POST /api/auth/logout` (best-effort), clears
//      sessionStorage, then `window.location.reload()`.
//   4. refresh(): re-reads sessionStorage. SignInGate calls this after
//      consuming the URL fragment so the context picks up the new JWT
//      without forcing a full page reload.
//
// The context never decodes the JWT to validate it — that's the cf-worker /
// TunnelDO's job. The SPA only uses the value as an opaque bearer that's
// presented on the WebSocket subprotocol header (see hostConfig.ts).

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

import { WEB_JWT_STORAGE_KEY, WEB_LOGIN_STORAGE_KEY } from '../hostConfig';

export interface AuthState {
  /** Web JWT (kind='web') or null when signed out. Opaque to the SPA. */
  webJwt: string | null;
  /** GitHub login hint for display. Sourced from sessionStorage. */
  login: string | null;
  /** True until the initial silent-refresh attempt has settled. */
  loading: boolean;
  /** Hard-redirect to `/api/auth/github/login`. */
  signIn: () => void;
  /** POST /api/auth/logout, clear sessionStorage, reload. */
  signOut: () => Promise<void>;
  /** Re-read sessionStorage so callers can publish a freshly-stored JWT. */
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

function readStoredJwt(): string | null {
  if (typeof window === 'undefined') return null;
  const v = sessionStorage.getItem(WEB_JWT_STORAGE_KEY);
  return v && v.length > 0 ? v : null;
}

function readStoredLogin(): string | null {
  if (typeof window === 'undefined') return null;
  const v = sessionStorage.getItem(WEB_LOGIN_STORAGE_KEY);
  return v && v.length > 0 ? v : null;
}

export interface AuthProviderProps {
  children: ReactNode;
  /**
   * Fetch implementation used for `/api/auth/refresh` and `/api/auth/logout`.
   * Defaults to `window.fetch`. Tests inject a stub.
   */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Skip the silent refresh on mount. Set when the SPA was just redirected
   * back from `/api/auth/github/callback` (SignInGate consumes the URL
   * fragment first, then calls refresh()).
   */
  skipInitialRefresh?: boolean;
}

export function AuthProvider({
  children,
  fetchImpl,
  skipInitialRefresh,
}: AuthProviderProps) {
  const [webJwt, setWebJwt] = useState<string | null>(() => readStoredJwt());
  const [login, setLogin] = useState<string | null>(() => readStoredLogin());
  const [loading, setLoading] = useState<boolean>(() => {
    if (skipInitialRefresh) return false;
    // If we already have a JWT in storage there's nothing to wait for.
    return readStoredJwt() === null;
  });

  // Keep a stable reference to fetch so we don't refetch on every render.
  const fetchRef = useRef<typeof globalThis.fetch>(
    fetchImpl ?? (typeof window !== 'undefined' ? window.fetch.bind(window) : (() => {
      throw new Error('fetch unavailable in this environment');
    }) as typeof globalThis.fetch),
  );

  const refresh = useCallback(async () => {
    const stored = readStoredJwt();
    if (stored !== null) {
      setWebJwt(stored);
      setLogin(readStoredLogin());
      return;
    }
    // Try silent refresh against the HttpOnly cookie.
    try {
      const res = await fetchRef.current('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setWebJwt(null);
        setLogin(null);
        return;
      }
      const body = (await res.json()) as { web_jwt?: unknown; login?: unknown };
      if (typeof body.web_jwt === 'string' && body.web_jwt.length > 0) {
        sessionStorage.setItem(WEB_JWT_STORAGE_KEY, body.web_jwt);
        if (typeof body.login === 'string' && body.login.length > 0) {
          sessionStorage.setItem(WEB_LOGIN_STORAGE_KEY, body.login);
        }
        setWebJwt(body.web_jwt);
        setLogin(typeof body.login === 'string' ? body.login : readStoredLogin());
        return;
      }
      setWebJwt(null);
      setLogin(null);
    } catch {
      // Network error / cookie missing / refresh path 401 → signed out.
      setWebJwt(null);
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
      // Best-effort; cookies may already be expired. Continue clearing local state.
    }
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(WEB_JWT_STORAGE_KEY);
      sessionStorage.removeItem(WEB_LOGIN_STORAGE_KEY);
      // Reload so RuntimeProvider tears down and the SignInGate re-renders
      // from a clean slate (no stale ws connection).
      window.location.reload();
    }
    setWebJwt(null);
    setLogin(null);
  }, []);

  // Initial mount: silent refresh unless caller already populated storage
  // (SignInGate fragment-consume path) or explicitly opted out.
  useEffect(() => {
    if (skipInitialRefresh) return;
    if (readStoredJwt() !== null) {
      setLoading(false);
      return;
    }
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
    () => ({ webJwt, login, loading, signIn, signOut, refresh }),
    [webJwt, login, loading, signIn, signOut, refresh],
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
