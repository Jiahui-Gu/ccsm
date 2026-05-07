// Token bootstrap priority chain (Task #696, cross-origin matrix Task #719).

import { describe, expect, it, vi } from 'vitest';

import { resolveToken } from '../src/hostConfig';

function mockFetch(impl: typeof globalThis.fetch): typeof globalThis.fetch {
  return vi.fn(impl) as unknown as typeof globalThis.fetch;
}

describe('resolveToken', () => {
  it('prefers URL ?token= when present (back-compat)', async () => {
    const fetch = mockFetch(async () => {
      throw new Error('should not be called');
    });
    const got = await resolveToken({ search: '?token=from-url-1', fetch });
    expect(got).toBe('from-url-1');
  });

  it('falls back to GET /token when URL has no token', async () => {
    const fetch = mockFetch(async (input) => {
      expect(String(input)).toBe('/token');
      return new Response(JSON.stringify({ token: 'from-daemon' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const got = await resolveToken({ search: '', fetch });
    expect(got).toBe('from-daemon');
  });

  it('returns null when /token returns non-2xx (daemon offline)', async () => {
    const fetch = mockFetch(
      async () => new Response('nope', { status: 502 }),
    );
    const got = await resolveToken({ search: '', fetch });
    expect(got).toBeNull();
  });

  it('returns null when /token throws (network error)', async () => {
    const fetch = mockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const got = await resolveToken({ search: '', fetch });
    expect(got).toBeNull();
  });

  it('returns null when /token body has no token field', async () => {
    const fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const got = await resolveToken({ search: '', fetch });
    expect(got).toBeNull();
  });

  it('treats empty URL token as missing and falls back to /token', async () => {
    const fetch = mockFetch(async () =>
      new Response(JSON.stringify({ token: 'from-daemon-2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const got = await resolveToken({ search: '?token=', fetch });
    expect(got).toBe('from-daemon-2');
  });

  // ---------------------------------------------------------------------
  // Task #719 (S2-T4): cross-origin matrix.
  // When the SPA is served from a different origin than the daemon (e.g.
  // Cloudflare Pages → http://127.0.0.1:9876), the relative `/token` path
  // would hit the SPA host instead of the daemon. resolveToken must use the
  // resolved daemon base as an absolute URL prefix.
  // ---------------------------------------------------------------------

  describe('cross-origin (daemonBase set)', () => {
    const DAEMON_BASE = 'http://127.0.0.1:9876';

    it('still prefers URL ?token= without hitting fetch', async () => {
      const fetch = mockFetch(async () => {
        throw new Error('should not be called');
      });
      const got = await resolveToken({
        search: '?token=from-url-xo',
        fetch,
        daemonBase: DAEMON_BASE,
      });
      expect(got).toBe('from-url-xo');
    });

    it('fetches absolute <daemonBase>/token URL when URL has no token', async () => {
      const fetch = mockFetch(async (input) => {
        expect(String(input)).toBe(`${DAEMON_BASE}/token`);
        return new Response(JSON.stringify({ token: 'from-daemon-xo' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const got = await resolveToken({
        search: '',
        fetch,
        daemonBase: DAEMON_BASE,
      });
      expect(got).toBe('from-daemon-xo');
    });

    it('returns null when cross-origin daemon is offline (fetch throws)', async () => {
      // Mirrors the browser's behaviour when the loopback daemon is down or
      // CORS preflight fails: TypeError from window.fetch.
      const fetch = mockFetch(async () => {
        throw new TypeError('Failed to fetch');
      });
      const got = await resolveToken({
        search: '',
        fetch,
        daemonBase: DAEMON_BASE,
      });
      expect(got).toBeNull();
    });

    it('returns null when cross-origin /token responds non-2xx', async () => {
      const fetch = mockFetch(
        async () => new Response('forbidden', { status: 403 }),
      );
      const got = await resolveToken({
        search: '',
        fetch,
        daemonBase: DAEMON_BASE,
      });
      expect(got).toBeNull();
    });

    it('returns null when cross-origin /token body lacks token field', async () => {
      const fetch = mockFetch(
        async () =>
          new Response(JSON.stringify({ other: 'x' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const got = await resolveToken({
        search: '',
        fetch,
        daemonBase: DAEMON_BASE,
      });
      expect(got).toBeNull();
    });

    it('empty URL token + cross-origin → falls back to <daemonBase>/token', async () => {
      const fetch = mockFetch(async (input) => {
        expect(String(input)).toBe(`${DAEMON_BASE}/token`);
        return new Response(JSON.stringify({ token: 'from-daemon-xo-2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const got = await resolveToken({
        search: '?token=',
        fetch,
        daemonBase: DAEMON_BASE,
      });
      expect(got).toBe('from-daemon-xo-2');
    });

    it('empty daemonBase string is treated as same-origin (relative /token)', async () => {
      // Defensive: callers should pass the result of resolveDaemonBase(), but
      // an empty string must not produce a malformed URL.
      const fetch = mockFetch(async (input) => {
        expect(String(input)).toBe('/token');
        return new Response(JSON.stringify({ token: 'from-same-origin' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const got = await resolveToken({
        search: '',
        fetch,
        daemonBase: '',
      });
      expect(got).toBe('from-same-origin');
    });
  });
});
