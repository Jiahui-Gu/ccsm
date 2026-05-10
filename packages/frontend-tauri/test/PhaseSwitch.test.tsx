// Task #138 (#112-T5) — vitest coverage of PhaseSwitch routing.
//
// Contract validated here:
//   "When the daemon has not (yet) spawned successfully, the Tauri shell
//    must render DaemonStatusOverlay with a phase-appropriate variant
//    instead of a black screen. Once the daemon emits Ready, the overlay
//    collapses and the real app shell mounts under RuntimeProvider with a
//    hostConfig built from the Ready payload."
//
// Why a vitest-based assertion stands in for an e2e Tauri-window assertion:
//   - The black-screen regression we're guarding against was 'React tree
//     never mounted because bootstrap awaited daemon-ready before
//     createRoot' (see main.tsx header). Task #112-T3 fixed it by mounting
//     <App> synchronously and routing on phase inside the tree. The
//     observable contract that proves the fix is: for every non-Ready
//     phase, the component tree renders a visible non-empty Overlay.
//     That contract lives entirely in PhaseSwitch — which is what we
//     exercise here.
//   - Option A (tauri-driver + Playwright) requires `cargo install
//     tauri-driver`, an Edge WebDriver pin, and a Tauri release build per
//     run. The task spec explicitly authorises falling back to Option B
//     (this file) when Option A's setup exceeds 30 min, with the
//     Tauri-window check moved to a manual smoke recorded in the PR body.
//
// What we mock and why:
//   - `@ccsm/ui`: the real RuntimeProvider mounts useBootstrap, which fires
//     `GET /api/sessions` against the daemon. We don't want this suite to
//     spin up an HTTP server or stub fetch globally, so RuntimeProvider /
//     AppShell / MainPane / Sidebar / useBootstrap are replaced with
//     identity stubs. DaemonStatusOverlay is re-exported as the real
//     component because it's the assertion target.
//   - `@tauri-apps/api/event`: PhaseSwitch is wrapped in DaemonStateContext
//     directly in tests, so the real `listen` from the Tauri runtime never
//     runs. We still mock it defensively in case future refactors pull
//     the listener back into PhaseSwitch.
//
// Phase coverage matches src/types.ts DaemonPhase exhaustiveness.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  DaemonStatusOverlay,
  type DaemonStatusOverlayProps,
} from '@ccsm/ui';

import { PhaseSwitch } from '../src/App';
import { DaemonStateContext } from '../src/DaemonStateProvider';
import type { DaemonStatePayload } from '../src/types';

// --- module mocks --------------------------------------------------------

// Replace the heavy parts of @ccsm/ui with leaf stubs so Ready can render
// without hitting the network. Keep DaemonStatusOverlay real.
vi.mock('@ccsm/ui', async () => {
  const actual =
    await vi.importActual<typeof import('@ccsm/ui')>('@ccsm/ui');
  return {
    ...actual,
    AppShell: ({ sidebar, main }: { sidebar: unknown; main: unknown }) => (
      <div data-testid="terminal-pane">
        <div data-testid="appshell-sidebar">{sidebar as React.ReactNode}</div>
        <div data-testid="appshell-main">{main as React.ReactNode}</div>
      </div>
    ),
    Sidebar: () => <div data-testid="stub-sidebar" />,
    MainPane: () => <div data-testid="stub-main" />,
    useBootstrap: () => undefined,
    RuntimeProvider: ({
      hostConfig,
      children,
    }: {
      hostConfig: { httpBase: string; getToken: () => string };
      children: React.ReactNode;
    }) => (
      <div
        data-testid="runtime-provider"
        data-http-base={hostConfig.httpBase}
        data-token={hostConfig.getToken()}
      >
        {children}
      </div>
    ),
    DaemonStatusOverlay: (props: DaemonStatusOverlayProps) => (
      <actual.DaemonStatusOverlay {...props} />
    ),
  };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

// LoginButton's mount effect calls Tauri `invoke('get_oauth_login')` which
// throws in jsdom because `window.__TAURI_INTERNALS__` is undefined. Stub the
// component so tests that render the Ready branch (which mounts AppContent →
// AppShell → sidebar slot containing <LoginButton />) don't surface unhandled
// rejections from a side-effect that is irrelevant to the routing contract
// under test.
vi.mock('../src/auth/LoginButton', () => ({
  LoginButton: () => <div data-testid="stub-login-button" />,
}));

// --- helpers -------------------------------------------------------------

function renderWithPhase(payload: DaemonStatePayload) {
  return render(
    <DaemonStateContext.Provider value={payload}>
      <PhaseSwitch />
    </DaemonStateContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
});

// --- tests ---------------------------------------------------------------

describe('PhaseSwitch (Task #138 / #112-T5)', () => {
  // Loading-style phases — info variant, no terminal pane.
  it.each([
    ['notSpawned', 'Starting daemon'],
    ['spawning', 'Starting daemon'],
    ['starting', 'Starting daemon'],
  ] as const)(
    'renders DaemonStatusOverlay (info) for phase %s — no black screen',
    (phaseName, fragment) => {
      renderWithPhase({ generation: 1, phase: phaseName });
      const overlay = screen.getByTestId('daemon-status-overlay');
      expect(overlay.getAttribute('data-phase')).toBe(phaseName);
      expect(overlay.getAttribute('data-variant')).toBe('info');
      expect(
        screen.getByTestId('daemon-status-overlay-loading').textContent ?? '',
      ).toContain(fragment);
      // The real app must not have mounted yet.
      expect(screen.queryByTestId('terminal-pane')).toBeNull();
      expect(screen.queryByTestId('runtime-provider')).toBeNull();
    },
  );

  it('renders DaemonStatusOverlay (info) for tunnelDisconnected', () => {
    // R-50 (Task #164) regression guard: previously this case rendered an
    // overlay that froze the SPA. Now `tunnelDisconnected` is no longer a
    // top-level phase — it lives inside `ready` as `tunnel: 'disconnected'`,
    // and the overlay must collapse so the main app stays mounted while the
    // tunnel reconnects in the background.
    renderWithPhase({
      generation: 2,
      phase: 'ready',
      port: 9876,
      token: 't',
      identity: null,
      tunnel: 'disconnected',
    });
    expect(screen.queryByTestId('daemon-status-overlay')).toBeNull();
    expect(screen.getByTestId('runtime-provider')).toBeDefined();
  });

  it('renders DaemonStatusOverlay (info) for tunnelConnected', () => {
    // R-50 regression guard: handshake-then-tunnel:connected sequence used to
    // overwrite Ready with a top-level TunnelConnected, freezing the SPA on
    // the "Tunnel connected, waiting…" overlay. The fix moves tunnel to a
    // Ready sub-state, so the overlay must NEVER show that text once Ready
    // has landed (regardless of tunnel value).
    renderWithPhase({
      generation: 3,
      phase: 'ready',
      port: 9876,
      token: 't',
      identity: null,
      tunnel: 'connected',
    });
    expect(screen.queryByTestId('daemon-status-overlay')).toBeNull();
    expect(screen.queryByText(/Tunnel connected, waiting/)).toBeNull();
    expect(screen.queryByText(/Starting daemon/)).toBeNull();
    expect(screen.getByTestId('runtime-provider')).toBeDefined();
  });

  // Failure phases — error variant + reason text surfaced (this is the
  // "no daemon => still see an explanation, not black" guarantee).
  it('renders DaemonStatusOverlay (error) with reason for spawnFailed', () => {
    renderWithPhase({
      generation: 4,
      phase: 'spawnFailed',
      reason: 'binary not found on PATH',
      retryInMs: null,
    });
    const overlay = screen.getByTestId('daemon-status-overlay');
    expect(overlay.getAttribute('data-phase')).toBe('spawnFailed');
    expect(overlay.getAttribute('data-variant')).toBe('error');
    expect(
      screen.getByTestId('daemon-status-overlay-detail').textContent ?? '',
    ).toContain('binary not found on PATH');
    expect(screen.queryByTestId('terminal-pane')).toBeNull();
    expect(screen.queryByTestId('runtime-provider')).toBeNull();
  });

  it('renders DaemonStatusOverlay (error) for exited phase', () => {
    renderWithPhase({
      generation: 5,
      phase: 'exited',
      code: 1,
      reason: 'daemon crashed',
    });
    const overlay = screen.getByTestId('daemon-status-overlay');
    expect(overlay.getAttribute('data-variant')).toBe('error');
    expect(
      screen.getByTestId('daemon-status-overlay-banner').textContent ?? '',
    ).toContain('daemon crashed');
  });

  it('renders DaemonStatusOverlay (error) for authFailed', () => {
    renderWithPhase({
      generation: 6,
      phase: 'authFailed',
      reason: 'token rejected',
    });
    expect(
      screen
        .getByTestId('daemon-status-overlay')
        .getAttribute('data-variant'),
    ).toBe('error');
    expect(
      screen.getByTestId('daemon-status-overlay-detail').textContent ?? '',
    ).toContain('token rejected');
  });

  it('renders DaemonStatusOverlay (auth) for awaitingAuth', () => {
    renderWithPhase({
      generation: 7,
      phase: 'awaitingAuth',
      verificationUri: 'https://github.com/login/device',
      userCode: 'ABCD-1234',
      expiresAt: Date.now() + 600_000,
    });
    const overlay = screen.getByTestId('daemon-status-overlay');
    expect(overlay.getAttribute('data-variant')).toBe('auth');
    expect(
      screen.getByTestId('daemon-status-overlay-user-code').textContent ?? '',
    ).toContain('ABCD-1234');
  });

  // Ready — overlay collapses, real shell mounts with hostConfig built from
  // the payload (#112-T3 contract: rebuilding hostConfig per Ready render
  // means a re-spawn re-mounts RuntimeProvider with fresh port/token).
  it('mounts RuntimeProvider + AppShell on phase=ready and hides overlay', () => {
    renderWithPhase({
      generation: 8,
      phase: 'ready',
      port: 9876,
      token: 'tok-xyz',
      identity: { userId: 'u1' },
      tunnel: 'pending',
    });
    expect(screen.queryByTestId('daemon-status-overlay')).toBeNull();
    const rp = screen.getByTestId('runtime-provider');
    expect(rp.getAttribute('data-http-base')).toBe('http://127.0.0.1:9876');
    expect(rp.getAttribute('data-token')).toBe('tok-xyz');
    expect(screen.getByTestId('terminal-pane')).toBeDefined();
  });

  // Recovery flow: re-render with a Ready payload after a SpawnFailed render
  // (matches the spec's "restart Tauri => phase=Ready, terminal-pane visible"
  // step from Option A, expressed as a context-driven re-render).
  it('transitions from spawnFailed overlay to Ready app shell on recovery', () => {
    const { rerender } = render(
      <DaemonStateContext.Provider
        value={{
          generation: 1,
          phase: 'spawnFailed',
          reason: 'PATH missing node',
          retryInMs: null,
        }}
      >
        <PhaseSwitch />
      </DaemonStateContext.Provider>,
    );
    expect(
      screen
        .getByTestId('daemon-status-overlay')
        .getAttribute('data-variant'),
    ).toBe('error');
    expect(screen.queryByTestId('terminal-pane')).toBeNull();

    // Daemon recovers — generation bumps, phase flips to ready.
    rerender(
      <DaemonStateContext.Provider
        value={{
          generation: 2,
          phase: 'ready',
          port: 4321,
          token: 'tok2',
          identity: null,
          tunnel: 'pending',
        }}
      >
        <PhaseSwitch />
      </DaemonStateContext.Provider>,
    );
    expect(screen.queryByTestId('daemon-status-overlay')).toBeNull();
    expect(screen.getByTestId('terminal-pane')).toBeDefined();
    expect(
      screen.getByTestId('runtime-provider').getAttribute('data-token'),
    ).toBe('tok2');
  });
});
