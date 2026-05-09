// SignInGate — gates the main UI behind a valid web JWT.
//
// Two responsibilities:
//
//   1. Consume the OAuth callback redirect. Task #140 (S4-T3) lands the
//      visitor at `/?session=ok#jwt=<jwt>` after the cf-worker exchanges
//      the GitHub `code`. We pull the JWT out of the URL fragment, peek at
//      the `login` claim for a UX hint (NOT for trust — the worker already
//      verified the signature), persist both to sessionStorage, then clean
//      the URL via history.replaceState so a refresh doesn't re-process
//      the fragment. AuthContext.refresh() then publishes the new state.
//
//   2. Render-time decision: webJwt null → <SignInScreen>; non-null →
//      pass through to <children>. Loading state defers to a tiny inline
//      spinner so the gate doesn't flash SignInScreen during the silent
//      refresh on mount.
//
// The gate never validates the JWT itself; the cf-worker is the source of
// trust. We only base64url-decode the payload to read the `login` claim
// because Task #140's /api/auth/refresh response is the only authoritative
// source of `login`, and the callback path doesn't expose a /me endpoint
// (spec defers that to a follow-up task).

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { WEB_JWT_STORAGE_KEY, WEB_LOGIN_STORAGE_KEY } from '../hostConfig';
import { useAuth } from './AuthContext';
import { SignInScreen } from './SignInScreen';

/**
 * Decode the payload of a JWT (no signature verification).
 *
 * Returns null on any structural error so callers can fall back to a
 * cookie-based refresh that DOES verify the signature server-side.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1] ?? '';
    // base64url → base64
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const json = typeof atob === 'function'
      ? atob(padded + padding)
      : (() => { throw new Error('atob unavailable'); })();
    const obj = JSON.parse(json) as unknown;
    if (typeof obj === 'object' && obj !== null) {
      return obj as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pull `?session=ok#jwt=<jwt>` out of the current URL and persist it.
 *
 * Returns true when a fragment was consumed (caller should refresh()).
 * Exported for direct unit testing without RTL.
 */
export function consumeCallbackFragment(loc: Location, hist: History): boolean {
  const params = new URLSearchParams(loc.search);
  if (params.get('session') !== 'ok') return false;
  const hash = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
  const hashParams = new URLSearchParams(hash);
  const jwt = hashParams.get('jwt');
  if (!jwt || jwt.length === 0) return false;

  sessionStorage.setItem(WEB_JWT_STORAGE_KEY, jwt);
  const payload = decodeJwtPayload(jwt);
  if (payload && typeof payload.login === 'string' && payload.login.length > 0) {
    sessionStorage.setItem(WEB_LOGIN_STORAGE_KEY, payload.login);
  }

  // Clean the URL: drop ?session and #jwt so a reload doesn't re-process.
  params.delete('session');
  const remainingSearch = params.toString();
  const cleanUrl =
    loc.pathname + (remainingSearch.length > 0 ? `?${remainingSearch}` : '');
  hist.replaceState(null, '', cleanUrl);
  return true;
}

export interface SignInGateProps {
  children: ReactNode;
}

export function SignInGate({ children }: SignInGateProps) {
  const { webJwt, loading, refresh } = useAuth();

  // Consume the callback fragment exactly once on mount, before deciding
  // what to render. We do this in a ref-guarded layout-style effect to
  // avoid a flash of SignInScreen on the redirect landing.
  const consumed = useRef(false);
  const [consuming, setConsuming] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('session') === 'ok';
  });

  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;
    if (typeof window === 'undefined') {
      setConsuming(false);
      return;
    }
    const ok = consumeCallbackFragment(window.location, window.history);
    if (ok) {
      void refresh().finally(() => setConsuming(false));
    } else {
      setConsuming(false);
    }
  }, [refresh]);

  if (loading || consuming) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#9aa0a6',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#101216',
        }}
      >
        Loading…
      </div>
    );
  }

  if (webJwt === null) {
    return <SignInScreen />;
  }

  return <>{children}</>;
}
