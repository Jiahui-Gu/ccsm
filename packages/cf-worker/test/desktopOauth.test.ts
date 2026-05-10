/**
 * R-51b (Task #168) + R-53 (Task #175): cf-worker desktop OAuth (PKCE)
 * flow tests.
 *
 * R-53 split the legacy GET `/oauth/desktop/cb` (which the Worker rendered
 * as an HTML deep-link bounce page) into:
 *   - a static `frontend-web/public/oauth/desktop/cb/index.html` (NOT
 *     tested here — see frontend-web/test/oauth-callback-page.test.ts)
 *   - a JSON-returning POST `/api/auth/desktop/exchange` endpoint, tested
 *     below as `handleDesktopExchange`.
 *
 * Covers:
 *   - start: returns auth_url with required params + persists pkce-state row
 *     in UserDO under idFromName(`pkce:state:<state>`).
 *   - exchange (state unknown): 400 before any GitHub call.
 *   - exchange (state expired, >5min): 400 before GitHub.
 *   - exchange (PKCE verifier mismatch): GitHub 200 + error payload → 400.
 *   - exchange (missing code/state in body): 400.
 *   - exchange (malformed JSON body): 400.
 *   - exchange (GitHub /access_token 5xx): 502.
 *   - exchange (happy path) — runs decideAndLink branches:
 *       * create_no_email (private email)
 *       * login_existing (identity row already present)
 *       * link_to_existing seed (verified email pre-mapped, behaves as
 *         create_no_email under read:user scope — assertion locks that in)
 *   - exchange JSON shape: { tunnel_jwt, refresh_token } both strings.
 *   - dispatchDesktop: routing + null on legacy /oauth/desktop/cb path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchDesktop,
  handleDesktopStart,
  handleDesktopExchange,
} from '../src/auth/desktopOauth';
import type { AuthEnv } from '../src/auth/bindings';
import { verifyJwt, type TunnelJwtClaims } from '../src/auth/jwt';

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
          if (
            user_id === undefined ||
            primary_login === undefined ||
            created_at === undefined
          ) {
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

        // pkce-state role
        if (req.method === 'GET' && path === '/getPkceState') {
          const rec = get<unknown>('pkce_state_record');
          if (rec === undefined) return new Response('not found', { status: 404 });
          return Response.json(rec);
        }
        if (req.method === 'POST' && path === '/setPkceState') {
          put('pkce_state_record', await req.json());
          return new Response(null, { status: 204 });
        }
        if (req.method === 'POST' && path === '/clearPkceState') {
          del('pkce_state_record');
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

let realFetch: typeof fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

interface MockGhOpts {
  accessToken?: string;
  tokenError?: string;
  userId?: number;
  userLogin?: string;
  userEmail?: string | null;
  userStatus?: number;
  tokenStatus?: number;
  /** Capture the last token-exchange body (URLSearchParams form). */
  capture?: (body: URLSearchParams) => void;
}

function mockGithubFetch(opts: MockGhOpts): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      if (opts.capture) {
        const raw = (init?.body ?? '') as string;
        opts.capture(new URLSearchParams(raw));
      }
      if (opts.tokenStatus && opts.tokenStatus >= 400) {
        return new Response('bad', { status: opts.tokenStatus });
      }
      if (opts.tokenError) {
        return Response.json({ error: opts.tokenError });
      }
      return Response.json({
        access_token: opts.accessToken ?? 'gh-access-token',
      });
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

/** Drive desktop/start to populate a pkce:state row. Returns the issued
 *  state value parsed out of the auth_url. */
async function startAndExtractState(
  env: AuthEnv,
): Promise<{ state: string; auth_url: string }> {
  const res = await handleDesktopStart(
    new Request('https://example.com/api/auth/desktop/start', {
      method: 'POST',
    }),
    env,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { auth_url: string };
  const u = new URL(body.auth_url);
  const state = u.searchParams.get('state')!;
  return { state, auth_url: body.auth_url };
}

/** Build a POST /api/auth/desktop/exchange request with the given JSON body. */
function exchangeReq(body: unknown): Request {
  return new Request('https://example.com/api/auth/desktop/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('handleDesktopStart', () => {
  it('returns auth_url with client_id/state/scope/redirect_uri/code_challenge_method=S256 + persists pkce row', async () => {
    const { env, instances } = makeEnv();
    const res = await handleDesktopStart(
      new Request('https://example.com/api/auth/desktop/start', {
        method: 'POST',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth_url: string };
    expect(body.auth_url).toMatch(
      /^https:\/\/github\.com\/login\/oauth\/authorize\?/,
    );
    const u = new URL(body.auth_url);
    expect(u.searchParams.get('client_id')).toBe('test-client-id');
    const state = u.searchParams.get('state')!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('scope')).toBe('read:user');
    expect(u.searchParams.get('redirect_uri')).toBe(
      'https://example.com/oauth/desktop/cb',
    );
    const challenge = u.searchParams.get('code_challenge')!;
    // base64url, no padding, length 43 for SHA-256.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');

    // pkce-state row persisted under idFromName(`pkce:state:<state>`).
    const pkceInst = instances.get(`pkce:state:${state}`);
    expect(pkceInst).toBeDefined();
    const row = pkceInst!.data.get('pkce_state_record') as {
      code_verifier: string;
      created_at: number;
    };
    expect(row.code_verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof row.created_at).toBe('number');
  });
});

describe('handleDesktopExchange', () => {
  it('400s when state has no matching pkce row (mismatch / replay)', async () => {
    const { env } = makeEnv();
    const ghFetch = mockGithubFetch({});
    const res = await handleDesktopExchange(
      exchangeReq({ code: 'abc', state: 'a'.repeat(64) }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/unknown or used state/);
    expect(ghFetch).not.toHaveBeenCalled();
  });

  it('400s when pkce state is older than 5 minutes', async () => {
    const { env, instances } = makeEnv();
    const { state } = await startAndExtractState(env);
    // Backdate the row to 6 minutes ago.
    const inst = instances.get(`pkce:state:${state}`)!;
    const row = inst.data.get('pkce_state_record') as {
      code_verifier: string;
      created_at: number;
    };
    inst.data.set('pkce_state_record', {
      code_verifier: row.code_verifier,
      created_at: row.created_at - 6 * 60,
    });

    const ghFetch = mockGithubFetch({});
    const res = await handleDesktopExchange(
      exchangeReq({ code: 'abc', state }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired/);
    expect(ghFetch).not.toHaveBeenCalled();
  });

  it('400s when GitHub rejects the PKCE verifier (bad_verification_code)', async () => {
    const { env } = makeEnv();
    const { state } = await startAndExtractState(env);
    mockGithubFetch({ tokenError: 'bad_verification_code' });
    const res = await handleDesktopExchange(
      exchangeReq({ code: 'abc', state }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/bad_verification_code/);
  });

  it('400s when code or state body field is missing', async () => {
    const { env } = makeEnv();
    const r1 = await handleDesktopExchange(exchangeReq({ state: 'abc' }), env);
    expect(r1.status).toBe(400);
    const r2 = await handleDesktopExchange(exchangeReq({ code: 'abc' }), env);
    expect(r2.status).toBe(400);
  });

  it('400s when body is malformed JSON', async () => {
    const { env } = makeEnv();
    const res = await handleDesktopExchange(exchangeReq('not-json{'), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/malformed JSON/);
  });

  it('502s when GitHub /access_token is HTTP 5xx', async () => {
    const { env } = makeEnv();
    const { state } = await startAndExtractState(env);
    mockGithubFetch({ tokenStatus: 503 });
    const res = await handleDesktopExchange(
      exchangeReq({ code: 'abc', state }),
      env,
    );
    expect(res.status).toBe(502);
  });

  it('happy path (create_no_email): forwards verifier to GitHub, mints tunnel JWT, returns JSON tokens', async () => {
    const { env, instances } = makeEnv();
    const { state } = await startAndExtractState(env);
    const pkceInst = instances.get(`pkce:state:${state}`)!;
    const expectedVerifier = (
      pkceInst.data.get('pkce_state_record') as { code_verifier: string }
    ).code_verifier;

    let capturedVerifier: string | undefined;
    let capturedRedirect: string | undefined;
    let capturedClientSecret: string | undefined;
    mockGithubFetch({
      userId: 42,
      userLogin: 'alice',
      userEmail: null,
      capture: (body) => {
        capturedVerifier = body.get('code_verifier') ?? undefined;
        capturedRedirect = body.get('redirect_uri') ?? undefined;
        capturedClientSecret = body.get('client_secret') ?? undefined;
      },
    });

    const res = await handleDesktopExchange(
      exchangeReq({ code: 'abc', state }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as {
      tunnel_jwt: string;
      refresh_token: string;
    };

    // PKCE verifier was forwarded; redirect_uri matched start; client_secret
    // present (GitHub OAuth Apps require it even with PKCE).
    expect(capturedVerifier).toBe(expectedVerifier);
    expect(capturedRedirect).toBe('https://example.com/oauth/desktop/cb');
    expect(capturedClientSecret).toBe('test-client-secret');

    // pkce row consumed (one-shot use).
    expect(pkceInst.data.has('pkce_state_record')).toBe(false);

    // JSON shape.
    expect(typeof body.tunnel_jwt).toBe('string');
    expect(body.refresh_token).toMatch(/^[0-9a-f]{64}$/);

    const claims = await verifyJwt<TunnelJwtClaims>(body.tunnel_jwt, KEY_HEX);
    expect(claims).not.toBeNull();
    expect(claims!.kind).toBe('tunnel');
    expect(claims!.login).toBe('alice');
    // sub is uuid (R-51a) — not the github_id 42.
    expect(claims!.sub).not.toBe('42');
    expect(claims!.sub).toMatch(/^[0-9a-f-]{36}$/i);

    // user blob keyed by user:<uuid> + tunnel refresh hash persisted.
    const userInst = instances.get(`user:${claims!.sub}`);
    expect(userInst).toBeDefined();
    expect(typeof userInst!.data.get('tunnel_refresh_hash')).toBe('string');

    // identity row keyed by identity:github:42.
    const identityInst = instances.get('identity:github:42');
    expect(identityInst).toBeDefined();
    const identityRec = identityInst!.data.get('identity_record') as {
      user_id: string;
      email_verified: boolean;
    };
    expect(identityRec.user_id).toBe(claims!.sub);
    // read:user scope → email_verified=false (create_no_email branch).
    expect(identityRec.email_verified).toBe(false);
  });

  it('happy path (login_existing): a second sign-in with the same github sub reuses the same uuid', async () => {
    const { env, instances } = makeEnv();

    // First round.
    const first = await startAndExtractState(env);
    mockGithubFetch({ userId: 42, userLogin: 'alice', userEmail: null });
    const r1 = await handleDesktopExchange(
      exchangeReq({ code: 'c', state: first.state }),
      env,
    );
    expect(r1.status).toBe(200);
    const body1 = (await r1.json()) as { tunnel_jwt: string };
    const claims1 = await verifyJwt<TunnelJwtClaims>(body1.tunnel_jwt, KEY_HEX);

    // Second round, same github sub — should hit Branch 1 (login_existing).
    const second = await startAndExtractState(env);
    mockGithubFetch({ userId: 42, userLogin: 'alice', userEmail: null });
    const r2 = await handleDesktopExchange(
      exchangeReq({ code: 'c2', state: second.state }),
      env,
    );
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as { tunnel_jwt: string };
    const claims2 = await verifyJwt<TunnelJwtClaims>(body2.tunnel_jwt, KEY_HEX);

    expect(claims2!.sub).toBe(claims1!.sub);
    // Only one user blob instance — same uuid both rounds.
    const userInstances = [...instances.keys()].filter((k) => k.startsWith('user:'));
    expect(userInstances).toHaveLength(1);
  });

  it('happy path (link_to_existing seed under read:user): pre-existing email index does not link because email_verified=false', async () => {
    // Seed: an existing user A keyed by uuid 'uuid-A' has a verified email
    // index. A fresh GitHub identity (different sub) signs in with that
    // same email, but the desktop handler hard-codes email_verified=false
    // for read:user scope — so this case actually behaves as
    // create_no_email. We assert that explicitly (no link to A) so any
    // future scope upgrade that flips email_verified will trip the test.
    const { env, instances } = makeEnv();
    // Pre-seed the email index + user blob + identity for user A.
    const userA = '11111111-1111-1111-1111-111111111111';
    instances.set(`user:${userA}`, {
      data: new Map<string, unknown>([
        ['user_id', userA],
        ['primary_login', 'a-user'],
        ['created_at', 1700000000],
      ]),
    });
    instances.set('email:b@example.com', {
      data: new Map<string, unknown>([
        ['email_index_record', { user_id: userA, created_at: 1700000000 }],
      ]),
    });

    const { state } = await startAndExtractState(env);
    mockGithubFetch({
      userId: 200,
      userLogin: 'b-user',
      userEmail: 'b@example.com',
    });
    const res = await handleDesktopExchange(
      exchangeReq({ code: 'c', state }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tunnel_jwt: string };
    const claims = await verifyJwt<TunnelJwtClaims>(body.tunnel_jwt, KEY_HEX);
    // email_verified=false in the linker call → Branch 2 (create_no_email),
    // a fresh uuid is minted, NOT linked to user A.
    expect(claims!.sub).not.toBe(userA);
    expect(claims!.sub).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('dispatchDesktop', () => {
  it('routes POST /api/auth/desktop/start', async () => {
    const { env } = makeEnv();
    const res = await dispatchDesktop(
      new Request('https://example.com/api/auth/desktop/start', {
        method: 'POST',
      }),
      env,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  it('routes POST /api/auth/desktop/exchange', async () => {
    const { env } = makeEnv();
    const res = await dispatchDesktop(
      new Request('https://example.com/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'c', state: 'unknown-state' }),
      }),
      env,
    );
    expect(res).not.toBeNull();
    // Unknown state → 400.
    expect(res!.status).toBe(400);
  });

  it('returns null for the legacy GET /oauth/desktop/cb path (now a static page)', async () => {
    // R-53 (Task #175): the Worker no longer handles GET /oauth/desktop/cb;
    // it is served as a static asset. dispatchDesktop must return null so
    // index.ts falls through to the ASSETS binding catch-all.
    const { env } = makeEnv();
    const res = await dispatchDesktop(
      new Request('https://example.com/oauth/desktop/cb?code=c&state=s'),
      env,
    );
    expect(res).toBeNull();
  });

  it('returns null for unrelated paths', async () => {
    const { env } = makeEnv();
    const res = await dispatchDesktop(
      new Request('https://example.com/api/auth/github/login'),
      env,
    );
    expect(res).toBeNull();
  });

  it('returns null for wrong method on desktop/start', async () => {
    const { env } = makeEnv();
    const res = await dispatchDesktop(
      new Request('https://example.com/api/auth/desktop/start', {
        method: 'GET',
      }),
      env,
    );
    expect(res).toBeNull();
  });

  it('returns null for wrong method on desktop/exchange', async () => {
    const { env } = makeEnv();
    const res = await dispatchDesktop(
      new Request('https://example.com/api/auth/desktop/exchange', {
        method: 'GET',
      }),
      env,
    );
    expect(res).toBeNull();
  });
});
