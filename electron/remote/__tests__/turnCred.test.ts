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
    for (const s of result ?? []) expect(typeof s.urls).toBe('string');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://w.example.dev/turn/credentials');
    expect(calls[0].init?.method).toBe('POST');
    expect(
      (calls[0].init?.headers as Record<string, string>).authorization,
    ).toBe('Bearer JWT');
  });

  it('flattens an array of STUN urls into singular entries', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        iceServers: [{ urls: ['stun:a:3478', 'stun:b:3478'] }],
      })) as unknown as typeof fetch;
    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });
    expect(result).toEqual([{ urls: 'stun:a:3478' }, { urls: 'stun:b:3478' }]);
    for (const s of result ?? []) expect(typeof s.urls).toBe('string');
  });

  it('carries username/credential onto every TURN url', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        iceServers: [
          { urls: ['turn:t:3478', 'turns:t:5349'], username: 'u', credential: 'c' },
        ],
      })) as unknown as typeof fetch;
    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });
    expect(result).toEqual([
      { urls: 'turn:t:3478', username: 'u', credential: 'c' },
      { urls: 'turns:t:5349', username: 'u', credential: 'c' },
    ]);
  });

  it('handles the real mixed STUN+TURN Worker shape', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        iceServers: [
          { urls: ['stun:s:3478'] },
          { urls: ['turn:t:3478'], username: 'u', credential: 'c' },
        ],
      })) as unknown as typeof fetch;
    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });
    expect(result).toEqual([
      { urls: 'stun:s:3478' },
      { urls: 'turn:t:3478', username: 'u', credential: 'c' },
    ]);
  });

  it('passes through already-singular urls unchanged (idempotent)', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ iceServers: [{ urls: 'stun:x:3478' }] })) as unknown as typeof fetch;
    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });
    expect(result).toEqual([{ urls: 'stun:x:3478' }]);
  });

  it('returns null when flattening yields no usable urls', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ iceServers: [{ urls: [] }, { urls: '' }] })) as unknown as typeof fetch;
    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });
    expect(result).toBeNull();
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
