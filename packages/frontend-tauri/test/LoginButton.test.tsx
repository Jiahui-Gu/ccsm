// R-51c (Task #169): vitest coverage of LoginButton's PKCE-default + device
// fallback UX, plus the 5 s auto-expand timer and the
// `oauth-failed`-routing-by-active-flow logic.
//
// Why vitest + RTL stand in for an e2e Tauri assertion:
//   The PR includes a manual end-to-end Tauri smoke (PR body) that proves
//   the real `start_pkce_oauth` -> browser -> deep-link -> daemon-ready
//   round-trip works on Windows. This suite locks in the SPA contract:
//   which command name fires on which click, the auto-expand timing, and
//   the error-surfacing routing — none of which depend on real IPC.
//
// What we mock and why:
//   - `@tauri-apps/api/core` and `@tauri-apps/api/event`: the Tauri runtime
//     is absent under jsdom (no `window.__TAURI_INTERNALS__`). The mocks
//     hold per-test handles so we can assert command names + drive the
//     event callbacks deterministically.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

// --- module mocks --------------------------------------------------------

const invokeMock = vi.fn();
type Listener = (e: { payload: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();
const listenMock = vi.fn(async (event: string, cb: Listener) => {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...(args as [string, Listener])),
}));

// Import AFTER mocks so the component picks up the mocked Tauri runtime.
import { LoginButton, PKCE_AUTOFALLBACK_MS } from '../src/auth/LoginButton';

function emit(event: string, payload: unknown) {
  const set = listeners.get(event);
  if (!set) return;
  for (const cb of [...set]) cb({ payload });
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockClear();
  listeners.clear();
  // Default: get_oauth_login returns null so we render the logged-out tree.
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_oauth_login') return null;
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LoginButton (R-51c / Task #169)', () => {
  it('renders the PKCE primary button by default with the fallback link collapsed', async () => {
    await act(async () => {
      render(<LoginButton />);
    });
    expect(screen.getByTestId('login-button-pkce').textContent).toContain('Sign in with GitHub');
    // Fallback toggle visible, fallback body collapsed.
    const toggle = screen.getByTestId('login-button-fallback-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('login-button-fallback-body')).toBeNull();
    expect(screen.queryByTestId('login-button-device')).toBeNull();
    // No modal until device flow runs.
    expect(screen.queryByTestId('oauth-modal')).toBeNull();
  });

  it('clicking the primary button invokes start_pkce_oauth (not start_oauth / not device)', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_oauth_login') return null;
      if (cmd === 'start_pkce_oauth') return undefined;
      throw new Error(`unexpected invoke ${cmd}`);
    });
    await act(async () => {
      render(<LoginButton />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-button-pkce'));
    });
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain('start_pkce_oauth');
    expect(calls).not.toContain('start_oauth');
    expect(calls).not.toContain('start_device_oauth');
  });

  it('toggling the fallback link expands the device-flow row and reveals the "Use a code" button', async () => {
    await act(async () => {
      render(<LoginButton />);
    });
    fireEvent.click(screen.getByTestId('login-button-fallback-toggle'));
    expect(screen.getByTestId('login-button-fallback-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('login-button-fallback-body')).toBeDefined();
    expect(screen.getByTestId('login-button-device').textContent).toContain('Use a code');
  });

  it('clicking "Use a code" invokes start_device_oauth and shows the user_code modal', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_oauth_login') return null;
      if (cmd === 'start_device_oauth') {
        return {
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        };
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
    await act(async () => {
      render(<LoginButton />);
    });
    fireEvent.click(screen.getByTestId('login-button-fallback-toggle'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-button-device'));
    });
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain('start_device_oauth');
    expect(screen.getByTestId('oauth-modal')).toBeDefined();
    expect(screen.getByTestId('oauth-user-code').textContent).toContain('ABCD-1234');
  });

  it('an oauth-complete event after PKCE click switches to the logged-in view and clears the auto-fallback timer', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_oauth_login') return null;
      if (cmd === 'start_pkce_oauth') return undefined;
      throw new Error(`unexpected invoke ${cmd}`);
    });
    await act(async () => {
      render(<LoginButton />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-button-pkce'));
    });
    // Simulate the deep-link round-trip succeeding well before the 5 s
    // auto-fallback fires.
    await act(async () => {
      emit('oauth-complete', { login: 'octocat' });
    });
    expect(screen.getByTestId('login-button').textContent).toContain('@octocat');
    // Advancing past the auto-fallback window must NOT pop the fallback
    // open after a successful login.
    await act(async () => {
      vi.advanceTimersByTime(PKCE_AUTOFALLBACK_MS + 1_000);
    });
    expect(screen.queryByTestId('login-button-fallback-body')).toBeNull();
  });

  it('5 s after PKCE click without resolution, the fallback row auto-expands', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_oauth_login') return null;
      if (cmd === 'start_pkce_oauth') return undefined;
      throw new Error(`unexpected invoke ${cmd}`);
    });
    await act(async () => {
      render(<LoginButton />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-button-pkce'));
    });
    expect(screen.queryByTestId('login-button-fallback-body')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(PKCE_AUTOFALLBACK_MS + 100);
    });
    expect(screen.getByTestId('login-button-fallback-body')).toBeDefined();
    expect(screen.getByTestId('login-button-device')).toBeDefined();
  });

  it('an oauth-failed event after PKCE click surfaces the inline error and auto-expands the fallback', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_oauth_login') return null;
      if (cmd === 'start_pkce_oauth') return undefined;
      throw new Error(`unexpected invoke ${cmd}`);
    });
    await act(async () => {
      render(<LoginButton />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-button-pkce'));
    });
    await act(async () => {
      emit('oauth-failed', { reason: 'state mismatch' });
    });
    expect(screen.getByTestId('login-button-pkce-error').textContent).toContain('state mismatch');
    // PKCE failure must auto-open the fallback row so the user has a
    // visible next step instead of being stuck.
    expect(screen.getByTestId('login-button-fallback-body')).toBeDefined();
  });

  it('an oauth-failed event during device flow surfaces the error inside the modal (not as inline PKCE error)', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_oauth_login') return null;
      if (cmd === 'start_device_oauth') {
        return {
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        };
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
    await act(async () => {
      render(<LoginButton />);
    });
    fireEvent.click(screen.getByTestId('login-button-fallback-toggle'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-button-device'));
    });
    await act(async () => {
      emit('oauth-failed', { reason: 'device code expired' });
    });
    expect(screen.getByTestId('oauth-modal').textContent).toContain('device code expired');
    expect(screen.queryByTestId('login-button-pkce-error')).toBeNull();
  });

  it('a synchronous start_pkce_oauth rejection (e.g. CCSM_AUTH_BASE missing) shows inline error and opens fallback', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_oauth_login') return null;
      if (cmd === 'start_pkce_oauth') {
        throw 'CCSM_AUTH_BASE env not set';
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
    await act(async () => {
      render(<LoginButton />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('login-button-pkce'));
    });
    expect(screen.getByTestId('login-button-pkce-error').textContent).toContain('CCSM_AUTH_BASE');
    expect(screen.getByTestId('login-button-fallback-body')).toBeDefined();
  });

  it('renders the logged-in view when get_oauth_login returns a username on mount', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_oauth_login') return 'octocat';
      return undefined;
    });
    await act(async () => {
      render(<LoginButton />);
    });
    expect(screen.getByTestId('login-button').textContent).toContain('@octocat');
  });
});
