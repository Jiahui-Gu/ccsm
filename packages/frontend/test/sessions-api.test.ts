import { describe, it, expect, vi } from 'vitest';
import { createSession, deleteSession, listSessions, HttpError } from '../src/api/sessions';

describe('api/sessions.createSession', () => {
  it('POSTs to /api/sessions with Bearer token and returns the parsed sid', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/sessions');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer secret-token');
      expect(headers['content-type']).toBe('application/json');
      expect(JSON.parse(init.body as string)).toEqual({ cwd: '/tmp/work' });
      return new Response(
        JSON.stringify({ sid: 'sid-abc', createdAt: 1234 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const got = await createSession(
      'secret-token',
      { cwd: '/tmp/work' },
      fetchMock as unknown as typeof fetch,
    );
    expect(got).toEqual({ sid: 'sid-abc', createdAt: 1234 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('omits cwd when not provided (sends empty body object)', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({});
      return new Response(
        JSON.stringify({ sid: 's2', createdAt: 0 }),
        { status: 200 },
      );
    });
    const got = await createSession(
      't',
      undefined,
      fetchMock as unknown as typeof fetch,
    );
    expect(got.sid).toBe('s2');
  });

  it('throws HttpError carrying status when daemon rejects', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('unauthorized', { status: 401 }),
    );
    await expect(
      createSession('bad', {}, fetchMock as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      createSession('bad', {}, fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('api/sessions.deleteSession (T9 / #656)', () => {
  it('issues DELETE with Bearer token to the per-sid path', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/sessions/sid-abc');
      expect(init.method).toBe('DELETE');
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer t');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const got = await deleteSession(
      't',
      'sid-abc',
      fetchMock as unknown as typeof fetch,
    );
    expect(got).toEqual({ ok: true });
  });

  it('treats 404 as success (session already gone on the daemon side)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"error":"not_found"}', { status: 404 }),
    );
    const got = await deleteSession(
      't',
      'ghost',
      fetchMock as unknown as typeof fetch,
    );
    expect(got).toEqual({ ok: true });
  });

  it('throws HttpError on 5xx', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('boom', { status: 500 }),
    );
    await expect(
      deleteSession('t', 's1', fetchMock as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe('api/sessions.listSessions (#670)', () => {
  it('GETs /api/sessions with Bearer token and returns the parsed sessions array', async () => {
    const rows = [
      { sid: 's1', createdAt: 1, alive: true },
      { sid: 's2', createdAt: 2, alive: false },
    ];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/sessions');
      expect(init.method).toBe('GET');
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer secret-token');
      return new Response(JSON.stringify({ sessions: rows }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const got = await listSessions(
      'secret-token',
      fetchMock as unknown as typeof fetch,
    );
    expect(got).toEqual({ sessions: rows });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws HttpError(401) when daemon rejects the token', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('unauthorized', { status: 401 }),
    );
    await expect(
      listSessions('bad', fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({
      name: 'HttpError',
      status: 401,
    });
  });

  it('propagates fetch transport errors unchanged (network failure)', async () => {
    const boom = new TypeError('network down');
    const fetchMock = vi.fn(async () => {
      throw boom;
    });
    await expect(
      listSessions('t', fetchMock as unknown as typeof fetch),
    ).rejects.toBe(boom);
  });
});
