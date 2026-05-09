// AuthContext + SignInGate component tests (audit F-S-4, Task #152).
//
// Coverage target:
//   1. AuthProvider mount: `/api/auth/me` 401 → SignInScreen rendered.
//   2. AuthProvider mount: `/api/auth/me` 200 → children rendered, login
//      surfaced, ws-ticket primed.
//   3. Callback redirect (`?session=ok`): query cleaned, refresh() runs,
//      gate flips to children when `/api/auth/me` returns 200.
//   4. signOut hits /api/auth/logout (reload stubbed).
//   5. signIn redirects to /api/auth/github/login.
//   6. consumeCallbackQuery purity (no /me round-trip).
//
// All tests stub fetch; the cookie itself is opaque to the SPA so we only
// care about request shape (path, credentials: include).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import {
  consumeCallbackQuery,
  SignInGate,
} from '../src/auth/SignInGate';
import { _resetWsTicketCacheForTests } from '../src/hostConfig';

describe('consumeCallbackQuery', () => {
  it('strips ?session=ok and reports true', () => {
    const replaceState = vi.fn();
    const fakeLoc = {
      pathname: '/',
      search: '?session=ok',
      hash: '',
    } as unknown as Location;
    const fakeHist = { replaceState } as unknown as History;
    const ok = consumeCallbackQuery(fakeLoc, fakeHist);
    expect(ok).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('returns false when ?session=ok is missing', () => {
    const fakeLoc = { pathname: '/', search: '', hash: '' } as unknown as Location;
    const ok = consumeCallbackQuery(fakeLoc, { replaceState: vi.fn() } as unknown as History);
    expect(ok).toBe(false);
  });

  it('preserves other query params when stripping session', () => {
    const replaceState = vi.fn();
    const fakeLoc = {
      pathname: '/x',
      search: '?session=ok&debug=1',
      hash: '',
    } as unknown as Location;
    const fakeHist = { replaceState } as unknown as History;
    const ok = consumeCallbackQuery(fakeLoc, fakeHist);
    expect(ok).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/x?debug=1');
  });
});

// ----- Component-level: AuthProvider + SignInGate ------------------------

const ORIGINAL_HREF = 'http://127.0.0.1/';

beforeEach(() => {
  sessionStorage.clear();
  _resetWsTicketCacheForTests();
  window.history.replaceState(null, '', ORIGINAL_HREF);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function HrefProbe({ onHref }: { onHref: (href: string) => void }) {
  const { signIn } = useAuth();
  return (
    <button
      type="button"
      data-testid="probe-signin"
      onClick={() => {
        const originalHref = window.location.href;
        Object.defineProperty(window, 'location', {
          configurable: true,
          value: new Proxy(window.location, {
            set(_t, p, v) {
              if (p === 'href') {
                onHref(String(v));
                return true;
              }
              return Reflect.set(_t, p, v);
            },
          }),
        });
        signIn();
        window.history.replaceState(null, '', originalHref);
      }}
    >
      go
    </button>
  );
}

/**
 * Build a fetch stub that maps url → response. Unmatched URLs throw so the
 * test fails loudly on an unexpected call.
 */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    for (const path of Object.keys(routes)) {
      if (url === path || url.endsWith(path)) {
        return await routes[path]!();
      }
    }
    throw new Error('unexpected fetch ' + url);
  }) as unknown as typeof fetch;
}

describe('AuthProvider + SignInGate', () => {
  it('renders SignInScreen when /api/auth/me returns 401', async () => {
    const fetchImpl = stubFetch({
      '/api/auth/me': () => new Response('nope', { status: 401 }),
    });
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
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/auth/me',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('renders children when /api/auth/me returns 200, primes ws-ticket', async () => {
    const fetchImpl = stubFetch({
      '/api/auth/me': () => Response.json({ login: 'octocat', github_id: '7' }),
      '/api/auth/ws-ticket': () =>
        Response.json({ ws_ticket: 'tkt.aaa.bbb', expires_in: 60 }),
    });

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
    // Both calls happened with credentials.
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/auth/me',
      expect.objectContaining({ credentials: 'include' }),
    );
    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        '/api/auth/ws-ticket',
        expect.objectContaining({ method: 'POST', credentials: 'include' }),
      );
    });
  });

  it('callback ?session=ok flips to children after refresh()', async () => {
    window.history.replaceState(null, '', `/?session=ok`);
    const fetchImpl = stubFetch({
      '/api/auth/me': () => Response.json({ login: 'callback-user', github_id: '99' }),
      '/api/auth/ws-ticket': () =>
        Response.json({ ws_ticket: 't', expires_in: 60 }),
    });

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
    // URL cleaned: ?session removed.
    expect(window.location.search).toBe('');
  });

  it('signOut hits /api/auth/logout (reload stubbed)', async () => {
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        reload: reloadSpy,
        href: ORIGINAL_HREF,
        search: '',
        hash: '',
        pathname: '/',
      },
    });
    const fetchImpl = stubFetch({
      '/api/auth/logout': () => new Response('', { status: 204 }),
    });

    function SignOutButton() {
      const { signOut } = useAuth();
      return (
        <button
          type="button"
          onClick={() => {
            void signOut();
          }}
          data-testid="signout"
        >
          x
        </button>
      );
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
      expect(reloadSpy).toHaveBeenCalled();
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('signIn redirects to /api/auth/github/login', async () => {
    const seen: string[] = [];
    const fetchImpl = stubFetch({
      '/api/auth/me': () => new Response('', { status: 401 }),
    });

    render(
      <AuthProvider fetchImpl={fetchImpl} skipInitialRefresh>
        <HrefProbe onHref={(h) => seen.push(h)} />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByTestId('probe-signin'));
    expect(seen).toContain('/api/auth/github/login');
  });
});
