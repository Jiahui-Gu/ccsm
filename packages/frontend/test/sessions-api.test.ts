import { describe, it, expect, vi } from 'vitest';
import { createSession, HttpError } from '../src/api/sessions';

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
