/**
 * R-51a (Task #167): GitHub Device Flow handler tests against the new uuid +
 * identity + email-index schema.
 *
 * Covers:
 *   - device/start happy path + malformed body
 *   - device/poll: pending / slow_down / expired / denied / 400 missing
 *   - device/poll happy path: linker writes user blob + identity, response
 *     carries user_id (NOT just login)
 *   - device/poll signs tunnel JWT with REFRESH key + sub=uuid (audit F-S-1)
 *   - device/poll state machine: pending → slow_down → success
 *   - tunnel/refresh: body now { tunnel_refresh_token, user_id }, rotation
 *     invalidates old token, claims.sub = uuid
 *   - tunnel/refresh: 400 on missing user_id, 401 on token mismatch
 *   - dispatchDevice routing
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchDevice,
  handleDeviceStart,
  handleDevicePoll,
  handleTunnelRefresh,
} from '../src/auth/deviceFlow';
import type { AuthEnv } from '../src/auth/bindings';
import { verifyJwt, type TunnelJwtClaims } from '../src/auth/jwt';

const KEY_HEX =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY_REFRESH_HEX =
  '99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa';

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
        if (req.method === 'POST' && path === '/setTunnelRefreshTokenHash') {
          const body = (await req.json()) as { hash: string };
          put('tunnel_refresh_hash', body.hash);
          return new Response(null, { status: 204 });
        }
        if (req.method === 'POST' && path === '/verifyTunnelRefreshTokenHash') {
          const body = (await req.json()) as { hash: string };
          return Response.json({ ok: get<string>('tunnel_refresh_hash') === body.hash });
        }
        if (req.method === 'GET' && path === '/getIdentity') {
          const rec = get<unknown>('identity_record');
          if (rec === undefined) return new Response('not found', { status: 404 });
          return Response.json(rec);
        }
        if (req.method === 'POST' && path === '/setIdentity') {
          put('identity_record', await req.json());
          return new Response(null, { status: 204 });
        }
        if (req.method === 'GET' && path === '/getEmailIndex') {
          const rec = get<unknown>('email_index_record');
          if (rec === undefined) return new Response('not found', { status: 404 });
          return Response.json(rec);
        }
        if (req.method === 'POST' && path === '/setEmailIndex') {
          put('email_index_record', await req.json());
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
    JWT_REFRESH_SIGNING_KEY: KEY_REFRESH_HEX,
    USER_DO: ns,
  } as AuthEnv;
  return { env, instances };
}

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function makeGithubFetch(routes: Record<string, Array<() => Response | Promise<Response>>>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url;
    for (const prefix of Object.keys(routes)) {
      if (url.startsWith(prefix)) {
        const next = routes[prefix]!.shift();
        if (!next) throw new Error('unexpected extra call to ' + prefix);
        return await next();
      }
    }
    throw new Error('unmocked fetch ' + url);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('handleDeviceStart', () => {
  it('proxies github device/code response on happy path', async () => {
    makeGithubFetch({
      'https://github.com/login/device/code': [
        () =>
          Response.json({
            device_code: 'devcode-xyz',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
      ],
    });
    const { env } = makeEnv();
    const res = await handleDeviceStart(
      new Request('https://example/api/auth/device/start', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.device_code).toBe('devcode-xyz');
    expect(body.user_code).toBe('WDJB-MJHT');
  });

  it('502s when github device/code returns malformed body', async () => {
    makeGithubFetch({
      'https://github.com/login/device/code': [() => Response.json({ user_code: 'oops' })],
    });
    const { env } = makeEnv();
    const res = await handleDeviceStart(
      new Request('https://example/api/auth/device/start', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(502);
  });
});

describe('handleDevicePoll (R-51a)', () => {
  it('returns {status: pending} when github says authorization_pending', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ error: 'authorization_pending', interval: 5 }),
      ],
    });
    const { env } = makeEnv();
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'd' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; interval: number };
    expect(body.status).toBe('pending');
    expect(body.interval).toBe(5);
  });

  it('returns {status: slow_down, interval} honoring github', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ error: 'slow_down', interval: 10 }),
      ],
    });
    const { env } = makeEnv();
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'd' }),
      }),
      env,
    );
    const body = (await res.json()) as { status: string; interval: number };
    expect(body.status).toBe('slow_down');
    expect(body.interval).toBe(10);
  });

  it('returns 410 {status: expired} on expired_token', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ error: 'expired_token' }),
      ],
    });
    const { env } = makeEnv();
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'd' }),
      }),
      env,
    );
    expect(res.status).toBe(410);
  });

  it('returns 403 {status: denied} on access_denied', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ error: 'access_denied' }),
      ],
    });
    const { env } = makeEnv();
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'd' }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('happy path (R-51a): linker mints user, response carries user_id + login', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ access_token: 'gh-access' }),
      ],
      'https://api.github.com/user': [
        () => Response.json({ id: 99, login: 'alice' }),
      ],
    });
    const { env, instances } = makeEnv();
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'd' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tunnel_jwt: string;
      tunnel_refresh_token: string;
      user_id: string;
      login: string;
    };
    expect(body.login).toBe('alice');
    expect(body.user_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.tunnel_refresh_token).toMatch(/^[0-9a-f]{64}$/);

    const claims = await verifyJwt<TunnelJwtClaims>(body.tunnel_jwt, KEY_REFRESH_HEX);
    expect(claims).not.toBeNull();
    // R-51a: sub is uuid (not github_id 99).
    expect(claims!.sub).toBe(body.user_id);
    expect(claims!.login).toBe('alice');
    expect(claims!.kind).toBe('tunnel');
    expect(claims!.exp - claims!.iat).toBe(60 * 60 * 24);

    // Identity row written keyed by identity:github:99.
    const identityInst = instances.get('identity:github:99');
    expect(identityInst).toBeDefined();
    expect((identityInst!.data.get('identity_record') as { user_id: string }).user_id).toBe(
      body.user_id,
    );

    // User blob written + tunnel_refresh_hash set.
    const userInst = instances.get(`user:${body.user_id}`);
    expect(userInst).toBeDefined();
    expect(typeof userInst!.data.get('tunnel_refresh_hash')).toBe('string');
  });

  it('audit F-S-1: tunnel_jwt is signed with REFRESH key (web key cannot verify)', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ access_token: 'gh-access' }),
      ],
      'https://api.github.com/user': [
        () => Response.json({ id: 99, login: 'alice' }),
      ],
    });
    const { env } = makeEnv();
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'd' }),
      }),
      env,
    );
    const body = (await res.json()) as { tunnel_jwt: string };
    expect(await verifyJwt<TunnelJwtClaims>(body.tunnel_jwt, KEY_REFRESH_HEX)).not.toBeNull();
    expect(await verifyJwt<TunnelJwtClaims>(body.tunnel_jwt, KEY_HEX)).toBeNull();
  });

  it('400s when device_code missing', async () => {
    const { env } = makeEnv();
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('full state machine: pending → slow_down → success', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ error: 'authorization_pending', interval: 5 }),
        () => Response.json({ error: 'slow_down', interval: 10 }),
        () => Response.json({ access_token: 'gh-access' }),
      ],
      'https://api.github.com/user': [
        () => Response.json({ id: 7, login: 'bob' }),
      ],
    });
    const { env } = makeEnv();
    const r1 = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'd' }),
      }),
      env,
    );
    expect(((await r1.json()) as { status: string }).status).toBe('pending');

    const r2 = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'd' }),
      }),
      env,
    );
    expect(((await r2.json()) as { status: string }).status).toBe('slow_down');

    const r3 = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'd' }),
      }),
      env,
    );
    expect(r3.status).toBe(200);
    const body = (await r3.json()) as { login: string; user_id: string };
    expect(body.login).toBe('bob');
    expect(body.user_id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('handleTunnelRefresh (R-51a)', () => {
  /** Drive a successful device-poll so we have a known {user_id, refresh}. */
  async function seedTunnel(env: AuthEnv): Promise<{
    user_id: string;
    token: string;
  }> {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ access_token: 'gh-access' }),
      ],
      'https://api.github.com/user': [
        () => Response.json({ id: 11, login: 'carol' }),
      ],
    });
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'd' }),
      }),
      env,
    );
    const body = (await res.json()) as {
      tunnel_refresh_token: string;
      user_id: string;
    };
    return { user_id: body.user_id, token: body.tunnel_refresh_token };
  }

  it('mints new tunnel jwt + new refresh, invalidates old (rotation)', async () => {
    const { env, instances } = makeEnv();
    const { user_id, token: oldToken } = await seedTunnel(env);
    const userBlobInst = instances.get(`user:${user_id}`)!;
    const oldHash = userBlobInst.data.get('tunnel_refresh_hash');

    globalThis.fetch = vi.fn(async () => {
      throw new Error('refresh should not call GitHub');
    }) as unknown as typeof fetch;

    const refreshRes = await handleTunnelRefresh(
      new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        body: JSON.stringify({ tunnel_refresh_token: oldToken, user_id }),
      }),
      env,
    );
    expect(refreshRes.status).toBe(200);
    const body = (await refreshRes.json()) as {
      tunnel_jwt: string;
      tunnel_refresh_token: string;
    };
    expect(body.tunnel_refresh_token).not.toBe(oldToken);

    const claims = await verifyJwt<TunnelJwtClaims>(body.tunnel_jwt, KEY_REFRESH_HEX);
    expect(claims!.sub).toBe(user_id);
    expect(claims!.login).toBe('carol');

    expect(userBlobInst.data.get('tunnel_refresh_hash')).not.toBe(oldHash);

    // Replay old token must 401.
    const replay = await handleTunnelRefresh(
      new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        body: JSON.stringify({ tunnel_refresh_token: oldToken, user_id }),
      }),
      env,
    );
    expect(replay.status).toBe(401);
  });

  it('401s when token does not match storage', async () => {
    const { env } = makeEnv();
    const { user_id } = await seedTunnel(env);
    const res = await handleTunnelRefresh(
      new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        body: JSON.stringify({ tunnel_refresh_token: 'wrong', user_id }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('400s when body missing user_id', async () => {
    const { env } = makeEnv();
    const res = await handleTunnelRefresh(
      new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        body: JSON.stringify({ tunnel_refresh_token: 'x' }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('400s when body missing tunnel_refresh_token', async () => {
    const { env } = makeEnv();
    const res = await handleTunnelRefresh(
      new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'uuid-x' }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('dispatchDevice', () => {
  it('returns null for non-device paths', async () => {
    const { env } = makeEnv();
    const res = await dispatchDevice(
      new Request('https://example/api/auth/github/login'),
      env,
    );
    expect(res).toBeNull();
  });

  it('routes /api/auth/device/start', async () => {
    makeGithubFetch({
      'https://github.com/login/device/code': [
        () =>
          Response.json({
            device_code: 'd',
            user_code: 'U',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
      ],
    });
    const { env } = makeEnv();
    const res = await dispatchDevice(
      new Request('https://example/api/auth/device/start', { method: 'POST' }),
      env,
    );
    expect(res!.status).toBe(200);
  });

  it('routes /api/auth/tunnel/refresh (400 on empty body)', async () => {
    const { env } = makeEnv();
    const res = await dispatchDevice(
      new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res!.status).toBe(400);
  });
});
