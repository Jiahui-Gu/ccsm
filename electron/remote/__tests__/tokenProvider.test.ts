// electron/remote/__tests__/tokenProvider.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { readMobileRemoteLogin } from '../tokenProvider';

const KEYS = ['CCSM_MOBILE_REMOTE_TOKEN', 'CCSM_MOBILE_REMOTE_DO_URL'];

afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('readMobileRemoteLogin', () => {
  it('returns null when no token is configured', () => {
    expect(readMobileRemoteLogin()).toBeNull();
  });

  it('returns null when token is set but DO url is missing', () => {
    process.env.CCSM_MOBILE_REMOTE_TOKEN = 'jwt123';
    expect(readMobileRemoteLogin()).toBeNull();
  });

  it('returns the login when both token and DO url are present', () => {
    process.env.CCSM_MOBILE_REMOTE_TOKEN = 'jwt123';
    process.env.CCSM_MOBILE_REMOTE_DO_URL = 'wss://ccsm-worker.example.workers.dev/do/HASH';
    expect(readMobileRemoteLogin()).toEqual({
      token: 'jwt123',
      doUrl: 'wss://ccsm-worker.example.workers.dev/do/HASH',
    });
  });
});
