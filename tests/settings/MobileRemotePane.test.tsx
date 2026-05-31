import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import React from 'react';
import { MobileRemotePane } from '../../src/components/settings/MobileRemotePane';
import type { MobileRemoteAuthState } from '../../src/global';

// In-memory shape of the renderer-side bridge for the mobile-remote OAuth
// surface. Exposes the minimum the pane mounts: an authState read, a
// login/logout invoke, and an auth-state push hook.
function makeMobileRemoteCcsm(opts?: { initial?: MobileRemoteAuthState }) {
  const loginSpy = vi.fn(
    async (): Promise<MobileRemoteAuthState> => ({
      loggedIn: true,
      userHash: 'abc123',
      expiresAtMs: Date.now() + 60_000,
      persisted: true,
    }),
  );
  const logoutSpy = vi.fn(
    async (): Promise<MobileRemoteAuthState> => ({
      loggedIn: false,
      userHash: null,
      expiresAtMs: null,
      persisted: true,
    }),
  );
  let pushCb: ((s: MobileRemoteAuthState) => void) | null = null;
  const initial: MobileRemoteAuthState = opts?.initial ?? {
    loggedIn: false,
    userHash: null,
    expiresAtMs: null,
    persisted: true,
  };
  return {
    api: {
      mobileRemoteAuthState: vi.fn(async () => initial),
      mobileRemoteLogin: loginSpy,
      mobileRemoteLogout: logoutSpy,
      onMobileRemoteAuthState: (cb: (s: MobileRemoteAuthState) => void) => {
        pushCb = cb;
        return () => {
          pushCb = null;
        };
      },
    } as unknown as Window['ccsm'],
    spies: { loginSpy, logoutSpy },
    push: (s: MobileRemoteAuthState) => pushCb?.(s),
  };
}

afterEach(() => {
  delete (window as { ccsm?: unknown }).ccsm;
  vi.restoreAllMocks();
});

describe('MobileRemotePane', () => {
  it('shows a Connect button when logged out', async () => {
    const { api } = makeMobileRemoteCcsm();
    (window as { ccsm?: unknown }).ccsm = api;

    await act(async () => {
      render(<MobileRemotePane />);
    });

    await waitFor(() => {
      expect(api!.mobileRemoteAuthState).toHaveBeenCalled();
    });
    expect(screen.getByRole('button', { name: /connect/i })).toBeTruthy();
  });

  it('invokes login when the Connect button is clicked', async () => {
    const { api, spies } = makeMobileRemoteCcsm();
    (window as { ccsm?: unknown }).ccsm = api;

    await act(async () => {
      render(<MobileRemotePane />);
    });

    const btn = screen.getByRole('button', { name: /connect/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(spies.loginSpy).toHaveBeenCalled();
  });

  it('shows a Disconnect button and the user hash when logged in', async () => {
    const { api } = makeMobileRemoteCcsm({
      initial: {
        loggedIn: true,
        userHash: 'deadbeef',
        expiresAtMs: Date.now() + 60_000,
        persisted: true,
      },
    });
    (window as { ccsm?: unknown }).ccsm = api;

    await act(async () => {
      render(<MobileRemotePane />);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /disconnect/i })).toBeTruthy();
    });
    expect(screen.getByText(/deadbeef/)).toBeTruthy();
  });

  it('invokes logout when the Disconnect button is clicked', async () => {
    const { api, spies } = makeMobileRemoteCcsm({
      initial: {
        loggedIn: true,
        userHash: 'deadbeef',
        expiresAtMs: Date.now() + 60_000,
        persisted: true,
      },
    });
    (window as { ccsm?: unknown }).ccsm = api;

    await act(async () => {
      render(<MobileRemotePane />);
    });

    const btn = await screen.findByRole('button', { name: /disconnect/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(spies.logoutSpy).toHaveBeenCalled();
  });

  it('reflects a pushed auth-state change without a re-fetch', async () => {
    const { api, push } = makeMobileRemoteCcsm();
    (window as { ccsm?: unknown }).ccsm = api;

    await act(async () => {
      render(<MobileRemotePane />);
    });

    await screen.findByRole('button', { name: /connect/i });

    await act(async () => {
      push({
        loggedIn: true,
        userHash: 'pushed01',
        expiresAtMs: Date.now() + 60_000,
        persisted: true,
      });
    });

    expect(screen.getByText(/pushed01/)).toBeTruthy();
  });
});
