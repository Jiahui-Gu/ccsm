/**
 * S4-T5 (Task #136): cf-worker JWT routing integration tests.
 *
 * We exercise the worker's `fetch` handler directly with a fake
 * DurableObjectNamespace that records every `idFromName` invocation, so we
 * can assert:
 *
 *   - legacy mode (default): all routes still hit `idFromName('default')`,
 *     no JWT required (regression guard for the 85+ S3-era tests).
 *   - jwt mode: /ws/default + /tunnel/default + /api/* + /token reject
 *     unauthenticated requests with 401.
 *   - jwt mode cross-user isolation: alice's JWT routes into
 *     `user:<alice_github_id>`, bob's JWT routes into `user:<bob_github_id>`,
 *     and the two never collide.
 *   - jwt mode browser path: identity headers (X-CCSM-Identity-Login /
 *     X-CCSM-Identity-Id) are added to the request forwarded into the DO so
 *     the DO can echo them inside the daemon hello frame (Task #133 wire).
 *   - jwt mode expired token: 401 (browser-side ws upgrade, since we cannot
 *     open the socket from worker layer; the SPA close handler will surface
 *     this as auth failure to the user).
 */
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { signJwt, type WebJwtClaims, type TunnelJwtClaims } from '../src/auth/jwt';

const KEY_WEB =
  '11112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY_TUNNEL = '22ee'.repeat(16);

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

interface RecordedFetch {
  idName: string;
  url: string;
  headers: Record<string, string>;
}

function makeFakeNamespace(handler: (req: Request, idName: string) => Response | Promise<Response>) {
  const calls: RecordedFetch[] = [];
  const ns = {
    idFromName(name: string) {
      return { __idName: name } as unknown as DurableObjectId;
    },
    get(id: { __idName: string }) {
      return {
        async fetch(req: Request) {
          const headers: Record<string, string> = {};
          req.headers.forEach((v, k) => {
            headers[k] = v;
          });
          calls.push({ idName: id.__idName, url: req.url, headers });
          return handler(req, id.__idName);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { ns, calls };
}

function makeEnv(opts: {
  mode?: 'legacy' | 'jwt';
  handler?: (req: Request, idName: string) => Response | Promise<Response>;
}) {
  const handler = opts.handler ?? (() => new Response('ok-from-do', { status: 200 }));
  const { ns, calls } = makeFakeNamespace(handler);
  const env = {
    TUNNEL: ns,
    USER_DO: undefined as unknown as DurableObjectNamespace,
    GITHUB_OAUTH_CLIENT_ID: 'iv1.test',
    GITHUB_OAUTH_CLIENT_SECRET: 'shh',
    JWT_SIGNING_KEY: KEY_WEB,
    JWT_REFRESH_SIGNING_KEY: KEY_TUNNEL,
    CCSM_AUTH_MODE: opts.mode === 'jwt' ? 'jwt' : 'legacy',
  };
  return { env, calls };
}

async function makeWebJwt(over: Partial<WebJwtClaims> = {}) {
  const claims: WebJwtClaims = {
    sub: '12345',
    login: 'octocat',
    iat: nowSec() - 1,
    exp: nowSec() + 60,
    kind: 'web',
    ...over,
  };
  return signJwt(claims, KEY_WEB);
}

async function makeTunnelJwt(over: Partial<TunnelJwtClaims> = {}) {
  const claims: TunnelJwtClaims = {
    sub: '12345',
    login: 'octocat',
    iat: nowSec() - 1,
    exp: nowSec() + 3600,
    kind: 'tunnel',
    jti: 't-abc',
    ...over,
  };
  return signJwt(claims, KEY_TUNNEL);
}

describe('cf-worker routing — legacy mode (default, regression guard)', () => {
  it('/ws/default upgrade → idFromName("default"), no JWT required', async () => {
    const { env, calls } = makeEnv({ mode: 'legacy' });
    const req = new Request('http://x/ws/default', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'ccsm.legacy-token' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.idName).toBe('default');
    // No identity headers injected in legacy mode.
    expect(calls[0]!.headers['x-ccsm-identity-login']).toBeUndefined();
  });

  it('/tunnel/default upgrade → idFromName("default"), no JWT required', async () => {
    const { env, calls } = makeEnv({ mode: 'legacy' });
    const req = new Request('http://x/tunnel/default', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'ccsm.daemon-tok' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(calls[0]!.idName).toBe('default');
  });

  it('/api/sessions → idFromName("default"), no JWT required', async () => {
    const { env, calls } = makeEnv({ mode: 'legacy' });
    const res = await worker.fetch(new Request('http://x/api/sessions'), env);
    expect(res.status).toBe(200);
    expect(calls[0]!.idName).toBe('default');
  });

  it('/token → idFromName("default"), no JWT required', async () => {
    const { env, calls } = makeEnv({ mode: 'legacy' });
    const res = await worker.fetch(new Request('http://x/token'), env);
    expect(res.status).toBe(200);
    expect(calls[0]!.idName).toBe('default');
  });

  it('default mode (CCSM_AUTH_MODE unset) behaves identically to legacy', async () => {
    const { ns, calls } = makeFakeNamespace(() => new Response('ok', { status: 200 }));
    const env = {
      TUNNEL: ns,
      USER_DO: undefined as unknown as DurableObjectNamespace,
      GITHUB_OAUTH_CLIENT_ID: 'iv1',
      GITHUB_OAUTH_CLIENT_SECRET: 'shh',
      JWT_SIGNING_KEY: KEY_WEB,
      JWT_REFRESH_SIGNING_KEY: KEY_TUNNEL,
      // CCSM_AUTH_MODE intentionally omitted.
    };
    const res = await worker.fetch(new Request('http://x/api/sessions'), env);
    expect(res.status).toBe(200);
    expect(calls[0]!.idName).toBe('default');
  });
});

describe('cf-worker routing — jwt mode rejects unauthenticated', () => {
  it('/ws/default upgrade without JWT → 401', async () => {
    const { env, calls } = makeEnv({ mode: 'jwt' });
    const req = new Request('http://x/ws/default', {
      headers: { Upgrade: 'websocket' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0); // never reached the DO
  });

  it('/tunnel/default upgrade without JWT → 401', async () => {
    const { env, calls } = makeEnv({ mode: 'jwt' });
    const req = new Request('http://x/tunnel/default', {
      headers: { Upgrade: 'websocket' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('/api/sessions without Authorization → 401', async () => {
    const { env, calls } = makeEnv({ mode: 'jwt' });
    const res = await worker.fetch(new Request('http://x/api/sessions'), env);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('/token without Authorization → 401', async () => {
    const { env, calls } = makeEnv({ mode: 'jwt' });
    const res = await worker.fetch(new Request('http://x/token'), env);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('/ws/default with expired JWT → 401', async () => {
    const tok = await makeWebJwt({ iat: nowSec() - 120, exp: nowSec() - 1 });
    const { env, calls } = makeEnv({ mode: 'jwt' });
    const req = new Request('http://x/ws/default', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('/ws/default with a tunnel-kind JWT → 401 (kind discriminator enforced)', async () => {
    // Token is signed with the right (web) key but carries kind='tunnel'.
    // This guards against accidentally treating the daemon credential as a
    // browser session. Use signJwt directly to avoid the kind-mismatch in
    // makeTunnelJwt's default key choice.
    const tok = await signJwt(
      {
        sub: '12345',
        login: 'octocat',
        iat: nowSec() - 1,
        exp: nowSec() + 60,
        kind: 'tunnel',
        jti: 'wrong',
      },
      KEY_WEB,
    );
    const { env } = makeEnv({ mode: 'jwt' });
    const req = new Request('http://x/ws/default', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });
});

describe('cf-worker routing — jwt mode per-user DO isolation', () => {
  it('alice and bob are routed into distinct TunnelDO instances', async () => {
    const { env, calls } = makeEnv({ mode: 'jwt' });
    const aliceTok = await makeWebJwt({ sub: 'gh-alice-1', login: 'alice' });
    const bobTok = await makeWebJwt({ sub: 'gh-bob-2', login: 'bob' });

    await worker.fetch(
      new Request('http://x/api/sessions', {
        headers: { Authorization: 'Bearer ' + aliceTok },
      }),
      env,
    );
    await worker.fetch(
      new Request('http://x/api/sessions', {
        headers: { Authorization: 'Bearer ' + bobTok },
      }),
      env,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.idName).toBe('user:gh-alice-1');
    expect(calls[1]!.idName).toBe('user:gh-bob-2');
    expect(calls[0]!.idName).not.toBe(calls[1]!.idName);
  });

  it('/ws/default with a valid web JWT routes into user:<sub> DO', async () => {
    const { env, calls } = makeEnv({ mode: 'jwt' });
    const tok = await makeWebJwt({ sub: '999', login: 'mona' });
    const res = await worker.fetch(
      new Request('http://x/ws/default?sid=s1', {
        headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.idName).toBe('user:999');
  });

  it('/ws/default jwt mode injects identity headers for daemon hello frame', async () => {
    const { env, calls } = makeEnv({ mode: 'jwt' });
    const tok = await makeWebJwt({ sub: '54321', login: 'hubot' });
    await worker.fetch(
      new Request('http://x/ws/default?sid=s1', {
        headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
      }),
      env,
    );
    expect(calls[0]!.headers['x-ccsm-identity-login']).toBe('hubot');
    expect(calls[0]!.headers['x-ccsm-identity-id']).toBe('54321');
    // The original ccsm.<jwt> subprotocol must still be present so the DO
    // can echo it on the 101 response (RFC 6455 §4.2.2 step 4).
    expect(calls[0]!.headers['sec-websocket-protocol']).toBe('ccsm.' + tok);
  });

  it('/tunnel/default with a valid tunnel JWT routes into user:<sub> DO (no identity header injected)', async () => {
    const { env, calls } = makeEnv({ mode: 'jwt' });
    const tok = await makeTunnelJwt({ sub: '777', login: 'daemon-user' });
    const res = await worker.fetch(
      new Request('http://x/tunnel/default', {
        headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.idName).toBe('user:777');
    // Daemon path: identity is carried by the tunnel JWT itself; we don't
    // inject identity headers on this branch (only browser-bound /ws/* does).
    expect(calls[0]!.headers['x-ccsm-identity-login']).toBeUndefined();
  });

  it('cross-user safety: alice JWT cannot land in bob DO even with a colliding sid', async () => {
    const { env, calls } = makeEnv({ mode: 'jwt' });
    const aliceTok = await makeWebJwt({ sub: 'gh-alice', login: 'alice' });
    const bobTok = await makeWebJwt({ sub: 'gh-bob', login: 'bob' });
    await worker.fetch(
      new Request('http://x/ws/default?sid=shared-sid', {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': 'ccsm.' + aliceTok,
        },
      }),
      env,
    );
    await worker.fetch(
      new Request('http://x/ws/default?sid=shared-sid', {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': 'ccsm.' + bobTok,
        },
      }),
      env,
    );
    expect(calls[0]!.idName).toBe('user:gh-alice');
    expect(calls[1]!.idName).toBe('user:gh-bob');
  });
});

describe('cf-worker routing — /health bypasses auth in both modes', () => {
  it('legacy', async () => {
    const { env } = makeEnv({ mode: 'legacy' });
    const res = await worker.fetch(new Request('http://x/health'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok\n');
  });
  it('jwt', async () => {
    const { env } = makeEnv({ mode: 'jwt' });
    const res = await worker.fetch(new Request('http://x/health'), env);
    expect(res.status).toBe(200);
  });
});
