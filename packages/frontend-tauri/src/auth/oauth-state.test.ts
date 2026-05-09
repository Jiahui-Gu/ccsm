// S4-T8 (Task #141): unit tests for the oauth-state SPA helper. We mock
// @tauri-apps/api so no real IPC happens — the goal is to lock in the
// command names + event channel names (the wire contract with auth.rs).

import { describe, expect, it, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

// Import AFTER mocks so the module picks up the mocked invoke/listen.
import {
  invokeStartOauth,
  invokeGetOauthState,
  invokeGetOauthLogin,
  invokeOauthLogout,
  onOauthComplete,
  onOauthFailed,
  onOauthStateChange,
} from './oauth-state';

describe('oauth-state helpers', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  it('invokeStartOauth invokes the start_oauth command', async () => {
    invokeMock.mockResolvedValueOnce({
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    });
    const out = await invokeStartOauth();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('start_oauth');
    expect(out.user_code).toBe('ABCD-1234');
  });

  it('invokeGetOauthState invokes get_oauth_state', async () => {
    invokeMock.mockResolvedValueOnce('idle');
    expect(await invokeGetOauthState()).toBe('idle');
    expect(invokeMock).toHaveBeenCalledWith('get_oauth_state');
  });

  it('invokeGetOauthLogin invokes get_oauth_login', async () => {
    invokeMock.mockResolvedValueOnce('octocat');
    expect(await invokeGetOauthLogin()).toBe('octocat');
    expect(invokeMock).toHaveBeenCalledWith('get_oauth_login');
  });

  it('invokeOauthLogout invokes oauth_logout', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await invokeOauthLogout();
    expect(invokeMock).toHaveBeenCalledWith('oauth_logout');
  });

  it('onOauthComplete subscribes to oauth-complete', async () => {
    const unlisten = vi.fn();
    listenMock.mockImplementationOnce((_event: string, cb: (e: unknown) => void) => {
      cb({ payload: { login: 'octocat' } });
      return Promise.resolve(unlisten);
    });
    const got: string[] = [];
    await onOauthComplete((p) => got.push(p.login));
    expect(listenMock).toHaveBeenCalledWith('oauth-complete', expect.any(Function));
    expect(got).toEqual(['octocat']);
  });

  it('onOauthFailed subscribes to oauth-failed', async () => {
    const unlisten = vi.fn();
    listenMock.mockImplementationOnce((_event: string, cb: (e: unknown) => void) => {
      cb({ payload: { reason: 'expired' } });
      return Promise.resolve(unlisten);
    });
    const got: string[] = [];
    await onOauthFailed((p) => got.push(p.reason));
    expect(listenMock).toHaveBeenCalledWith('oauth-failed', expect.any(Function));
    expect(got).toEqual(['expired']);
  });

  it('onOauthStateChange subscribes to oauth-state-change', async () => {
    const unlisten = vi.fn();
    listenMock.mockImplementationOnce((_event: string, cb: (e: unknown) => void) => {
      cb({ payload: 'awaiting_user' });
      return Promise.resolve(unlisten);
    });
    const got: string[] = [];
    await onOauthStateChange((s) => got.push(s));
    expect(listenMock).toHaveBeenCalledWith('oauth-state-change', expect.any(Function));
    expect(got).toEqual(['awaiting_user']);
  });
});
