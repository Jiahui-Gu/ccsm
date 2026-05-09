// SignInGate — gates the main UI behind a verified server session.
//
// Audit F-S-4 (Task #152): the JWT no longer rides URL fragment +
// sessionStorage. The cf-worker's callback sets an HttpOnly `web_jwt`
// cookie and redirects to `/?session=ok`. This gate:
//
//   1. On mount: if URL has `?session=ok`, clean it via history.replaceState
//      and call AuthContext.refresh() so the new cookie is reflected.
//   2. Render-time: signedIn=false → <SignInScreen>; true → children.

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useAuth } from './AuthContext';
import { SignInScreen } from './SignInScreen';

/**
 * Strip `?session=ok` (and any other params we don't care about preserving)
 * from the current URL. Returns true when something was cleaned (caller
 * should refresh the auth context to pick up the freshly-set cookie).
 *
 * Exported for direct unit testing without RTL.
 */
export function consumeCallbackQuery(loc: Location, hist: History): boolean {
  const params = new URLSearchParams(loc.search);
  if (params.get('session') !== 'ok') return false;
  params.delete('session');
  const remaining = params.toString();
  const cleanUrl =
    loc.pathname + (remaining.length > 0 ? `?${remaining}` : '');
  hist.replaceState(null, '', cleanUrl);
  return true;
}

export interface SignInGateProps {
  children: ReactNode;
}

export function SignInGate({ children }: SignInGateProps) {
  const { signedIn, loading, refresh } = useAuth();

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
    const ok = consumeCallbackQuery(window.location, window.history);
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

  if (!signedIn) {
    return <SignInScreen />;
  }

  return <>{children}</>;
}
