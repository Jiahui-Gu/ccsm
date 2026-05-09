/**
 * S4-T3 (Task #140): browser OAuth flow tests.
 *
 * Each handler is exercised against an in-memory UserDO fake + a stubbed
 * `globalThis.fetch` that pretends to be GitHub. We verify:
 *
 *   - login: 302 to github.com/login/oauth/authorize, csrf state baked into
 *     URL + matching HttpOnly cookie scoped to the callback path.
 *   - callback (happy path): csrf round-trips, code is exchanged, user is
 *     fetched, UserDO sees setLogin + setRefreshTokenHash, response is a 302
 *     with `#jwt=...` fragment + a refresh cookie.
 *   - callback (csrf mismatch): rejected before any GitHub call.
 *   - callback (token exchange error): 502 surfaced.
 *   - refresh: hash check happens, web JWT re-issued.
 *   - refresh (bad hash): 401.
 *   - logout: clears cookies + hits UserDO /revoke.
 *   - dispatchAuth: returns null for non-auth paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchAuth,
  handleGithubLogin,
  handleGithubCallback,
  handleRefresh,
  handleLogout,
} from '../src/auth/webOauth';
import type { AuthEnv } from '../src/auth/bindings';
import { signJwt, verifyJwt, type WebJwtClaims } from '../src/auth/jwt';

const KEY_HEX =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

interface UserDoState {
  github_id?: string;
  login?: string;
  refresh_hash?: string;
  created_at?: number;
  revoked: boolean;
}

interface UserDoFake {
  state: UserDoState;
  stub: { fetch: (req: Request) => Promise<Response> };
}

function makeUserDo(): UserDoFake {
  const state: UserDoState = { revoked: false };
  const stub = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === 'POST' && path === '/setLogin') {
        const body = (await req.json()) as { github_id: string; login: string };
        state.github_id = body.github_id;
        state.login = body.login;
        if (state.created_at === undefined) state.created_at = Math.floor(Date.now() / 1000);
        state.revoked = false;
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST' && path === '/setRefreshTokenHash') {
        const body = (await req.json()) as { hash: string };
        state.refresh_hash = body.hash;
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST' && path === '/verifyRefreshTokenHash') {
        const body = (await req.json()) as { hash: string };
        const ok = state.refresh_hash !== undefined && state.refresh_hash === body.hash;
        return Response.json({ ok });
      }
      if (req.method === 'GET' && path === '/getLogin') {
        if (state.github_id === undefined || state.login === undefined || state.created_at === undefined) {
          return new Response('not found', { status: 404 });
        }
        return Response.json({
          github_id: state.github_id,
          login: state.login,
          created_at: state.created_at,
        });
      }
      if (req.method === 'POST' && path === '/revoke') {
        state.github_id = undefined;
        state.login = undefined;
        state.refresh_hash = undefined;
        state.created_at = undefined;
        state.revoked = true;
        return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    },
  };
  return { state, stub };
}

function makeEnv(userDo: UserDoFake): AuthEnv {
  return {
    TUNNEL: undefined as unknown as DurableObjectNamespace,
    GITHUB_OAUTH_CLIENT_ID: 'test-client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'test-client-secret',
    JWT_SIGNING_KEY: KEY_HEX,
    JWT_REFRESH_SIGNING_KEY: KEY_HEX,
    USER_DO: {
      idFromName: (_name: string) => ({ name: _name }) as unknown as DurableObjectId,
      get: (_id: DurableObjectId) => userDo.stub as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
  } as AuthEnv;
}

/** Parse Set-Cookie headers off a Response into [name, value, attrs] tuples. */
function getSetCookies(res: Response): string[] {
  // Headers.getSetCookie exists in workerd + Node 22.
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  // Fallback: split on comma — fragile but unused on Node 22.
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(/,(?=\s*[A-Za-z_]+=)/) : [];
}

function findCookie(setCookies: string[], name: string): { value: string; attrs: string } | null {
  for (const c of setCookies) {
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    if (c.slice(0, eq).trim() === name) {
      const rest = c.slice(eq + 1);
      const semi = rest.indexOf(';');
      const value = (semi < 0 ? rest : rest.slice(0, semi)).trim();
      const attrs = semi < 0 ? '' : rest.slice(semi + 1);
      return { value, attrs };
    }
  }
  return null;
}

let realFetch: typeof fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('handleGithubLogin', () => {
  it('redirects to github with state + sets HttpOnly csrf cookie', () => {
    const userDo = makeUserDo();
    const env = makeEnv(userDo);
    const res = handleGithubLogin(new Request('https://example/api/auth/github/login'), env);
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location')!;
    expect(loc).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    const u = new URL(loc);
    expect(u.searchParams.get('client_id')).toBe('test-client-id');
    expect(u.searchParams.get('scope')).toBe('read:user');
    const state = u.searchParams.get('state')!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);

    const cookies = getSetCookies(res);
    const csrf = findCookie(cookies, 'csrf');
    expect(csrf).not.toBeNull();
    expect(csrf!.value).toBe(state);
    expect(csrf!.attrs).toMatch(/HttpOnly/);
    expect(csrf!.attrs).toMatch(/Secure/);
    expect(csrf!.attrs).toMatch(/SameSite=Lax/);
    expect(csrf!.attrs).toMatch(/Path=\/api\/auth\/github\/callback/);
  });
});

describe('handleGithubCallback', () => {
  function mockGithubFetch(opts: {
    accessToken?: string;
    tokenStatus?: number;
    tokenError?: string;
    userId?: number;
    userLogin?: string;
    userStatus?: number;
  }): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://github.com/login/oauth/access_token')) {
        if (opts.tokenStatus && opts.tokenStatus >= 400) {
          return new Response('bad', { status: opts.tokenStatus });
        }
        if (opts.tokenError) {
          return Response.json({ error: opts.tokenError });
        }
        return Response.json({ access_token: opts.accessToken ?? 'gh-access-token' });
      }
      if (url.startsWith('https://api.github.com/user')) {
        if (opts.userStatus && opts.userStatus >= 400) {
          return new Response('bad', { status: opts.userStatus });
        }
        return Response.json({ id: opts.userId ?? 7, login: opts.userLogin ?? 'octocat' });
      }
      void init;
      return new Response('unexpected url ' + url, { status: 599 });
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it('happy path: persists user, mints jwt + refresh, sets cookies, redirects', async () => {
    const userDo = makeUserDo();
    const env = makeEnv(userDo);
    const ghFetch = mockGithubFetch({ userId: 42, userLogin: 'alice' });

    const req = new Request(
      'https://example/api/auth/github/callback?code=abc&state=' + 'a'.repeat(64),
      { headers: { Cookie: 'csrf=' + 'a'.repeat(64) } },
    );
    const res = await handleGithubCallback(req, env);

    expect(res.status).toBe(302);
    const loc = res.headers.get('Location')!;
    expect(loc).toMatch(/^\/\?session=ok#jwt=/);
    const jwt = decodeURIComponent(loc.split('#jwt=')[1]!);
    const claims = await verifyJwt<WebJwtClaims>(jwt, KEY_HEX);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('42');
    expect(claims!.login).toBe('alice');
    expect(claims!.kind).toBe('web');
    // 1h TTL ± a few seconds.
    expect(claims!.exp - claims!.iat).toBe(3600);

    // UserDO state.
    expect(userDo.state.github_id).toBe('42');
    expect(userDo.state.login).toBe('alice');
    expect(userDo.state.refresh_hash).toMatch(/^[0-9a-f]{64}$/);

    // Cookies.
    const cookies = getSetCookies(res);
    const refresh = findCookie(cookies, 'refresh');
    expect(refresh).not.toBeNull();
    expect(refresh!.value).toMatch(/^[0-9a-f]{64}$/);
    expect(refresh!.attrs).toMatch(/HttpOnly/);
    expect(refresh!.attrs).toMatch(/Secure/);
    expect(refresh!.attrs).toMatch(/SameSite=Lax/);
    expect(refresh!.attrs).toMatch(/Path=\/api\/auth\/refresh/);

    const csrfClear = findCookie(cookies, 'csrf');
    expect(csrfClear).not.toBeNull();
    expect(csrfClear!.attrs).toMatch(/Max-Age=0/);

    const loginHint = findCookie(cookies, 'login');
    expect(loginHint).not.toBeNull();
    expect(loginHint!.value).toBe('alice');
    expect(loginHint!.attrs).toMatch(/HttpOnly/);
    expect(loginHint!.attrs).toMatch(/Path=\/api\/auth/);

    // Two GitHub calls happened (token exchange + user fetch).
    expect(ghFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects when csrf state cookie does not match query state', async () => {
    const env = makeEnv(makeUserDo());
    const ghFetch = mockGithubFetch({});
    const req = new Request(
      'https://example/api/auth/github/callback?code=abc&state=mismatch',
      { headers: { Cookie: 'csrf=somethingelse' } },
    );
    const res = await handleGithubCallback(req, env);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/csrf/i);
    // No GitHub call should have been made.
    expect(ghFetch).not.toHaveBeenCalled();
  });

  it('rejects when github token exchange returns an error payload', async () => {
    const userDo = makeUserDo();
    const env = makeEnv(userDo);
    mockGithubFetch({ tokenError: 'bad_verification_code' });
    const req = new Request(
      'https://example/api/auth/github/callback?code=expired&state=' + 'b'.repeat(64),
      { headers: { Cookie: 'csrf=' + 'b'.repeat(64) } },
    );
    const res = await handleGithubCallback(req, env);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/bad_verification_code/);
    expect(userDo.state.login).toBeUndefined();
  });

  it('rejects when github user fetch returns malformed body', async () => {
    const userDo = makeUserDo();
    const env = makeEnv(userDo);
    // GitHub returns 200 but body is missing id.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://github.com/login/oauth/access_token')) {
        return Response.json({ access_token: 't' });
      }
      return Response.json({ login: 'no-id' });
    }) as unknown as typeof fetch;
    const req = new Request(
      'https://example/api/auth/github/callback?code=abc&state=' + 'c'.repeat(64),
      { headers: { Cookie: 'csrf=' + 'c'.repeat(64) } },
    );
    const res = await handleGithubCallback(req, env);
    expect(res.status).toBe(502);
  });

  it('400s when code or state is missing', async () => {
    const env = makeEnv(makeUserDo());
    mockGithubFetch({});
    const r1 = await handleGithubCallback(
      new Request('https://example/api/auth/github/callback?state=x'),
      env,
    );
    expect(r1.status).toBe(400);
    const r2 = await handleGithubCallback(
      new Request('https://example/api/auth/github/callback?code=x'),
      env,
    );
    expect(r2.status).toBe(400);
  });
});

describe('handleRefresh', () => {
  it('mints a new web jwt when refresh hash matches', async () => {
    const userDo = makeUserDo();
    const env = makeEnv(userDo);
    // Pre-seed UserDO with a known login + refresh-hash pair.
    await userDo.stub.fetch(
      new Request('https://do/setLogin', {
        method: 'POST',
        body: JSON.stringify({ github_id: '42', login: 'alice' }),
      }),
    );
    const refreshToken = 'deadbeef'.repeat(8);
    const hashBytes = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refreshToken)),
    );
    let hashHex = '';
    for (const b of hashBytes) hashHex += b.toString(16).padStart(2, '0');
    await userDo.stub.fetch(
      new Request('https://do/setRefreshTokenHash', {
        method: 'POST',
        body: JSON.stringify({ hash: hashHex }),
      }),
    );

    const req = new Request('https://example/api/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `refresh=${refreshToken}; login=alice` },
    });
    const res = await handleRefresh(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { web_jwt: string };
    expect(typeof body.web_jwt).toBe('string');
    const claims = await verifyJwt<WebJwtClaims>(body.web_jwt, KEY_HEX);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('42');
    expect(claims!.login).toBe('alice');
    expect(claims!.kind).toBe('web');
  });

  it('401s when refresh cookie is absent', async () => {
    const env = makeEnv(makeUserDo());
    const res = await handleRefresh(
      new Request('https://example/api/auth/refresh', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('401s when refresh hash does not match', async () => {
    const userDo = makeUserDo();
    const env = makeEnv(userDo);
    await userDo.stub.fetch(
      new Request('https://do/setLogin', {
        method: 'POST',
        body: JSON.stringify({ github_id: '42', login: 'alice' }),
      }),
    );
    await userDo.stub.fetch(
      new Request('https://do/setRefreshTokenHash', {
        method: 'POST',
        body: JSON.stringify({ hash: 'expected' }),
      }),
    );
    const req = new Request('https://example/api/auth/refresh', {
      method: 'POST',
      headers: { Cookie: 'refresh=wrong-token; login=alice' },
    });
    const res = await handleRefresh(req, env);
    expect(res.status).toBe(401);
  });
});

describe('handleLogout', () => {
  it('clears cookies and revokes UserDO state', async () => {
    const userDo = makeUserDo();
    const env = makeEnv(userDo);
    await userDo.stub.fetch(
      new Request('https://do/setLogin', {
        method: 'POST',
        body: JSON.stringify({ github_id: '42', login: 'alice' }),
      }),
    );
    await userDo.stub.fetch(
      new Request('https://do/setRefreshTokenHash', {
        method: 'POST',
        body: JSON.stringify({ hash: 'h' }),
      }),
    );

    const res = await handleLogout(
      new Request('https://example/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: 'login=alice; refresh=whatever' },
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(userDo.state.revoked).toBe(true);
    expect(userDo.state.login).toBeUndefined();

    const cookies = getSetCookies(res);
    const refresh = findCookie(cookies, 'refresh');
    expect(refresh).not.toBeNull();
    expect(refresh!.attrs).toMatch(/Max-Age=0/);
    const loginHint = findCookie(cookies, 'login');
    expect(loginHint).not.toBeNull();
    expect(loginHint!.attrs).toMatch(/Max-Age=0/);
  });

  it('still 204s when no cookies are present (best-effort)', async () => {
    const env = makeEnv(makeUserDo());
    const res = await handleLogout(
      new Request('https://example/api/auth/logout', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(204);
  });
});

describe('dispatchAuth', () => {
  it('returns null for paths outside /api/auth/*', async () => {
    const env = makeEnv(makeUserDo());
    const res = await dispatchAuth(
      new Request('https://example/api/sessions'),
      env,
    );
    expect(res).toBeNull();
  });

  it('routes /api/auth/github/login to handleGithubLogin', async () => {
    const env = makeEnv(makeUserDo());
    const res = await dispatchAuth(
      new Request('https://example/api/auth/github/login'),
      env,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
  });

  // Make sure signJwt is referenced by the type-only import path so the lint
  // step doesn't drop it as unused. (We use signJwt indirectly via handlers.)
  it('signJwt + verifyJwt are accessible', async () => {
    const claims: WebJwtClaims = {
      sub: '1',
      login: 'a',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      kind: 'web',
    };
    const t = await signJwt(claims, KEY_HEX);
    const v = await verifyJwt<WebJwtClaims>(t, KEY_HEX);
    expect(v?.sub).toBe('1');
  });
});
