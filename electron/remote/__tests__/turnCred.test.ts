// electron/remote/__tests__/turnCred.test.ts
import { describe, it, expect } from 'vitest';
import { fetchIceServers } from '../turnCred';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('fetchIceServers', () => {
  it('POSTs /turn/credentials with the bearer token and returns the iceServers array', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        iceServers: [
          { urls: 'stun:stun.cloudflare.com:3478' },
          { urls: 'turn:turn.example:3478', username: 'u', credential: 'c' },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });

    expect(result).toEqual([
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'turn:turn.example:3478', username: 'u', credential: 'c' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://w.example.dev/turn/credentials');
    expect(calls[0].init?.method).toBe('POST');
    expect(
      (calls[0].init?.headers as Record<string, string>).authorization,
    ).toBe('Bearer JWT');
  });

  it('returns null on a 501 (TURN not configured)', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: 'turn not configured' }, false, 501)) as unknown as typeof fetch;
    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  it('returns null when the body has no iceServers array', async () => {
    const fetchImpl = (async () => jsonResponse({ nope: true })) as unknown as typeof fetch;
    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });
    expect(result).toBeNull();
  });
});
