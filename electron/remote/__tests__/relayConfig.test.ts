import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => ''),
    isPackaged: false,
  },
}));

import { resolveRelayUrl } from '../relayConfig';

describe('desktop relay configuration', () => {
  it('accepts only an HTTPS workers.dev URL in packaged builds', () => {
    expect(
      resolveRelayUrl({
        isPackaged: true,
        packageMetadata: { mobileRemoteRelayUrl: 'https://ccsm-relay.example.workers.dev' },
        env: {},
      }),
    ).toBe('https://ccsm-relay.example.workers.dev');

    for (const mobileRemoteRelayUrl of [
      'http://ccsm-relay.example.workers.dev',
      'https://workers.dev',
      'https://relay.example.com',
      'https://ccsm-relay.example.workers.dev/path',
      'https://ccsm-relay.example.workers.dev?token=secret',
    ]) {
      expect(
        resolveRelayUrl({
          isPackaged: true,
          packageMetadata: { mobileRemoteRelayUrl },
          env: {},
        }),
      ).toBeNull();
    }
  });

  it('uses the environment override only during development', () => {
    const env = { CCSM_MOBILE_REMOTE_RELAY_URL: 'http://127.0.0.1:8787' };

    expect(resolveRelayUrl({ isPackaged: false, packageMetadata: {}, env })).toBe(
      'http://127.0.0.1:8787',
    );
    expect(resolveRelayUrl({ isPackaged: true, packageMetadata: {}, env })).toBeNull();
  });
});
