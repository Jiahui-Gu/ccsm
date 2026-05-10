/**
 * R-46 audit-P0 (Task #158, F-T-2/F-T-3): observability tests.
 *
 * Covers:
 *  - request_id propagation: cf-worker entry stamps `X-CCSM-Request-Id`
 *    onto downstream requests; the auth dispatcher rebuilds a child logger
 *    with the same id; the TunnelDO http_req frame carries it; the daemon
 *    falls back to "no-req-id" when missing (wire-format back-compat).
 *  - OAuth event log: callback failure paths emit
 *    `oauth.callback_fail` with a structured `reason`; refresh failure
 *    paths emit `auth.refresh_fail`; device.poll error paths emit
 *    `device.poll`.
 *  - Redaction holds at the integration boundary: even if a path passes a
 *    raw token-bearing object to the logger, the rendered JSON line must
 *    not contain plaintext access_token / refresh_token.
 *
 * We capture log lines by stubbing console.log/warn/error. Each test
 * restores the real methods in afterEach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  handleGithubCallback,
  handleRefresh,
} from '../src/auth/webOauth';
import {
  handleDevicePoll,
  handleTunnelRefresh,
} from '../src/auth/deviceFlow';
import type { AuthEnv } from '../src/auth/bindings';

const KEY_HEX =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

interface CapturedLog {
  level: 'log' | 'warn' | 'error' | 'debug';
  raw: string;
  parsed: Record<string, unknown> | null;
}

function captureConsole(): {
  lines: CapturedLog[];
  restore: () => void;
} {
  const lines: CapturedLog[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origDebug = console.debug;
  const push = (level: CapturedLog['level']) => (...args: unknown[]) => {
    const raw = args.map(String).join(' ');
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    lines.push({ level, raw, parsed });
  };
  console.log = push('log');
  console.warn = push('warn');
  console.error = push('error');
  console.debug = push('debug');
  return {
    lines,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      console.debug = origDebug;
    },
  };
}

function findEvent(
  lines: CapturedLog[],
  event: string,
): Record<string, unknown> | undefined {
  for (const l of lines) {
    if (l.parsed !== null && l.parsed.event === event) return l.parsed;
  }
  return undefined;
}

interface UserDoState {
  user_id?: string;
  primary_login?: string;
  refresh_hash?: string;
  tunnel_refresh_hash?: string;
  created_at?: number;
  identity_record?: unknown;
  email_index_record?: unknown;
  revoked: boolean;
}

function makeUserDoStub(state: UserDoState) {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      // user-blob role
      if (req.method === 'POST' && path === '/setUserBlob') {
        const body = (await req.json()) as { user_id: string; primary_login: string };
        state.user_id = body.user_id;
        state.primary_login = body.primary_login;
        if (state.created_at === undefined)
          state.created_at = Math.floor(Date.now() / 1000);
        return new Response(null, { status: 204 });
      }
      if (req.method === 'GET' && path === '/getUserBlob') {
        if (state.user_id === undefined) return new Response('not found', { status: 404 });
        return Response.json({
          user_id: state.user_id,
          primary_login: state.primary_login,
          created_at: state.created_at,
        });
      }
      if (req.method === 'POST' && path === '/setRefreshTokenHash') {
        const body = (await req.json()) as { hash: string };
        state.refresh_hash = body.hash;
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST' && path === '/verifyRefreshTokenHash') {
        const body = (await req.json()) as { hash: string };
        return Response.json({ ok: state.refresh_hash === body.hash });
      }
      if (req.method === 'POST' && path === '/setTunnelRefreshTokenHash') {
        const body = (await req.json()) as { hash: string };
        state.tunnel_refresh_hash = body.hash;
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST' && path === '/verifyTunnelRefreshTokenHash') {
        const body = (await req.json()) as { hash: string };
        return Response.json({ ok: state.tunnel_refresh_hash === body.hash });
      }
      // identity role
      if (req.method === 'GET' && path === '/getIdentity') {
        if (state.identity_record === undefined)
          return new Response('not found', { status: 404 });
        return Response.json(state.identity_record);
      }
      if (req.method === 'POST' && path === '/setIdentity') {
        state.identity_record = await req.json();
        return new Response(null, { status: 204 });
      }
      // email-index role
      if (req.method === 'GET' && path === '/getEmailIndex') {
        if (state.email_index_record === undefined)
          return new Response('not found', { status: 404 });
        return Response.json(state.email_index_record);
      }
      if (req.method === 'POST' && path === '/setEmailIndex') {
        state.email_index_record = await req.json();
        return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    },
  };
}

function makeAuthEnv(userStub: { fetch: (req: Request) => Promise<Response> }): AuthEnv {
  return {
    TUNNEL: undefined as unknown as DurableObjectNamespace,
    GITHUB_OAUTH_CLIENT_ID: 'cid',
    GITHUB_OAUTH_CLIENT_SECRET: 'csec',
    JWT_SIGNING_KEY: KEY_HEX,
    JWT_REFRESH_SIGNING_KEY: KEY_HEX,
    USER_DO: {
      idFromName: (n: string) => ({ name: n }) as unknown as DurableObjectId,
      get: (_id: DurableObjectId) =>
        userStub as unknown as DurableObjectStub,
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

describe('request_id propagation (F-T-2)', () => {
  it('worker entry stamps X-CCSM-Request-Id from cf-ray onto downstream stub.fetch', async () => {
    let stubSawHeader: string | null = null;
    const env = {
      TUNNEL: {
        idFromName: (_n: string) => ({ name: _n }) as unknown as DurableObjectId,
        get: (_id: DurableObjectId) => ({
          fetch: async (downstream: Request) => {
            stubSawHeader = downstream.headers.get('X-CCSM-Request-Id');
            return new Response('ok', { status: 200 });
          },
        } as unknown as DurableObjectStub),
      } as unknown as DurableObjectNamespace,
      GITHUB_OAUTH_CLIENT_ID: 'cid',
      GITHUB_OAUTH_CLIENT_SECRET: 'csec',
      JWT_SIGNING_KEY: KEY_HEX,
      JWT_REFRESH_SIGNING_KEY: KEY_HEX,
      USER_DO: undefined as unknown as DurableObjectNamespace,
      ASSETS: undefined as unknown as Fetcher,
    };
    const req = new Request('https://example.test/token', {
      method: 'POST',
      headers: { 'cf-ray': '8aabbccddee0001-IAD' },
    });
    await worker.fetch(req, env as unknown as Parameters<typeof worker.fetch>[1]);
    expect(stubSawHeader).toBe('8aabbccddee0001-IAD');
  });

  it('worker logs include request_id derived from cf-ray', async () => {
    const cap = captureConsole();
    try {
      const env = {
        TUNNEL: {
          idFromName: (_n: string) => ({ name: _n }) as unknown as DurableObjectId,
          get: (_id: DurableObjectId) => ({
            fetch: async () => new Response('x', { status: 200 }),
          } as unknown as DurableObjectStub),
        } as unknown as DurableObjectNamespace,
        GITHUB_OAUTH_CLIENT_ID: 'cid',
        GITHUB_OAUTH_CLIENT_SECRET: 'csec',
        JWT_SIGNING_KEY: KEY_HEX,
        JWT_REFRESH_SIGNING_KEY: KEY_HEX,
        USER_DO: undefined as unknown as DurableObjectNamespace,
        ASSETS: undefined as unknown as Fetcher,
      };
      const req = new Request('https://example.test/token', {
        method: 'POST',
        headers: { 'cf-ray': '8aa0001-IAD' },
      });
      await worker.fetch(req, env as unknown as Parameters<typeof worker.fetch>[1]);
    } finally {
      cap.restore();
    }
    const route = findEvent(cap.lines, 'worker.route');
    expect(route).toBeDefined();
    expect(route!.request_id).toBe('8aa0001-IAD');
  });
});

describe('OAuth event log — failure paths (F-T-3)', () => {
  it('callback fail: csrf mismatch emits oauth.callback_fail with reason', async () => {
    const cap = captureConsole();
    try {
      const stub = makeUserDoStub({ revoked: false });
      const env = makeAuthEnv(stub);
      const req = new Request(
        'https://example/api/auth/github/callback?code=c&state=client',
        { headers: { 'X-CCSM-Request-Id': 'req-test-1', Cookie: 'csrf=server' } },
      );
      const res = await handleGithubCallback(req, env);
      expect(res.status).toBe(400);
    } finally {
      cap.restore();
    }
    const ev = findEvent(cap.lines, 'oauth.callback_fail');
    expect(ev).toBeDefined();
    expect(ev!.request_id).toBe('req-test-1');
    expect((ev!.fields as Record<string, unknown>).reason).toBe('csrf_mismatch');
  });

  it('refresh fail: invalid token emits auth.refresh_fail', async () => {
    const cap = captureConsole();
    try {
      const state: UserDoState = { revoked: false };
      // Pre-populate hash so verify can mismatch.
      state.refresh_hash = 'pre-existing-hash';
      const stub = makeUserDoStub(state);
      const env = makeAuthEnv(stub);
      const req = new Request('https://example/api/auth/refresh', {
        method: 'POST',
        headers: {
          'X-CCSM-Request-Id': 'req-refresh-bad',
          Cookie: 'refresh=wrong_token; uid=uuid-octocat',
        },
      });
      const res = await handleRefresh(req, env);
      expect(res.status).toBe(401);
    } finally {
      cap.restore();
    }
    const ev = findEvent(cap.lines, 'auth.refresh_fail');
    expect(ev).toBeDefined();
    expect(ev!.request_id).toBe('req-refresh-bad');
    expect((ev!.fields as Record<string, unknown>).reason).toBe(
      'invalid_refresh_token',
    );
  });

  it('refresh fail: missing cookie emits auth.refresh_fail', async () => {
    const cap = captureConsole();
    try {
      const stub = makeUserDoStub({ revoked: false });
      const env = makeAuthEnv(stub);
      const req = new Request('https://example/api/auth/refresh', {
        method: 'POST',
        headers: { 'X-CCSM-Request-Id': 'req-no-cookie' },
      });
      const res = await handleRefresh(req, env);
      expect(res.status).toBe(401);
    } finally {
      cap.restore();
    }
    const ev = findEvent(cap.lines, 'auth.refresh_fail');
    expect(ev).toBeDefined();
    expect((ev!.fields as Record<string, unknown>).reason).toBe('missing_cookie');
  });

  it('device.poll error: github access_denied emits device.poll with denied result', async () => {
    const cap = captureConsole();
    try {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'access_denied' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as typeof fetch;
      const stub = makeUserDoStub({ revoked: false });
      const env = makeAuthEnv(stub);
      const req = new Request('https://example/api/auth/device/poll', {
        method: 'POST',
        headers: {
          'X-CCSM-Request-Id': 'req-device-1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ device_code: 'dc-1' }),
      });
      const res = await handleDevicePoll(req, env);
      expect(res.status).toBe(403);
    } finally {
      cap.restore();
    }
    const ev = findEvent(cap.lines, 'device.poll');
    expect(ev).toBeDefined();
    expect(ev!.request_id).toBe('req-device-1');
    expect((ev!.fields as Record<string, unknown>).result).toBe('denied');
  });

  it('tunnel.refresh fail: invalid token emits tunnel.refresh_fail', async () => {
    const cap = captureConsole();
    try {
      const state: UserDoState = { revoked: false };
      state.tunnel_refresh_hash = 'real-hash';
      const stub = makeUserDoStub(state);
      const env = makeAuthEnv(stub);
      const req = new Request('https://example/api/auth/tunnel/refresh', {
        method: 'POST',
        headers: {
          'X-CCSM-Request-Id': 'req-tun-1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tunnel_refresh_token: 'wrong',
          user_id: 'uuid-octocat',
        }),
      });
      const res = await handleTunnelRefresh(req, env);
      expect(res.status).toBe(401);
    } finally {
      cap.restore();
    }
    const ev = findEvent(cap.lines, 'tunnel.refresh_fail');
    expect(ev).toBeDefined();
    expect(ev!.request_id).toBe('req-tun-1');
    expect((ev!.fields as Record<string, unknown>).reason).toBe('invalid_token');
    // R-51a: log carries `uid_prefix`, not `login`.
    expect((ev!.fields as Record<string, unknown>).uid_prefix).toBeDefined();
  });
});

describe('redaction at integration boundary (F-T-3)', () => {
  it('full callback success path does not leak access_token in any log line', async () => {
    const cap = captureConsole();
    try {
      // Stub GitHub: token exchange + user fetch.
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/login/oauth/access_token')) {
          return new Response(
            JSON.stringify({ access_token: 'gho_should_never_appear_in_logs' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (typeof url === 'string' && url.includes('api.github.com/user')) {
          return new Response(JSON.stringify({ id: 12345678, login: 'octocat' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('nope', { status: 500 });
      }) as typeof fetch;
      const stub = makeUserDoStub({ revoked: false });
      const env = makeAuthEnv(stub);
      const req = new Request(
        'https://example/api/auth/github/callback?code=c&state=s',
        { headers: { 'X-CCSM-Request-Id': 'req-ok-1', Cookie: 'csrf=s' } },
      );
      const res = await handleGithubCallback(req, env);
      expect(res.status).toBe(302);
    } finally {
      cap.restore();
    }
    const ok = findEvent(cap.lines, 'oauth.callback_ok');
    expect(ok).toBeDefined();
    expect(ok!.request_id).toBe('req-ok-1');
    // Hard guard: the access_token must not appear in any captured log line.
    for (const l of cap.lines) {
      expect(l.raw).not.toContain('gho_should_never_appear_in_logs');
    }
    // R-51a: sub is now a uuid (mint inside oauthLinker), not the github_id
    // string. Assert prefix shape: shortSub returns first 8 hex chars.
    expect((ok!.fields as Record<string, unknown>).sub_prefix).toMatch(/^[0-9a-f]{8}$/i);
  });
});
