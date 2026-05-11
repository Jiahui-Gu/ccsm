// Task #138 / #181 — vitest coverage of the Tauri shell's PhaseSwitch.
//
// R-57 (Task #181) ARCHITECTURAL REWRITE:
//
// Before this test asserted "every non-Ready phase renders DaemonStatusOverlay
// in PLACE OF the SPA — no terminal-pane / runtime-provider". That was wrong;
// it locked in the bug the user wants fixed (the SPA being hidden behind a
// full-screen overlay during the 2-3 s daemon spawn window).
//
// The NEW contract:
//   - For EVERY phase (including notSpawned / spawning / starting /
//     spawnFailed / exited / awaitingAuth / authFailed / ready), the SPA
//     mounts <RuntimeProvider>, <AppShell> with Sidebar + MainPane.
//   - For non-Ready phases, DaemonStatusOverlay is ALSO rendered (as a
//     chip / banner / dialog, never full-screen).
//   - For Ready phase, DaemonStatusOverlay collapses to null and api/runtime
//     are wired to the real httpBase/token.
//   - For non-Ready phases, RuntimeProvider's api rejects every call with
//     "daemon not ready" (asserted in runtime-context.test, not here).
//
// Why we still keep the legacy `PhaseSwitch` export name + this filename:
// minimising churn for downstream readers + because the routing of phase to
// overlay mode still lives in PhaseSwitch. The test file could be renamed
// to AppShellRouting.test.tsx but #138 traceability is easier with the
// existing name.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  DaemonStatusOverlay,
  type DaemonStatusOverlayProps,
} from '@ccsm/ui';

import { PhaseSwitch, hostConfigForPhase } from '../src/App';
import { DaemonStateContext } from '../src/DaemonStateProvider';
import type { DaemonPhase, DaemonStatePayload } from '../src/types';

// --- module mocks --------------------------------------------------------

// Replace the heavy parts of @ccsm/ui with leaf stubs so the SPA tree can
// render without hitting the network. Keep DaemonStatusOverlay real because
// it is the indicator surface under test. RuntimeProvider is stubbed to
// expose `hostConfig` and `hostReady` as data attributes for assertions.
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
      hostConfig: { httpBase: string; getToken: () => string } | null;
      children: React.ReactNode;
    }) => (
      <div
        data-testid="runtime-provider"
        data-host-ready={hostConfig !== null ? 'true' : 'false'}
        data-http-base={hostConfig?.httpBase ?? ''}
        data-token={hostConfig?.getToken?.() ?? ''}
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
// component so tests that render any phase (which mounts AppContent →
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

describe('hostConfigForPhase (pure routing helper)', () => {
  it('returns a HostConfig with httpBase + getToken for phase=ready', () => {
    const phase: DaemonPhase = {
      phase: 'ready',
      port: 9876,
      token: 'tok-xyz',
      identity: null,
      tunnel: 'pending',
    };
    const cfg = hostConfigForPhase(phase);
    expect(cfg).not.toBeNull();
    expect(cfg?.httpBase).toBe('http://127.0.0.1:9876');
    expect(cfg?.getToken()).toBe('tok-xyz');
  });

  it.each([
    'notSpawned',
    'spawning',
    'starting',
  ] as const)('returns null for loading phase %s', (p) => {
    expect(
      hostConfigForPhase({ phase: p } as DaemonPhase),
    ).toBeNull();
  });

  it('returns null for spawnFailed / exited / authFailed / awaitingAuth', () => {
    expect(
      hostConfigForPhase({
        phase: 'spawnFailed',
        reason: 'x',
        retryInMs: null,
      }),
    ).toBeNull();
    expect(
      hostConfigForPhase({ phase: 'exited', code: 1, reason: 'r' }),
    ).toBeNull();
    expect(
      hostConfigForPhase({ phase: 'authFailed', reason: 'r' }),
    ).toBeNull();
    expect(
      hostConfigForPhase({
        phase: 'awaitingAuth',
        verificationUri: 'u',
        userCode: 'c',
        expiresAt: 0,
      }),
    ).toBeNull();
  });
});

describe('PhaseSwitch — SPA shell renders for every phase (Task #181 / R-57)', () => {
  // Loading-style phases — chip overlay + AppShell + Sidebar all visible.
  it.each([
    ['notSpawned', 'daemon: not started'],
    ['spawning', 'daemon: spawning'],
    ['starting', 'daemon: starting'],
  ] as const)(
    'renders AppShell + Sidebar + chip overlay for phase %s (no black screen, no full overlay)',
    (phaseName, label) => {
      renderWithPhase({ generation: 1, phase: phaseName });
      // R-57 architectural assertion: AppShell + Sidebar + MainPane MUST be
      // present even though the daemon is not yet Ready.
      expect(screen.getByTestId('terminal-pane')).toBeDefined();
      expect(screen.getByTestId('appshell-sidebar')).toBeDefined();
      expect(screen.getByTestId('appshell-main')).toBeDefined();
      expect(screen.getByTestId('stub-sidebar')).toBeDefined();
      expect(screen.getByTestId('stub-main')).toBeDefined();
      // RuntimeProvider mounts in "not-ready" mode (hostConfig === null).
      const rp = screen.getByTestId('runtime-provider');
      expect(rp.getAttribute('data-host-ready')).toBe('false');
      expect(rp.getAttribute('data-http-base')).toBe('');
      // Indicator overlay is rendered as a chip ON TOP of the shell.
      const overlay = screen.getByTestId('daemon-status-overlay');
      expect(overlay.getAttribute('data-phase')).toBe(phaseName);
      expect(overlay.getAttribute('data-variant')).toBe('info');
      expect(overlay.getAttribute('data-mode')).toBe('chip');
      expect(
        screen.getByTestId('daemon-status-overlay-loading').textContent ?? '',
      ).toContain(label);
    },
  );

  // R-50 regression guards stay — Ready + tunnel sub-state collapses the
  // overlay entirely, regardless of tunnel value.
  it('collapses overlay and mounts ready RuntimeProvider with tunnel=disconnected', () => {
    renderWithPhase({
      generation: 2,
      phase: 'ready',
      port: 9876,
      token: 't',
      identity: null,
      tunnel: 'disconnected',
    });
    expect(screen.queryByTestId('daemon-status-overlay')).toBeNull();
    const rp = screen.getByTestId('runtime-provider');
    expect(rp.getAttribute('data-host-ready')).toBe('true');
  });

  it('collapses overlay and mounts ready RuntimeProvider with tunnel=connected', () => {
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
    const rp = screen.getByTestId('runtime-provider');
    expect(rp.getAttribute('data-host-ready')).toBe('true');
  });

  // Failure phases — banner overlay AT TOP of the shell, sidebar still visible.
  it('renders banner overlay + AppShell for spawnFailed (user can still see sidebar)', () => {
    renderWithPhase({
      generation: 4,
      phase: 'spawnFailed',
      reason: 'binary not found on PATH',
      retryInMs: null,
    });
    // R-57: SPA shell stays mounted.
    expect(screen.getByTestId('terminal-pane')).toBeDefined();
    expect(screen.getByTestId('stub-sidebar')).toBeDefined();
    // hostConfig=null while daemon failed to spawn.
    expect(
      screen.getByTestId('runtime-provider').getAttribute('data-host-ready'),
    ).toBe('false');
    // Banner overlay surfaces the error on top.
    const overlay = screen.getByTestId('daemon-status-overlay');
    expect(overlay.getAttribute('data-mode')).toBe('banner');
    expect(overlay.getAttribute('data-variant')).toBe('error');
    expect(
      screen.getByTestId('daemon-status-overlay-detail').textContent ?? '',
    ).toContain('binary not found on PATH');
  });

  it('renders banner overlay + AppShell for exited phase', () => {
    renderWithPhase({
      generation: 5,
      phase: 'exited',
      code: 1,
      reason: 'daemon crashed',
    });
    expect(screen.getByTestId('terminal-pane')).toBeDefined();
    const overlay = screen.getByTestId('daemon-status-overlay');
    expect(overlay.getAttribute('data-mode')).toBe('banner');
    expect(overlay.getAttribute('data-variant')).toBe('error');
    expect(
      screen.getByTestId('daemon-status-overlay-banner').textContent ?? '',
    ).toContain('daemon crashed');
  });

  it('renders banner overlay + AppShell for authFailed', () => {
    renderWithPhase({
      generation: 6,
      phase: 'authFailed',
      reason: 'token rejected',
    });
    expect(screen.getByTestId('terminal-pane')).toBeDefined();
    const overlay = screen.getByTestId('daemon-status-overlay');
    expect(overlay.getAttribute('data-mode')).toBe('banner');
    expect(overlay.getAttribute('data-variant')).toBe('error');
    expect(
      screen.getByTestId('daemon-status-overlay-detail').textContent ?? '',
    ).toContain('token rejected');
  });

  // Awaiting auth — dialog (modal) overlay + shell still mounted under it.
  // The dialog is the ONE blocking surface by design (user must read user_code).
  it('renders dialog overlay + AppShell underneath for awaitingAuth', () => {
    renderWithPhase({
      generation: 7,
      phase: 'awaitingAuth',
      verificationUri: 'https://github.com/login/device',
      userCode: 'ABCD-1234',
      expiresAt: Date.now() + 600_000,
    });
    // Shell still rendered (the architectural fix), the dialog floats on top.
    expect(screen.getByTestId('terminal-pane')).toBeDefined();
    const overlay = screen.getByTestId('daemon-status-overlay');
    expect(overlay.getAttribute('data-mode')).toBe('dialog');
    expect(overlay.getAttribute('data-variant')).toBe('auth');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(
      screen.getByTestId('daemon-status-overlay-user-code').textContent ?? '',
    ).toContain('ABCD-1234');
  });

  // Ready — overlay collapses, RuntimeProvider wired to real port/token.
  it('mounts RuntimeProvider with real hostConfig + hides overlay on phase=ready', () => {
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
    expect(rp.getAttribute('data-host-ready')).toBe('true');
    expect(rp.getAttribute('data-http-base')).toBe('http://127.0.0.1:9876');
    expect(rp.getAttribute('data-token')).toBe('tok-xyz');
    expect(screen.getByTestId('terminal-pane')).toBeDefined();
  });

  // Recovery flow: re-render with a Ready payload after a SpawnFailed render.
  // Shell stays mounted throughout (no remount thrash).
  it('transitions from spawnFailed banner to Ready (shell persists, overlay collapses)', () => {
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
    expect(screen.getByTestId('terminal-pane')).toBeDefined();
    expect(
      screen
        .getByTestId('daemon-status-overlay')
        .getAttribute('data-mode'),
    ).toBe('banner');

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
    const rp = screen.getByTestId('runtime-provider');
    expect(rp.getAttribute('data-host-ready')).toBe('true');
    expect(rp.getAttribute('data-token')).toBe('tok2');
  });
});
