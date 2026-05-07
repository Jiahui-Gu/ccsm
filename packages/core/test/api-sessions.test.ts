import { describe, it, expect, vi } from 'vitest';
import {
  HttpError,
  createSession,
  deleteSession,
  listSessions,
  resumeSession,
  type SessionsApiOptions,
} from '../src/api/sessions.js';

const TOKEN = 'test-token-abc';
const BASE = 'http://127.0.0.1:17832';

// Build a vitest-mocked fetch that returns a single canned Response shape.
// We assert on the (url, init) args the production code passes through.
function mockFetch(
  status: number,
  body: unknown,
  bodyText?: string,
): {
  fetch: typeof globalThis.fetch;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
      async text() {
        return bodyText ?? JSON.stringify(body);
      },
    } as unknown as Response;
  });
  return { fetch: spy as unknown as typeof globalThis.fetch, spy };
}

function opts(fetchImpl: typeof globalThis.fetch): SessionsApiOptions {
  return { baseUrl: BASE, fetch: fetchImpl };
}

describe('createSession', () => {
  it('POSTs to {baseUrl}/api/sessions with bearer token + JSON body', async () => {
    const { fetch, spy } = mockFetch(200, { sid: 's1' });
    const out = await createSession(TOKEN, { cwd: '/tmp' }, opts(fetch));
    expect(out).toEqual({ sid: 's1' });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:17832/api/sessions');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['content-type']).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ cwd: '/tmp' }));
  });

  it('defaults body to {} when omitted (still sends JSON null-object)', async () => {
    const { fetch, spy } = mockFetch(200, { sid: 's2' });
    await createSession(TOKEN, undefined, opts(fetch));
    const [, init] = spy.mock.calls[0]!;
    expect(init?.body).toBe('{}');
  });

  it('throws HttpError on non-2xx with status preserved', async () => {
    const { fetch } = mockFetch(500, {}, 'boom');
    await expect(
      createSession(TOKEN, {}, opts(fetch)),
    ).rejects.toMatchObject({ name: 'HttpError', status: 500 });
  });
});

describe('listSessions', () => {
  it('GETs {baseUrl}/api/sessions with bearer header', async () => {
    const { fetch, spy } = mockFetch(200, { sessions: [] });
    const out = await listSessions(TOKEN, opts(fetch));
    expect(out).toEqual({ sessions: [] });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:17832/api/sessions');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('throws HttpError on 401', async () => {
    const { fetch } = mockFetch(401, {}, 'unauthorized');
    await expect(listSessions(TOKEN, opts(fetch))).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});

describe('resumeSession', () => {
  it('POSTs to {baseUrl}/api/sessions/{sid}/resume', async () => {
    const { fetch, spy } = mockFetch(200, { ok: true });
    const out = await resumeSession(TOKEN, 'sid-1', opts(fetch));
    expect(out).toEqual({ ok: true });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(
      'http://127.0.0.1:17832/api/sessions/sid-1/resume',
    );
    expect(init?.method).toBe('POST');
  });

  it('encodes sid in URL', async () => {
    const { fetch, spy } = mockFetch(200, { ok: true });
    await resumeSession(TOKEN, 'a/b c', opts(fetch));
    const [url] = spy.mock.calls[0]!;
    expect(url).toBe(
      'http://127.0.0.1:17832/api/sessions/a%2Fb%20c/resume',
    );
  });

  it('throws when 2xx body lacks ok:true', async () => {
    const { fetch } = mockFetch(200, { error: 'pty_spawn_failed' });
    await expect(
      resumeSession(TOKEN, 'sid-1', opts(fetch)),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('surfaces 404 as HttpError(404) (caller branches on status)', async () => {
    const { fetch } = mockFetch(404, {}, 'not_found');
    await expect(
      resumeSession(TOKEN, 'gone', opts(fetch)),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('deleteSession', () => {
  it('DELETEs {baseUrl}/api/sessions/{sid}', async () => {
    const { fetch, spy } = mockFetch(200, { ok: true });
    const out = await deleteSession(TOKEN, 'sid-2', opts(fetch));
    expect(out).toEqual({ ok: true });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:17832/api/sessions/sid-2');
    expect(init?.method).toBe('DELETE');
    expect((init?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('treats 404 as success (session already gone)', async () => {
    const { fetch } = mockFetch(404, {}, 'not_found');
    const out = await deleteSession(TOKEN, 'sid-x', opts(fetch));
    expect(out).toEqual({ ok: true });
  });

  it('throws HttpError on 5xx', async () => {
    const { fetch } = mockFetch(500, {}, 'boom');
    await expect(
      deleteSession(TOKEN, 'sid-x', opts(fetch)),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe('SessionsApiOptions', () => {
  it('falls back to globalThis.fetch when fetch is not provided', async () => {
    const orig = globalThis.fetch;
    const spy = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        async json() {
          return { sessions: [] };
        },
        async text() {
          return '';
        },
      } as unknown as Response;
    });
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    try {
      await listSessions(TOKEN, { baseUrl: BASE });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('empty baseUrl yields same-origin paths', async () => {
    const { fetch, spy } = mockFetch(200, { sessions: [] });
    await listSessions(TOKEN, { baseUrl: '', fetch });
    expect(spy.mock.calls[0]![0]).toBe('/api/sessions');
  });
});
