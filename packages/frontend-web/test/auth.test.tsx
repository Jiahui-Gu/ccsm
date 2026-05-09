// AuthContext + SignInGate component tests (Task #139, S4-T7).
//
// Coverage target (per spec):
//   1. AuthProvider mount with no JWT → SignInScreen rendered
//   2. Callback `?session=ok#jwt=xxx` → fragment consumed, JWT stored,
//      URL cleaned, gate flips to children
//   3. signOut clears sessionStorage (reload is stubbed)
//   4. signIn redirects to /api/auth/github/login
//
// Plus a guardrail on decodeJwtPayload (login-claim extraction) so the
// fragment-consumer's UX hint doesn't drift.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import {
  consumeCallbackFragment,
  decodeJwtPayload,
  SignInGate,
} from '../src/auth/SignInGate';
import { WEB_JWT_STORAGE_KEY, WEB_LOGIN_STORAGE_KEY } from '../src/hostConfig';

// A web JWT shape: header.payload.signature, base64url-encoded JSON.
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (s: string) =>
    Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kind: 'web' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.sig-not-checked-by-spa`;
}

describe('decodeJwtPayload', () => {
  it('returns the parsed payload for a well-formed JWT', () => {
    const jwt = makeJwt({ login: 'octocat', kind: 'web', exp: 9999999999 });
    expect(decodeJwtPayload(jwt)).toEqual({
      login: 'octocat',
      kind: 'web',
      exp: 9999999999,
    });
  });

  it('returns null for non-three-part input', () => {
    expect(decodeJwtPayload('not.a.jwt.extra')).toBeNull();
    expect(decodeJwtPayload('only-one-part')).toBeNull();
  });

  it('returns null when the payload is not base64url-decodable JSON', () => {
    expect(decodeJwtPayload('aaa.@@@.bbb')).toBeNull();
  });
});

describe('consumeCallbackFragment', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('persists JWT + login from `?session=ok#jwt=...` and cleans the URL', () => {
    const jwt = makeJwt({ login: 'mona', kind: 'web' });
    const replaceState = vi.fn();
    const fakeLoc = {
      pathname: '/',
      search: '?session=ok',
      hash: `#jwt=${jwt}`,
    } as unknown as Location;
    const fakeHist = { replaceState } as unknown as History;

    const ok = consumeCallbackFragment(fakeLoc, fakeHist);
    expect(ok).toBe(true);
    expect(sessionStorage.getItem(WEB_JWT_STORAGE_KEY)).toBe(jwt);
    expect(sessionStorage.getItem(WEB_LOGIN_STORAGE_KEY)).toBe('mona');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('returns false when ?session=ok is missing', () => {
    const fakeLoc = { pathname: '/', search: '', hash: '#jwt=foo' } as unknown as Location;
    const ok = consumeCallbackFragment(fakeLoc, { replaceState: vi.fn() } as unknown as History);
    expect(ok).toBe(false);
    expect(sessionStorage.getItem(WEB_JWT_STORAGE_KEY)).toBeNull();
  });

  it('returns false when the fragment has no jwt= entry', () => {
    const fakeLoc = { pathname: '/', search: '?session=ok', hash: '#other=1' } as unknown as Location;
    const ok = consumeCallbackFragment(fakeLoc, { replaceState: vi.fn() } as unknown as History);
    expect(ok).toBe(false);
  });
});

// ----- Component-level: AuthProvider + SignInGate ------------------------

const ORIGINAL_HREF = 'http://127.0.0.1/';

beforeEach(() => {
  sessionStorage.clear();
  // jsdom's location is read-only for href, but we can replace it via
  // history.replaceState. signIn assigns to window.location.href which jsdom
  // models as a navigation; we shim to capture the assignment.
  window.history.replaceState(null, '', ORIGINAL_HREF);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function HrefProbe({ onHref }: { onHref: (href: string) => void }) {
  const { signIn } = useAuth();
  return (
    <button type="button" data-testid="probe-signin" onClick={() => {
      // Stub assignment side-effect so we don't actually navigate jsdom.
      const originalHref = window.location.href;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: new Proxy(window.location, {
          set(_t, p, v) {
            if (p === 'href') { onHref(String(v)); return true; }
            return Reflect.set(_t, p, v);
          },
        }),
      });
      signIn();
      // Restore so afterEach works
      window.history.replaceState(null, '', originalHref);
    }}>go</button>
  );
}

describe('AuthProvider + SignInGate', () => {
  it('renders SignInScreen when no JWT in sessionStorage and refresh fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    render(
      <AuthProvider fetchImpl={fetchImpl}>
        <SignInGate>
          <div>protected-ui</div>
        </SignInGate>
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Sign in with GitHub')).toBeTruthy();
    });
    expect(screen.queryByText('protected-ui')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith('/api/auth/refresh', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }));
  });

  it('renders children when sessionStorage already has a JWT (no silent refresh)', async () => {
    sessionStorage.setItem(WEB_JWT_STORAGE_KEY, makeJwt({ login: 'octocat', kind: 'web' }));
    sessionStorage.setItem(WEB_LOGIN_STORAGE_KEY, 'octocat');
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

    render(
      <AuthProvider fetchImpl={fetchImpl}>
        <SignInGate>
          <div>protected-ui</div>
        </SignInGate>
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('protected-ui')).toBeTruthy();
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('consumes ?session=ok#jwt=... fragment and flips to children', async () => {
    const jwt = makeJwt({ login: 'callback-user', kind: 'web' });
    window.history.replaceState(null, '', `/?session=ok#jwt=${jwt}`);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

    render(
      <AuthProvider fetchImpl={fetchImpl} skipInitialRefresh>
        <SignInGate>
          <div>protected-ui</div>
        </SignInGate>
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('protected-ui')).toBeTruthy();
    });
    expect(sessionStorage.getItem(WEB_JWT_STORAGE_KEY)).toBe(jwt);
    expect(sessionStorage.getItem(WEB_LOGIN_STORAGE_KEY)).toBe('callback-user');
    // URL cleaned: ?session removed, #jwt dropped.
    expect(window.location.search).toBe('');
  });

  it('signOut clears sessionStorage (reload stubbed)', async () => {
    sessionStorage.setItem(WEB_JWT_STORAGE_KEY, 'old-jwt');
    sessionStorage.setItem(WEB_LOGIN_STORAGE_KEY, 'old-user');
    const fetchImpl = vi.fn(async () => new Response('', { status: 204 })) as unknown as typeof fetch;
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy, href: ORIGINAL_HREF, search: '', hash: '', pathname: '/' },
    });

    function SignOutButton() {
      const { signOut } = useAuth();
      return <button type="button" onClick={() => { void signOut(); }} data-testid="signout">x</button>;
    }

    render(
      <AuthProvider fetchImpl={fetchImpl} skipInitialRefresh>
        <SignOutButton />
      </AuthProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('signout'));
    });

    await waitFor(() => {
      expect(sessionStorage.getItem(WEB_JWT_STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem(WEB_LOGIN_STORAGE_KEY)).toBeNull();
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }));
    expect(reloadSpy).toHaveBeenCalled();
  });

  it('signIn redirects to /api/auth/github/login', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch;

    render(
      <AuthProvider fetchImpl={fetchImpl} skipInitialRefresh>
        <HrefProbe onHref={(h) => seen.push(h)} />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByTestId('probe-signin'));
    expect(seen).toContain('/api/auth/github/login');
  });
});
