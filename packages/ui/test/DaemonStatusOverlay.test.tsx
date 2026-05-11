// Task #137 / #112-T4: vitest + Testing Library coverage for the polished
// DaemonStatusOverlay. Each phase asserts the visible contract (text +
// testids + variant attribute + button onClick wiring).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

import { DaemonStatusOverlay } from '../src/components/DaemonStatusOverlay';

describe('DaemonStatusOverlay', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    cleanup();
    vi.useRealTimers();
  });

  // --- loading phases ------------------------------------------------------
  //
  // R-57 (Task #181): loading phases render as a non-blocking chip (bottom-
  // right pill) instead of the old full-screen overlay. The chip still
  // carries `daemon-status-overlay-loading` for backward-compat with the
  // existing assertion shape; the label text now reads "daemon: <phase>".

  it.each([
    ['notSpawned', 'daemon: not started'],
    ['spawning', 'daemon: spawning'],
    ['starting', 'daemon: starting'],
  ])('renders spinner + chip label for %s', (phaseName, label) => {
    render(<DaemonStatusOverlay phase={{ phase: phaseName }} />);
    const root = screen.getByTestId('daemon-status-overlay');
    expect(root.getAttribute('data-phase')).toBe(phaseName);
    expect(root.getAttribute('data-variant')).toBe('info');
    expect(root.getAttribute('data-mode')).toBe('chip');
    expect(screen.getByTestId('daemon-status-overlay-spinner')).toBeDefined();
    const loading = screen.getByTestId('daemon-status-overlay-loading');
    expect(loading.textContent ?? '').toContain(label);
    // Regression guard for the architectural fix: the chip must NOT cover
    // the viewport. We check the className surface; the actual rule lives
    // in styles.css (.daemon-overlay--chip → position: fixed; right + bottom).
    expect(root.className).toContain('daemon-overlay--chip');
    expect(root.className).not.toContain('daemon-overlay--dialog');
  });

  // --- R-50 (Task #164): Ready collapses regardless of tunnel sub-state ---

  it.each(['pending', 'connected', 'disconnected'] as const)(
    'returns null when phase=ready with tunnel=%s (overlay must not freeze SPA)',
    (tunnel) => {
      // Regression guard: previously a stderr-driven `tunnelConnected` emit
      // overwrote `Ready` and kept the overlay mounted on
      // "Tunnel connected, waiting…". Tunnel state is now a Ready sub-state;
      // the overlay must collapse for every tunnel value.
      const { container } = render(
        <DaemonStatusOverlay
          phase={{ phase: 'ready', tunnel } as { phase: string }}
        />,
      );
      expect(
        container.querySelector('[data-testid="daemon-status-overlay"]'),
      ).toBeNull();
      expect(container.firstChild).toBeNull();
      // And the deleted overlay text must never render under Ready.
      expect(container.textContent ?? '').not.toContain('Tunnel connected, waiting');
      expect(container.textContent ?? '').not.toContain('Starting daemon');
    },
  );

  // --- Ready collapses to null --------------------------------------------

  it('returns null when phase is ready (the real app takes over)', () => {
    const { container } = render(
      <DaemonStatusOverlay phase={{ phase: 'ready' }} />,
    );
    expect(container.querySelector('[data-testid="daemon-status-overlay"]')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  // --- spawnFailed --------------------------------------------------------

  it('renders error banner + reason for spawnFailed and logs on View logs click', () => {
    render(
      <DaemonStatusOverlay
        phase={{ phase: 'spawnFailed', reason: 'binary not found' }}
      />,
    );
    const root = screen.getByTestId('daemon-status-overlay');
    expect(root.getAttribute('data-variant')).toBe('error');
    const banner = screen.getByTestId('daemon-status-overlay-banner');
    expect(banner.textContent ?? '').toContain('Daemon failed to start');
    expect(
      screen.getByTestId('daemon-status-overlay-detail').textContent,
    ).toContain('binary not found');
    fireEvent.click(screen.getByTestId('daemon-status-overlay-view-logs'));
    expect(logSpy).toHaveBeenCalled();
    const firstArg = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(firstArg).toContain('view logs');
  });

  it('renders retry countdown when spawnFailed carries retryInMs', () => {
    vi.useFakeTimers();
    render(
      <DaemonStatusOverlay
        phase={{
          phase: 'spawnFailed',
          reason: 'crash',
          retryInMs: 5000,
        }}
      />,
    );
    const retry = screen.getByTestId('daemon-status-overlay-retry');
    expect(retry.textContent ?? '').toMatch(/Retrying in 5s/);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(
      screen.getByTestId('daemon-status-overlay-retry').textContent ?? '',
    ).toMatch(/Retrying in 3s/);
  });

  it('omits the retry countdown when spawnFailed has no retryInMs', () => {
    render(
      <DaemonStatusOverlay
        phase={{ phase: 'spawnFailed', reason: 'fatal' }}
      />,
    );
    expect(screen.queryByTestId('daemon-status-overlay-retry')).toBeNull();
  });

  // --- exited -------------------------------------------------------------

  it('renders exit code + reason for exited phase', () => {
    render(
      <DaemonStatusOverlay
        phase={{ phase: 'exited', code: 137, reason: 'killed' }}
      />,
    );
    const banner = screen.getByTestId('daemon-status-overlay-banner');
    expect(banner.textContent ?? '').toContain('Daemon exited');
    expect(banner.textContent ?? '').toContain('137');
    expect(banner.textContent ?? '').toContain('killed');
    fireEvent.click(screen.getByTestId('daemon-status-overlay-view-logs'));
    expect(logSpy).toHaveBeenCalled();
  });

  // --- awaitingAuth -------------------------------------------------------

  it('renders auth panel with verificationUri + userCode and logs on Open browser click', () => {
    render(
      <DaemonStatusOverlay
        phase={{
          phase: 'awaitingAuth',
          verificationUri: 'https://github.com/login/device',
          userCode: 'ABCD-1234',
        }}
      />,
    );
    const root = screen.getByTestId('daemon-status-overlay');
    expect(root.getAttribute('data-variant')).toBe('auth');
    expect(
      screen.getByTestId('daemon-status-overlay-uri').textContent,
    ).toContain('https://github.com/login/device');
    expect(
      screen.getByTestId('daemon-status-overlay-user-code').textContent,
    ).toContain('ABCD-1234');
    fireEvent.click(screen.getByTestId('daemon-status-overlay-open-browser'));
    expect(logSpy).toHaveBeenCalled();
    const firstArg = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(firstArg).toContain('open browser');
  });

  // --- authFailed ---------------------------------------------------------

  it('renders authFailed banner with Try again button that logs', () => {
    render(
      <DaemonStatusOverlay
        phase={{ phase: 'authFailed', reason: 'token rejected' }}
      />,
    );
    const root = screen.getByTestId('daemon-status-overlay');
    expect(root.getAttribute('data-variant')).toBe('error');
    expect(
      screen.getByTestId('daemon-status-overlay-banner').textContent,
    ).toContain('Sign-in failed');
    expect(
      screen.getByTestId('daemon-status-overlay-detail').textContent,
    ).toContain('token rejected');
    fireEvent.click(screen.getByTestId('daemon-status-overlay-try-again'));
    expect(logSpy).toHaveBeenCalled();
    const firstArg = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(firstArg).toContain('try again');
  });

  // --- variant override ---------------------------------------------------

  it('respects an explicit variant prop over the inferred default', () => {
    render(
      <DaemonStatusOverlay phase={{ phase: 'spawning' }} variant="error" />,
    );
    expect(
      screen.getByTestId('daemon-status-overlay').getAttribute('data-variant'),
    ).toBe('error');
  });

  // --- R-57 (Task #181) mode routing --------------------------------------
  //
  // The split is the architectural point of R-57: SPA shell must remain
  // visible regardless of phase, so the overlay component renders three
  // distinct, non-full-screen surfaces.

  it('routes loading phases to chip mode (non-blocking)', () => {
    render(<DaemonStatusOverlay phase={{ phase: 'spawning' }} />);
    const root = screen.getByTestId('daemon-status-overlay');
    expect(root.getAttribute('data-mode')).toBe('chip');
    // role=status is the screen-reader cue for non-modal status updates.
    expect(root.getAttribute('role')).toBe('status');
  });

  it('routes failure phases to banner mode (sticky top bar, not modal)', () => {
    render(
      <DaemonStatusOverlay phase={{ phase: 'spawnFailed', reason: 'x' }} />,
    );
    const root = screen.getByTestId('daemon-status-overlay');
    expect(root.getAttribute('data-mode')).toBe('banner');
    // Banner is NOT aria-modal — the user can keep interacting with the SPA
    // (e.g. sign in / inspect existing rows) while the daemon is down.
    expect(root.getAttribute('aria-modal')).toBeNull();
  });

  it('routes awaitingAuth to dialog mode (the one remaining blocking surface)', () => {
    render(
      <DaemonStatusOverlay
        phase={{
          phase: 'awaitingAuth',
          verificationUri: 'https://github.com/login/device',
          userCode: 'AB-CD',
        }}
      />,
    );
    const root = screen.getByTestId('daemon-status-overlay');
    expect(root.getAttribute('data-mode')).toBe('dialog');
    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-modal')).toBe('true');
  });

  it('allows shells to force a chip mode for a failure phase via the mode prop', () => {
    render(
      <DaemonStatusOverlay
        phase={{ phase: 'spawnFailed', reason: 'x' }}
        mode="chip"
      />,
    );
    expect(
      screen.getByTestId('daemon-status-overlay').getAttribute('data-mode'),
    ).toBe('chip');
  });

  // --- unknown phase fallback (defensive) ---------------------------------

  it('shows a fallback message for unknown phase strings instead of going blank', () => {
    render(<DaemonStatusOverlay phase={{ phase: 'mystery' }} />);
    expect(screen.getByTestId('daemon-status-overlay')).toBeDefined();
    expect(
      screen.getByTestId('daemon-status-overlay-loading').textContent ?? '',
    ).toContain('mystery');
  });
});
