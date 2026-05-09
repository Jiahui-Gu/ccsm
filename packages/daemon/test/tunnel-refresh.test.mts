// Unit tests for daemon tunnel-refresh client (Task #153, R-45 audit-P0 F-T-13).
//
// Pure unit tests via DI seams: no real fetch, no real timers, no real fs.
// Covers:
//   - parseJwtExpUnverified (happy path + structural failure modes)
//   - timer schedules (exp-1h, immediate when exp <= now+1h, retry backoff)
//   - successful refresh: rewrites file, swaps in-memory JWT, fires
//     onRefreshed, reschedules from new exp
//   - 401 / 404 → permanent park (no retry, no onRefreshed)
//   - network throw / 5xx → retry on RETRY_BACKOFF_MS, no onRefreshed
//   - bad JSON / missing fields → retry, no onRefreshed
//   - persist failure → retry, in-memory creds unchanged

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import {
  TunnelRefreshClient,
  parseJwtExpUnverified,
  type PersistedTunnelCreds,
} from '../src/tunnel-refresh.mjs';

// ---- helpers ------------------------------------------------------------

function base64url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Build a fake JWT with the given payload (header / sig are constants). */
function fakeJwt(payload: Record<string, unknown>): string {
  const hdr = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = base64url('not-a-real-sig');
  return `${hdr}.${body}.${sig}`;
}

interface MockResponseInit {
  status?: number;
  json?: unknown;
  jsonThrows?: boolean;
}

function mockResponse(init: MockResponseInit): Response {
  const status = init.status ?? 200;
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: async (): Promise<unknown> => {
      if (init.jsonThrows === true) throw new Error('bad json');
      return init.json ?? {};
    },
  } as unknown as Response;
}

// ---- parseJwtExpUnverified ---------------------------------------------

describe('parseJwtExpUnverified', () => {
  it('extracts exp from a valid JWT payload', () => {
    const exp = 1_700_000_000;
    const jwt = fakeJwt({ sub: '42', exp });
    expect(parseJwtExpUnverified(jwt)).toBe(exp);
  });

  it('returns null when JWT is not 3 dot-separated parts', () => {
    expect(parseJwtExpUnverified('foo.bar')).toBeNull();
    expect(parseJwtExpUnverified('a.b.c.d')).toBeNull();
    expect(parseJwtExpUnverified('not-a-jwt')).toBeNull();
  });

  it('returns null when payload is not valid base64url JSON', () => {
    expect(parseJwtExpUnverified('a.!!!.c')).toBeNull();
    expect(parseJwtExpUnverified(`a.${base64url('not-json')}.c`)).toBeNull();
  });

  it('returns null when exp is missing or not a positive number', () => {
    expect(parseJwtExpUnverified(fakeJwt({ sub: '42' }))).toBeNull();
    expect(parseJwtExpUnverified(fakeJwt({ exp: 'soon' }))).toBeNull();
    expect(parseJwtExpUnverified(fakeJwt({ exp: 0 }))).toBeNull();
    expect(parseJwtExpUnverified(fakeJwt({ exp: -1 }))).toBeNull();
  });
});

// ---- TunnelRefreshClient -----------------------------------------------

describe('TunnelRefreshClient', () => {
  let nowMs: number;
  let timers: Array<{ id: number; cb: () => void; ms: number; active: boolean }>;
  let nextTimerId: number;
  let setTimeoutImpl: Mock;
  let clearTimeoutImpl: Mock;
  let writeCredsFile: Mock;
  let onRefreshed: Mock;
  let fetchImpl: Mock;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nowMs = 1_000_000_000_000; // arbitrary epoch ms
    timers = [];
    nextTimerId = 1;
    setTimeoutImpl = vi.fn((cb: () => void, ms: number) => {
      const id = nextTimerId++;
      const rec = { id, cb, ms, active: true };
      timers.push(rec);
      return rec as unknown as ReturnType<typeof setTimeout>;
    });
    clearTimeoutImpl = vi.fn((id: { id: number; active: boolean }) => {
      id.active = false;
    });
    writeCredsFile = vi.fn(async () => {});
    onRefreshed = vi.fn();
    fetchImpl = vi.fn();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function fireActiveTimers(): void {
    // Fire all currently-active timers in insertion order; they may schedule
    // more (which we leave for the next call).
    const snapshot = timers.filter((t) => t.active);
    for (const t of snapshot) {
      t.active = false;
      t.cb();
    }
  }

  function makeClient(creds: PersistedTunnelCreds): TunnelRefreshClient {
    return new TunnelRefreshClient({
      authBase: 'https://cc-sm.test',
      creds,
      onRefreshed,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setTimeoutImpl: setTimeoutImpl as unknown as (cb: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearTimeoutImpl: clearTimeoutImpl as unknown as (id: ReturnType<typeof setTimeout>) => void,
      nowMs: () => nowMs,
      writeCredsFile,
    });
  }

  it('schedules first refresh at exp - 1h', () => {
    const exp = Math.floor(nowMs / 1000) + 24 * 3600; // 24h from now
    const client = makeClient({
      tunnel_jwt: fakeJwt({ exp }),
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
    const delay = setTimeoutImpl.mock.calls[0]![1] as number;
    // Expect ~23h ± 1ms tolerance.
    expect(delay).toBe(23 * 3600 * 1000);
    expect(client.getState()).toBe('scheduled');
  });

  it('fires immediately when exp is already within the lead window', () => {
    const exp = Math.floor(nowMs / 1000) + 30 * 60; // 30 min — inside 1h lead
    const client = makeClient({
      tunnel_jwt: fakeJwt({ exp }),
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    expect(setTimeoutImpl.mock.calls[0]![1]).toBe(0);
  });

  it('successful refresh: writes file, swaps JWT, fires onRefreshed, reschedules', async () => {
    const exp1 = Math.floor(nowMs / 1000) + 24 * 3600;
    const exp2 = Math.floor(nowMs / 1000) + 48 * 3600; // new JWT, +24h
    const newJwt = fakeJwt({ exp: exp2, sub: '42' });
    fetchImpl.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        json: { tunnel_jwt: newJwt, tunnel_refresh_token: 'r1' },
      }),
    );

    const client = makeClient({
      tunnel_jwt: fakeJwt({ exp: exp1 }),
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    // Advance "time" past exp - 1h.
    nowMs += 23 * 3600 * 1000 + 1;
    fireActiveTimers();
    // Drain the microtask queue so the async fireRefresh resolves.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://cc-sm.test/api/auth/tunnel/refresh');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({ tunnel_refresh_token: 'r0', login: 'octocat' });

    expect(writeCredsFile).toHaveBeenCalledTimes(1);
    expect(writeCredsFile.mock.calls[0]![0]).toEqual({
      tunnel_jwt: newJwt,
      tunnel_refresh_token: 'r1',
      login: 'octocat',
    });

    expect(onRefreshed).toHaveBeenCalledTimes(1);
    expect(onRefreshed.mock.calls[0]![0]).toBe(newJwt);

    expect(client.getCurrentJwt()).toBe(newJwt);
    expect(client.getState()).toBe('scheduled');
    // After scheduleNext using new exp, a new timer should exist.
    expect(setTimeoutImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('401 from cloud → permanent park, no retry, no onRefreshed', async () => {
    const exp = Math.floor(nowMs / 1000) + 30 * 60;
    fetchImpl.mockResolvedValueOnce(mockResponse({ status: 401 }));

    const client = makeClient({
      tunnel_jwt: fakeJwt({ exp }),
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    fireActiveTimers();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(writeCredsFile).not.toHaveBeenCalled();
    expect(onRefreshed).not.toHaveBeenCalled();
    expect(client.getState()).toBe('idle');
    // No new timer after the initial one.
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
  });

  it('404 from cloud → permanent park (user unknown)', async () => {
    const exp = Math.floor(nowMs / 1000) + 30 * 60;
    fetchImpl.mockResolvedValueOnce(mockResponse({ status: 404 }));

    const client = makeClient({
      tunnel_jwt: fakeJwt({ exp }),
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    fireActiveTimers();
    await new Promise((r) => setImmediate(r));

    expect(onRefreshed).not.toHaveBeenCalled();
    expect(client.getState()).toBe('idle');
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
  });

  it('network throw → schedules retry, does not fire onRefreshed', async () => {
    const exp = Math.floor(nowMs / 1000) + 30 * 60;
    fetchImpl.mockRejectedValueOnce(new Error('ECONNRESET'));

    const client = makeClient({
      tunnel_jwt: fakeJwt({ exp }),
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    fireActiveTimers();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onRefreshed).not.toHaveBeenCalled();
    // Initial + retry timer.
    expect(setTimeoutImpl).toHaveBeenCalledTimes(2);
    const retryDelay = setTimeoutImpl.mock.calls[1]![1] as number;
    expect(retryDelay).toBe(60 * 1000);
    expect(client.getState()).toBe('scheduled');
    // In-memory JWT unchanged.
    const initialJwt = fakeJwt({ exp });
    expect(client.getCurrentJwt()).toBe(initialJwt);
  });

  it('5xx → retry, no onRefreshed', async () => {
    const exp = Math.floor(nowMs / 1000) + 30 * 60;
    fetchImpl.mockResolvedValueOnce(mockResponse({ status: 503 }));

    const client = makeClient({
      tunnel_jwt: fakeJwt({ exp }),
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    fireActiveTimers();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onRefreshed).not.toHaveBeenCalled();
    expect(setTimeoutImpl).toHaveBeenCalledTimes(2);
    expect((setTimeoutImpl.mock.calls[1]![1] as number)).toBe(60 * 1000);
  });

  it('malformed JSON response → retry, no onRefreshed', async () => {
    const exp = Math.floor(nowMs / 1000) + 30 * 60;
    fetchImpl.mockResolvedValueOnce(mockResponse({ status: 200, jsonThrows: true }));

    const client = makeClient({
      tunnel_jwt: fakeJwt({ exp }),
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    fireActiveTimers();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onRefreshed).not.toHaveBeenCalled();
    expect(setTimeoutImpl).toHaveBeenCalledTimes(2);
  });

  it('response missing fields → retry, no onRefreshed', async () => {
    const exp = Math.floor(nowMs / 1000) + 30 * 60;
    fetchImpl.mockResolvedValueOnce(
      mockResponse({ status: 200, json: { tunnel_jwt: 'foo' } }),
    );

    const client = makeClient({
      tunnel_jwt: fakeJwt({ exp }),
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    fireActiveTimers();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onRefreshed).not.toHaveBeenCalled();
    expect(setTimeoutImpl).toHaveBeenCalledTimes(2);
  });

  it('persist failure → retry, in-memory creds unchanged', async () => {
    const exp1 = Math.floor(nowMs / 1000) + 30 * 60;
    const exp2 = exp1 + 24 * 3600;
    const newJwt = fakeJwt({ exp: exp2 });
    fetchImpl.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        json: { tunnel_jwt: newJwt, tunnel_refresh_token: 'r1' },
      }),
    );
    writeCredsFile.mockRejectedValueOnce(new Error('disk full'));

    const initialJwt = fakeJwt({ exp: exp1 });
    const client = makeClient({
      tunnel_jwt: initialJwt,
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    fireActiveTimers();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onRefreshed).not.toHaveBeenCalled();
    expect(client.getCurrentJwt()).toBe(initialJwt);
    expect(setTimeoutImpl).toHaveBeenCalledTimes(2);
  });

  it('stop() cancels pending timer and ignores subsequent state changes', () => {
    const exp = Math.floor(nowMs / 1000) + 24 * 3600;
    const client = makeClient({
      tunnel_jwt: fakeJwt({ exp }),
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
    client.stop();
    expect(clearTimeoutImpl).toHaveBeenCalledTimes(1);
    expect(client.getState()).toBe('stopped');
    // start() after stop is a no-op.
    client.start();
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
  });

  it('JWT without parseable exp disables refresh (no timer scheduled)', () => {
    const client = makeClient({
      tunnel_jwt: 'not-a-valid-jwt',
      tunnel_refresh_token: 'r0',
      login: 'octocat',
    });
    client.start();
    expect(setTimeoutImpl).not.toHaveBeenCalled();
    expect(client.getState()).toBe('idle');
  });
});
