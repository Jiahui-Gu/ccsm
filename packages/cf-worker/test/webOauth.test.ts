/**
 * R-51a (Task #167): web OAuth flow tests against the new uuid + identity +
 * email-index schema. The worker calls into oauthLinker.decideAndLink which
 * reaches multiple UserDO instances (user blob, identity row, email index)
 * via different idFromName(...) keys, so the test fake routes per-instance
 * storage off the idFromName string.
 *
 * Covers:
 *   - login: 302 to github.com/login/oauth/authorize, csrf cookie scoped to
 *     callback path.
 *   - callback (audit F-S-4 + R-51a): user_id-based JWT (sub=uuid), web_jwt
 *     HttpOnly cookie, refresh cookie, `uid` hint cookie (replaces old
 *     `login` hint), 302 to /?session=ok.
 *   - callback (csrf mismatch): 400 before any GitHub call.
 *   - callback (token exchange error): 502.
 *   - refresh (R-51a + audit F-S-5): hint cookie is `uid`, idFromName uses
 *     `user:<uuid>`, claims.sub = uuid; rotation invalidates old token.
 *   - refresh (bad hash): 401.
 *   - me + ws-ticket: cookie-based session probes, /me returns user_id.
 *   - logout: clears cookies (incl. web_jwt + uid hint) + UserDO /revoke.
 *   - dispatchAuth: routing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchAuth,
  handleGithubLogin,
  handleGithubCallback,
  handleMe,
  handleRefresh,
  handleLogout,
  handleWsTicket,
} from '../src/auth/webOauth';
import type { AuthEnv } from '../src/auth/bindings';
import { signJwt, verifyJwt, type WebJwtClaims } from '../src/auth/jwt';

const KEY_HEX =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

interface DoState {
  data: Map<string, unknown>;
}

function makeUserDoNamespace(): {
  ns: DurableObjectNamespace;
  instances: Map<string, DoState>;
} {
  const instances = new Map<string, DoState>();
  function getOrCreate(name: string): DoState {
    let inst = instances.get(name);
    if (!inst) {
      inst = { data: new Map() };
      instances.set(name, inst);
    }
    return inst;
  }
  function makeStub(name: string): DurableObjectStub {
    const inst = getOrCreate(name);
    return {
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const path = url.pathname;
        const get = <T,>(k: string): T | undefined =>
          inst.data.has(k) ? (inst.data.get(k) as T) : undefined;
        const put = (k: string, v: unknown) => inst.data.set(k, v);
        const del = (k: string) => inst.data.delete(k);

        // user-blob role
        if (req.method === 'GET' && path === '/getUserBlob') {
          const user_id = get<string>('user_id');
          const primary_login = get<string>('primary_login');
          const created_at = get<number>('created_at');
          if (user_id === undefined || primary_login === undefined || created_at === undefined) {
            return new Response('not found', { status: 404 });
          }
          return Response.json({ user_id, primary_login, created_at });
        }
        if (req.method === 'POST' && path === '/setUserBlob') {
          const body = (await req.json()) as { user_id: string; primary_login: string };
          put('user_id', body.user_id);
          put('primary_login', body.primary_login);
          if (get<number>('created_at') === undefined) put('created_at', 1700000000);
          return new Response(null, { status: 204 });
        }
        if (req.method === 'POST' && path === '/setRefreshTokenHash') {
          const body = (await req.json()) as { hash: string };
          put('refresh_hash', body.hash);
          return new Response(null, { status: 204 });
        }
        if (req.method === 'POST' && path === '/verifyRefreshTokenHash') {
          const body = (await req.json()) as { hash: string };
          return Response.json({ ok: get<string>('refresh_hash') === body.hash });
        }
        if (req.method === 'POST' && path === '/setTunnelRefreshTokenHash') {
          const body = (await req.json()) as { hash: string };
          put('tunnel_refresh_hash', body.hash);
          return new Response(null, { status: 204 });
        }
        if (req.method === 'POST' && path === '/verifyTunnelRefreshTokenHash') {
          const body = (await req.json()) as { hash: string };
          return Response.json({ ok: get<string>('tunnel_refresh_hash') === body.hash });
        }
        if (req.method === 'POST' && path === '/revoke') {
          inst.data.clear();
          return new Response(null, { status: 204 });
        }

        // identity role
        if (req.method === 'GET' && path === '/getIdentity') {
          const rec = get<unknown>('identity_record');
          if (rec === undefined) return new Response('not found', { status: 404 });
          return Response.json(rec);
        }
        if (req.method === 'POST' && path === '/setIdentity') {
          put('identity_record', await req.json());
          return new Response(null, { status: 204 });
        }

        // email-index role
        if (req.method === 'GET' && path === '/getEmailIndex') {
          const rec = get<unknown>('email_index_record');
          if (rec === undefined) return new Response('not found', { status: 404 });
          return Response.json(rec);
        }
        if (req.method === 'POST' && path === '/setEmailIndex') {
          put('email_index_record', await req.json());
          return new Response(null, { status: 204 });
        }
        if (req.method === 'POST' && path === '/clearEmailIndex') {
          del('email_index_record');
          return new Response(null, { status: 204 });
        }

        return new Response('not found', { status: 404 });
      },
    } as unknown as DurableObjectStub;
  }
  const ns = {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => makeStub((id as unknown as { name: string }).name),
  } as unknown as DurableObjectNamespace;
  return { ns, instances };
}

function makeEnv(): { env: AuthEnv; instances: Map<string, DoState> } {
  const { ns, instances } = makeUserDoNamespace();
  const env = {
    TUNNEL: undefined as unknown as DurableObjectNamespace,
    GITHUB_OAUTH_CLIENT_ID: 'test-client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'test-client-secret',
    JWT_SIGNING_KEY: KEY_HEX,
    JWT_REFRESH_SIGNING_KEY: KEY_HEX,
    USER_DO: ns,
  } as AuthEnv;
  return { env, instances };
}

function getSetCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
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

function mockGithubFetch(opts: {
  accessToken?: string;
  tokenStatus?: number;
  tokenError?: string;
  userId?: number;
  userLogin?: string;
  userEmail?: string | null;
  userStatus?: number;
}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      if (opts.tokenStatus && opts.tokenStatus >= 400) {
        return new Response('bad', { status: opts.tokenStatus });
      }
      if (opts.tokenError) return Response.json({ error: opts.tokenError });
      return Response.json({ access_token: opts.accessToken ?? 'gh-access-token' });
    }
    if (url.startsWith('https://api.github.com/user')) {
      if (opts.userStatus && opts.userStatus >= 400) {
        return new Response('bad', { status: opts.userStatus });
      }
      return Response.json({
        id: opts.userId ?? 7,
        login: opts.userLogin ?? 'octocat',
        email: opts.userEmail ?? null,
      });
    }
    return new Response('unexpected url ' + url, { status: 599 });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('handleGithubLogin', () => {
  it('redirects to github with state + sets HttpOnly csrf cookie', () => {
    const { env } = makeEnv();
    const res = handleGithubLogin(new Request('https://example/api/auth/github/login'), env);
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location')!;
    expect(loc).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    const u = new URL(loc);
    expect(u.searchParams.get('client_id')).toBe('test-client-id');
    expect(u.searchParams.get('scope')).toBe('read:user');
    const state = u.searchParams.get('state')!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    const csrf = findCookie(getSetCookies(res), 'csrf');
    expect(csrf).not.toBeNull();
    expect(csrf!.value).toBe(state);
    expect(csrf!.attrs).toMatch(/HttpOnly/);
    expect(csrf!.attrs).toMatch(/Path=\/api\/auth\/github\/callback/);
  });
});

describe('handleGithubCallback (R-51a)', () => {
  it('happy path: linker creates user, web_jwt sub=uuid, refresh + uid hint cookies set', async () => {
    const { env, instances } = makeEnv();
    const ghFetch = mockGithubFetch({ userId: 42, userLogin: 'alice' });

    const req = new Request(
      'https://example/api/auth/github/callback?code=abc&state=' + 'a'.repeat(64),
      { headers: { Cookie: 'csrf=' + 'a'.repeat(64) } },
    );
    const res = await handleGithubCallback(req, env);

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/?session=ok');

    const cookies = getSetCookies(res);
    const webJwtCookie = findCookie(cookies, 'web_jwt');
    expect(webJwtCookie).not.toBeNull();
    expect(webJwtCookie!.attrs).toMatch(/HttpOnly/);
    expect(webJwtCookie!.attrs).toMatch(/SameSite=Strict/);
    const claims = await verifyJwt<WebJwtClaims>(webJwtCookie!.value, KEY_HEX);
    expect(claims).not.toBeNull();
    // R-51a: sub is the uuid, NOT the github_id.
    expect(claims!.sub).not.toBe('42');
    expect(claims!.sub).toMatch(/^[0-9a-f-]{36}$/i);
    expect(claims!.login).toBe('alice');
    expect(claims!.kind).toBe('web');

    // Identity row keyed by identity:github:42 written to its own DO instance.
    const identityInst = instances.get('identity:github:42');
    expect(identityInst).toBeDefined();
    const identityRec = identityInst!.data.get('identity_record') as { user_id: string };
    expect(identityRec.user_id).toBe(claims!.sub);

    // User blob keyed by user:<uuid> written + has refresh_hash.
    const userInst = instances.get(`user:${claims!.sub}`);
    expect(userInst).toBeDefined();
    expect(typeof userInst!.data.get('refresh_hash')).toBe('string');

    // R-51a: uid hint cookie carries the uuid (not login).
    const uidHint = findCookie(cookies, 'uid');
    expect(uidHint).not.toBeNull();
    expect(uidHint!.value).toBe(claims!.sub);
    expect(uidHint!.attrs).toMatch(/Path=\/api\/auth/);

    // Old `login` hint cookie must NOT be set (renamed to uid).
    expect(findCookie(cookies, 'login')).toBeNull();

    expect(ghFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects when csrf state cookie does not match query state', async () => {
    const { env } = makeEnv();
    const ghFetch = mockGithubFetch({});
    const res = await handleGithubCallback(
      new Request('https://example/api/auth/github/callback?code=abc&state=mismatch', {
        headers: { Cookie: 'csrf=somethingelse' },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(ghFetch).not.toHaveBeenCalled();
  });

  it('rejects when github token exchange returns an error payload', async () => {
    const { env } = makeEnv();
    mockGithubFetch({ tokenError: 'bad_verification_code' });
    const res = await handleGithubCallback(
      new Request('https://example/api/auth/github/callback?code=expired&state=' + 'b'.repeat(64), {
        headers: { Cookie: 'csrf=' + 'b'.repeat(64) },
      }),
      env,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/bad_verification_code/);
  });

  it('rejects when github user fetch returns malformed body', async () => {
    const { env } = makeEnv();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://github.com/login/oauth/access_token')) {
        return Response.json({ access_token: 't' });
      }
      return Response.json({ login: 'no-id' });
    }) as unknown as typeof fetch;
    const res = await handleGithubCallback(
      new Request('https://example/api/auth/github/callback?code=abc&state=' + 'c'.repeat(64), {
        headers: { Cookie: 'csrf=' + 'c'.repeat(64) },
      }),
      env,
    );
    expect(res.status).toBe(502);
  });

  it('400s when code or state is missing', async () => {
    const { env } = makeEnv();
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

describe('handleRefresh (R-51a)', () => {
  /** Drive a callback so UserDO has a uuid + login + refresh hash. Returns
   *  the uuid + the fresh refresh token captured from Set-Cookie. */
  async function seedSession(env: AuthEnv): Promise<{
    uid: string;
    refreshToken: string;
  }> {
    mockGithubFetch({ userId: 42, userLogin: 'alice' });
    const res = await handleGithubCallback(
      new Request('https://example/api/auth/github/callback?code=c&state=' + 'a'.repeat(64), {
        headers: { Cookie: 'csrf=' + 'a'.repeat(64) },
      }),
      env,
    );
    const cookies = getSetCookies(res);
    const uid = findCookie(cookies, 'uid')!.value;
    const refreshToken = findCookie(cookies, 'refresh')!.value;
    return { uid, refreshToken };
  }

  it('mints a new web jwt + rotates refresh cookie when uid hint matches stored hash', async () => {
    const { env } = makeEnv();
    const { uid, refreshToken } = await seedSession(env);

    const res = await handleRefresh(
      new Request('https://example/api/auth/refresh', {
        method: 'POST',
        headers: { Cookie: `refresh=${refreshToken}; uid=${uid}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { web_jwt: string; login: string };
    expect(body.login).toBe('alice');
    const claims = await verifyJwt<WebJwtClaims>(body.web_jwt, KEY_HEX);
    expect(claims!.sub).toBe(uid);

    const cookies = getSetCookies(res);
    const newRefresh = findCookie(cookies, 'refresh');
    expect(newRefresh).not.toBeNull();
    expect(newRefresh!.value).not.toBe(refreshToken);

    const newWebJwt = findCookie(cookies, 'web_jwt');
    expect(newWebJwt).not.toBeNull();
  });

  it('audit F-S-5: presenting the old refresh token after rotation 401s', async () => {
    const { env } = makeEnv();
    const { uid, refreshToken } = await seedSession(env);

    const r1 = await handleRefresh(
      new Request('https://example/api/auth/refresh', {
        method: 'POST',
        headers: { Cookie: `refresh=${refreshToken}; uid=${uid}` },
      }),
      env,
    );
    expect(r1.status).toBe(200);

    const r2 = await handleRefresh(
      new Request('https://example/api/auth/refresh', {
        method: 'POST',
        headers: { Cookie: `refresh=${refreshToken}; uid=${uid}` },
      }),
      env,
    );
    expect(r2.status).toBe(401);
  });

  it('401s when refresh cookie is absent', async () => {
    const { env } = makeEnv();
    const res = await handleRefresh(
      new Request('https://example/api/auth/refresh', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('401s when uid hint cookie is absent', async () => {
    const { env } = makeEnv();
    const res = await handleRefresh(
      new Request('https://example/api/auth/refresh', {
        method: 'POST',
        headers: { Cookie: 'refresh=abc' },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('401s when refresh hash does not match stored', async () => {
    const { env } = makeEnv();
    const { uid } = await seedSession(env);
    const res = await handleRefresh(
      new Request('https://example/api/auth/refresh', {
        method: 'POST',
        headers: { Cookie: `refresh=wrong; uid=${uid}` },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe('handleLogout (R-51a)', () => {
  it('clears cookies (incl. uid hint + web_jwt) and revokes the user blob', async () => {
    const { env, instances } = makeEnv();
    mockGithubFetch({ userId: 42, userLogin: 'alice' });
    const cb = await handleGithubCallback(
      new Request('https://example/api/auth/github/callback?code=c&state=' + 'a'.repeat(64), {
        headers: { Cookie: 'csrf=' + 'a'.repeat(64) },
      }),
      env,
    );
    const uid = findCookie(getSetCookies(cb), 'uid')!.value;
    expect(instances.get(`user:${uid}`)?.data.size).toBeGreaterThan(0);

    const res = await handleLogout(
      new Request('https://example/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: `uid=${uid}; refresh=whatever` },
      }),
      env,
    );
    expect(res.status).toBe(204);
    // Revoke wiped the user blob storage.
    expect(instances.get(`user:${uid}`)?.data.size).toBe(0);

    const cookies = getSetCookies(res);
    expect(findCookie(cookies, 'refresh')!.attrs).toMatch(/Max-Age=0/);
    expect(findCookie(cookies, 'uid')!.attrs).toMatch(/Max-Age=0/);
    expect(findCookie(cookies, 'web_jwt')!.attrs).toMatch(/Max-Age=0/);
  });

  it('still 204s when no cookies present (best-effort)', async () => {
    const { env } = makeEnv();
    const res = await handleLogout(
      new Request('https://example/api/auth/logout', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(204);
  });
});

describe('handleMe (R-51a)', () => {
  it('returns {login, user_id} when web_jwt cookie is valid', async () => {
    const { env } = makeEnv();
    const claims: WebJwtClaims = {
      sub: 'uuid-7',
      login: 'octocat',
      iat: Math.floor(Date.now() / 1000) - 1,
      exp: Math.floor(Date.now() / 1000) + 600,
      kind: 'web',
    };
    const jwt = await signJwt(claims, KEY_HEX);
    const res = await handleMe(
      new Request('https://example/api/auth/me', { headers: { Cookie: `web_jwt=${jwt}` } }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { login: string; user_id: string };
    expect(body.login).toBe('octocat');
    expect(body.user_id).toBe('uuid-7');
    // R-51a: response no longer carries github_id.
    expect((body as Record<string, unknown>).github_id).toBeUndefined();
  });

  it('401s when no web_jwt cookie', async () => {
    const { env } = makeEnv();
    const res = await handleMe(new Request('https://example/api/auth/me'), env);
    expect(res.status).toBe(401);
  });

  it('401s when web_jwt cookie signed with the wrong key', async () => {
    const { env } = makeEnv();
    const wrongKey = 'ff'.repeat(32);
    const jwt = await signJwt(
      {
        sub: 'uuid-7',
        login: 'a',
        iat: Math.floor(Date.now() / 1000) - 1,
        exp: Math.floor(Date.now() / 1000) + 60,
        kind: 'web',
      },
      wrongKey,
    );
    const res = await handleMe(
      new Request('https://example/api/auth/me', { headers: { Cookie: `web_jwt=${jwt}` } }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('401s when web_jwt cookie is a tunnel-kind JWT (kind mismatch)', async () => {
    const { env } = makeEnv();
    const jwt = await signJwt(
      {
        sub: 'uuid-7',
        login: 'a',
        iat: Math.floor(Date.now() / 1000) - 1,
        exp: Math.floor(Date.now() / 1000) + 60,
        kind: 'tunnel',
        jti: 'x',
      } as never,
      KEY_HEX,
    );
    const res = await handleMe(
      new Request('https://example/api/auth/me', { headers: { Cookie: `web_jwt=${jwt}` } }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe('handleWsTicket', () => {
  it('mints a 60s ticket when cookie session is valid', async () => {
    const { env } = makeEnv();
    const sessionClaims: WebJwtClaims = {
      sub: 'uuid-11',
      login: 'carol',
      iat: Math.floor(Date.now() / 1000) - 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
      kind: 'web',
    };
    const sessionJwt = await signJwt(sessionClaims, KEY_HEX);
    const res = await handleWsTicket(
      new Request('https://example/api/auth/ws-ticket', {
        method: 'POST',
        headers: { Cookie: `web_jwt=${sessionJwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ws_ticket: string; expires_in: number };
    expect(body.expires_in).toBe(60);
    const ticketClaims = await verifyJwt<WebJwtClaims>(body.ws_ticket, KEY_HEX);
    expect(ticketClaims!.sub).toBe('uuid-11');
    expect(ticketClaims!.exp - ticketClaims!.iat).toBe(60);
  });

  it('401s when cookie absent', async () => {
    const { env } = makeEnv();
    const res = await handleWsTicket(
      new Request('https://example/api/auth/ws-ticket', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('401s when cookie session is expired', async () => {
    const { env } = makeEnv();
    const expired = await signJwt(
      {
        sub: 'uuid-11',
        login: 'carol',
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 60,
        kind: 'web',
      },
      KEY_HEX,
    );
    const res = await handleWsTicket(
      new Request('https://example/api/auth/ws-ticket', {
        method: 'POST',
        headers: { Cookie: `web_jwt=${expired}` },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe('dispatchAuth', () => {
  it('returns null for paths outside /api/auth/*', async () => {
    const { env } = makeEnv();
    const res = await dispatchAuth(new Request('https://example/api/sessions'), env);
    expect(res).toBeNull();
  });

  it('routes /api/auth/github/login', async () => {
    const { env } = makeEnv();
    const res = await dispatchAuth(new Request('https://example/api/auth/github/login'), env);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
  });

  it('routes GET /api/auth/me (401 without cookie)', async () => {
    const { env } = makeEnv();
    const res = await dispatchAuth(new Request('https://example/api/auth/me'), env);
    expect(res!.status).toBe(401);
  });

  it('routes POST /api/auth/ws-ticket (401 without cookie)', async () => {
    const { env } = makeEnv();
    const res = await dispatchAuth(
      new Request('https://example/api/auth/ws-ticket', { method: 'POST' }),
      env,
    );
    expect(res!.status).toBe(401);
  });

  it('signJwt + verifyJwt round-trip', async () => {
    const claims: WebJwtClaims = {
      sub: 'uuid-1',
      login: 'a',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      kind: 'web',
    };
    const t = await signJwt(claims, KEY_HEX);
    const v = await verifyJwt<WebJwtClaims>(t, KEY_HEX);
    expect(v?.sub).toBe('uuid-1');
  });
});
