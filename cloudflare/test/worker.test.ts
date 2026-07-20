/* global Headers, Request, Response */

import { describe, expect, it, vi } from 'vitest';

import worker, { type Env } from '../src/worker';

const ROOM_ID = 'a'.repeat(43);

function request(
  path: string,
  {
    method = 'GET',
    origin,
    upgrade = true,
    ip = '203.0.113.9',
  }: {
    method?: string;
    origin?: string;
    upgrade?: boolean;
    ip?: string;
  } = {},
): Request {
  const headers = new Headers({ 'CF-Connecting-IP': ip });
  if (upgrade) headers.set('Upgrade', 'websocket');
  if (origin) headers.set('Origin', origin);
  return new Request(`https://relay.example${path}`, { headers, method });
}

function fakeEnv({ allowed = true } = {}) {
  const roomFetch = vi.fn(async () => new Response('room'));
  const getByName = vi.fn(() => ({ fetch: roomFetch }));
  const assetFetch = vi.fn(async () => new Response('asset'));
  const limit = vi.fn(async () => ({ success: allowed }));
  const env = {
    ASSETS: { fetch: assetFetch },
    RELAY: { getByName },
    RELAY_RATE_LIMITER: { limit },
  } as unknown as Env;
  return { assetFetch, env, getByName, limit, roomFetch };
}

describe('relay worker', () => {
  it('delegates non-relay GET requests to static assets', async () => {
    const { assetFetch, env } = fakeEnv();
    const input = request('/index.html', { upgrade: false });

    expect(await (await worker.fetch(input, env)).text()).toBe('asset');
    expect(assetFetch).toHaveBeenCalledWith(input);
  });

  it.each([
    ['non-GET method', request(`/relay/${ROOM_ID}?role=desktop`, { method: 'POST' })],
    ['bad path', request('/relay/bad?role=desktop')],
    ['bad role', request(`/relay/${ROOM_ID}?role=visitor`)],
    ['duplicate role', request(`/relay/${ROOM_ID}?role=desktop&role=phone`)],
    ['unexpected query', request(`/relay/${ROOM_ID}?role=desktop&debug=true`)],
    ['missing upgrade', request(`/relay/${ROOM_ID}?role=desktop`, { upgrade: false })],
    [
      'missing phone origin',
      request(`/relay/${ROOM_ID}?role=phone`),
    ],
    [
      'cross-origin phone',
      request(`/relay/${ROOM_ID}?role=phone`, { origin: 'https://evil.example' }),
    ],
  ])('rejects %s', async (_label, input) => {
    const { env, getByName } = fakeEnv();

    expect((await worker.fetch(input, env)).status).toBe(400);
    expect(getByName).not.toHaveBeenCalled();
  });

  it('allows a same-origin phone WebSocket request', async () => {
    const { env, getByName } = fakeEnv();
    const input = request(`/relay/${ROOM_ID}?role=phone`, {
      origin: 'https://relay.example',
    });

    expect((await worker.fetch(input, env)).status).toBe(200);
    expect(getByName).toHaveBeenCalledWith(ROOM_ID);
  });

  it('rate limits by client IP before creating the Durable Object', async () => {
    const { env, getByName, limit } = fakeEnv({ allowed: false });
    const input = request(`/relay/${ROOM_ID}?role=desktop`);

    expect((await worker.fetch(input, env)).status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.9' });
    expect(getByName).not.toHaveBeenCalled();
  });
});
