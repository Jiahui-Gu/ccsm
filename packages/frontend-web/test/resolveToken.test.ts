// Token bootstrap priority chain (Task #696).

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
});
