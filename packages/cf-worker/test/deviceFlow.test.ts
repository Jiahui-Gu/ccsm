/**
 * S4-T4 (Task #142): GitHub Device Flow handler tests.
 *
 * Mocks `globalThis.fetch` with the GitHub device-flow shape, drives the
 * three handlers + dispatcher:
 *   - device/start happy path
 *   - device/poll: pending → success state machine
 *   - device/poll: slow_down honors GitHub's new interval
 *   - device/poll: expired_token (410) + access_denied (403)
 *   - tunnel/refresh: rotation invalidates the old refresh token
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

interface UserDoState {
  github_id?: string;
  login?: string;
  refresh_hash?: string;
  tunnel_refresh_hash?: string;
  created_at?: number;
}

interface UserDoFake {
  state: UserDoState;
  stub: { fetch: (req: Request) => Promise<Response> };
}

function makeUserDo(): UserDoFake {
  const state: UserDoState = {};
  const stub = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === 'POST' && path === '/setLogin') {
        const body = (await req.json()) as { github_id: string; login: string };
        state.github_id = body.github_id;
        state.login = body.login;
        if (state.created_at === undefined) state.created_at = Math.floor(Date.now() / 1000);
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST' && path === '/setTunnelRefreshTokenHash') {
        const body = (await req.json()) as { hash: string };
        state.tunnel_refresh_hash = body.hash;
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST' && path === '/verifyTunnelRefreshTokenHash') {
        const body = (await req.json()) as { hash: string };
        const ok =
          state.tunnel_refresh_hash !== undefined &&
          state.tunnel_refresh_hash === body.hash;
        return Response.json({ ok });
      }
      if (req.method === 'GET' && path === '/getLogin') {
        if (
          state.github_id === undefined ||
          state.login === undefined ||
          state.created_at === undefined
        ) {
          return new Response('not found', { status: 404 });
        }
        return Response.json({
          github_id: state.github_id,
          login: state.login,
          created_at: state.created_at,
        });
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

let realFetch: typeof fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/**
 * Sequence-driven GitHub mock. Each call to a given URL pops the next
 * response off the queue for that URL. Throws if the queue is empty so we
 * see "unexpected extra call" instead of silent reuse.
 */
function makeGithubFetch(routes: Record<string, Array<() => Response | Promise<Response>>>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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
    const env = makeEnv(makeUserDo());
    const res = await handleDeviceStart(
      new Request('https://example/api/auth/device/start', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.device_code).toBe('devcode-xyz');
    expect(body.user_code).toBe('WDJB-MJHT');
    expect(body.verification_uri).toBe('https://github.com/login/device');
    expect(body.expires_in).toBe(900);
    expect(body.interval).toBe(5);
  });

  it('502s when github device/code returns malformed body', async () => {
    makeGithubFetch({
      'https://github.com/login/device/code': [
        () => Response.json({ user_code: 'oops-no-device-code' }),
      ],
    });
    const env = makeEnv(makeUserDo());
    const res = await handleDeviceStart(
      new Request('https://example/api/auth/device/start', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(502);
  });
});

describe('handleDevicePoll', () => {
  it('returns {status: pending} when github says authorization_pending', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ error: 'authorization_pending', interval: 5 }),
      ],
    });
    const env = makeEnv(makeUserDo());
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'devcode-xyz' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; interval: number };
    expect(body.status).toBe('pending');
    expect(body.interval).toBe(5);
  });

  it('returns {status: slow_down, interval} honoring github new interval', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ error: 'slow_down', interval: 10 }),
      ],
    });
    const env = makeEnv(makeUserDo());
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'devcode-xyz' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; interval: number };
    expect(body.status).toBe('slow_down');
    expect(body.interval).toBe(10);
  });

  it('returns 410 {status: expired} when github says expired_token', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ error: 'expired_token' }),
      ],
    });
    const env = makeEnv(makeUserDo());
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'devcode-xyz' }),
      }),
      env,
    );
    expect(res.status).toBe(410);
    expect(((await res.json()) as { status: string }).status).toBe('expired');
  });

  it('returns 403 {status: denied} when github says access_denied', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ error: 'access_denied' }),
      ],
    });
    const env = makeEnv(makeUserDo());
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'devcode-xyz' }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { status: string }).status).toBe('denied');
  });

  it('happy path: persists user, mints tunnel jwt + tunnel refresh', async () => {
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ access_token: 'gh-access' }),
      ],
      'https://api.github.com/user': [
        () => Response.json({ id: 99, login: 'alice' }),
      ],
    });
    const userDo = makeUserDo();
    const env = makeEnv(userDo);
    const res = await handleDevicePoll(
      new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        body: JSON.stringify({ device_code: 'devcode-xyz' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tunnel_jwt: string;
      tunnel_refresh_token: string;
      login: string;
    };
    expect(body.login).toBe('alice');
    expect(body.tunnel_refresh_token).toMatch(/^[0-9a-f]{64}$/);

    const claims = await verifyJwt<TunnelJwtClaims>(body.tunnel_jwt, KEY_HEX);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('99');
    expect(claims!.login).toBe('alice');
    expect(claims!.kind).toBe('tunnel');
    expect(claims!.exp - claims!.iat).toBe(60 * 60 * 24);
    expect(typeof claims!.jti).toBe('string');
    expect(claims!.jti.length).toBeGreaterThan(0);

    expect(userDo.state.github_id).toBe('99');
    expect(userDo.state.login).toBe('alice');
    expect(userDo.state.tunnel_refresh_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('400s when device_code is missing from body', async () => {
    const env = makeEnv(makeUserDo());
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
    let userMock = false;
    makeGithubFetch({
      'https://github.com/login/oauth/access_token': [
        () => Response.json({ error: 'authorization_pending', interval: 5 }),
        () => Response.json({ error: 'slow_down', interval: 10 }),
        () => Response.json({ access_token: 'gh-access' }),
      ],
      'https://api.github.com/user': [
        () => {
          userMock = true;
          return Response.json({ id: 7, login: 'bob' });
        },
      ],
    });
    const userDo = makeUserDo();
    const env = makeEnv(userDo);

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
    const body = (await r3.json()) as { login: string };
    expect(body.login).toBe('bob');
    expect(userMock).toBe(true);
    expect(userDo.state.login).toBe('bob');
  });
});

describe('handleTunnelRefresh', () => {
  /** Helper: drive a device-poll happy path so UserDO has a tunnel refresh. */
  async function seedTunnel(userDo: UserDoFake, env: AuthEnv): Promise<{
    token: string;
    login: string;
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
      login: string;
    };
    return { token: body.tunnel_refresh_token, login: body.login };
  }

  it('mints new tunnel jwt + new refresh, invalidates old refresh (rotation)', async () => {
    const userDo = makeUserDo();
    const env = makeEnv(userDo);
    const { token: oldToken, login } = await seedTunnel(userDo, env);
    const oldHash = userDo.state.tunnel_refresh_hash!;

    // No GitHub fetch happens during refresh.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('refresh should not call GitHub');
    }) as unknown as typeof fetch;

    const refreshRes = await handleTunnelRefresh(
      new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        body: JSON.stringify({ tunnel_refresh_token: oldToken, login }),
      }),
      env,
    );
    expect(refreshRes.status).toBe(200);
    const body = (await refreshRes.json()) as {
      tunnel_jwt: string;
      tunnel_refresh_token: string;
    };
    expect(body.tunnel_refresh_token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.tunnel_refresh_token).not.toBe(oldToken);

    const claims = await verifyJwt<TunnelJwtClaims>(body.tunnel_jwt, KEY_HEX);
    expect(claims).not.toBeNull();
    expect(claims!.kind).toBe('tunnel');
    expect(claims!.login).toBe('carol');

    // Storage rotated.
    expect(userDo.state.tunnel_refresh_hash).not.toBe(oldHash);

    // The OLD token must no longer verify.
    const replay = await handleTunnelRefresh(
      new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        body: JSON.stringify({ tunnel_refresh_token: oldToken, login }),
      }),
      env,
    );
    expect(replay.status).toBe(401);
  });

  it('401s when token does not match storage', async () => {
    const userDo = makeUserDo();
    const env = makeEnv(userDo);
    await seedTunnel(userDo, env);
    const res = await handleTunnelRefresh(
      new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        body: JSON.stringify({ tunnel_refresh_token: 'wrong', login: 'carol' }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('400s when body is missing fields', async () => {
    const env = makeEnv(makeUserDo());
    const res = await handleTunnelRefresh(
      new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        body: JSON.stringify({ login: 'only-login' }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('dispatchDevice', () => {
  it('returns null for non-device paths', async () => {
    const env = makeEnv(makeUserDo());
    const res = await dispatchDevice(
      new Request('https://example/api/auth/github/login'),
      env,
    );
    expect(res).toBeNull();
  });

  it('routes /api/auth/device/start to handleDeviceStart', async () => {
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
    const env = makeEnv(makeUserDo());
    const res = await dispatchDevice(
      new Request('https://example/api/auth/device/start', { method: 'POST' }),
      env,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  it('routes /api/auth/tunnel/refresh to handleTunnelRefresh (400 on empty body)', async () => {
    const env = makeEnv(makeUserDo());
    const res = await dispatchDevice(
      new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });
});
