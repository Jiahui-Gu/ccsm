import { describe, it, expect, vi } from 'vitest';
import { parseBootFragment, resolveIceServers } from '../phonePage';

describe('parseBootFragment', () => {
  it('reads token, doUrl and stun out of a location.hash', () => {
    const hash = '#token=JWT&doUrl=wss://h/do/u&stun=stun:a:1,stun:b:2&expiresInSeconds=900';
    const b = parseBootFragment(hash);
    expect(b.token).toBe('JWT');
    expect(b.doUrl).toBe('wss://h/do/u');
    expect(b.stun).toEqual(['stun:a:1', 'stun:b:2']);
  });

  it('returns null token when the fragment is empty', () => {
    expect(parseBootFragment('').token).toBeNull();
  });
});

describe('resolveIceServers', () => {
  it('uses /turn/credentials iceServers on 200', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ iceServers: [{ urls: ['stun:x:1'] }, { urls: ['turn:y:2'], username: 'u', credential: 'c' }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const ice = await resolveIceServers('https://w', 'JWT', ['stun:frag:1'], fetchFn);
    expect(ice).toEqual([{ urls: ['stun:x:1'] }, { urls: ['turn:y:2'], username: 'u', credential: 'c' }]);
    expect((fetchFn as any).mock.calls[0][1].headers.Authorization).toBe('Bearer JWT');
  });

  it('falls back to fragment STUN when /turn/credentials is 501', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 501 })) as unknown as typeof fetch;
    const ice = await resolveIceServers('https://w', 'JWT', ['stun:frag:1'], fetchFn);
    expect(ice).toEqual([{ urls: ['stun:frag:1'] }]);
  });
});
