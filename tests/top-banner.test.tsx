import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// startSessionAndReconcile reaches into the IPC layer; stub it so the
// AgentInitFailedBanner retry path doesn't try to spawn a real session.
vi.mock('../src/agent/startSession', () => ({
  startSessionAndReconcile: vi.fn(async () => undefined),
}));

import { TopBanner } from '../src/components/chrome/TopBanner';
import { AgentInitFailedBanner } from '../src/components/AgentInitFailedBanner';
import { AgentDiagnosticBanner } from '../src/components/AgentDiagnosticBanner';
import { ClaudeCliMissingBanner } from '../src/components/ClaudeCliMissingBanner';
import { useStore } from '../src/stores/store';

const initial = useStore.getState();

afterEach(() => {
  cleanup();
  // Reset every store slice we touched so tests stay independent.
  useStore.setState(initial, true);
});

describe('<TopBanner />', () => {
  it('renders title, body, actions, and dismiss with role="alert" + aria-live="polite"', () => {
    const onDismiss = vi.fn();
    const onAction = vi.fn();
    render(
      <TopBanner
        variant="error"
        title="Something went wrong"
        body="error code: EBADF"
        actions={
          <button type="button" onClick={onAction}>
            Retry
          </button>
        }
        onDismiss={onDismiss}
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).toHaveTextContent('error code: EBADF');

    // Outer wrapper carries the variant as a data attribute so probes /
    // CSS hooks can target it.
    const wrapper = document.querySelector('[data-top-banner]');
    expect(wrapper).toHaveAttribute('data-variant', 'error');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledTimes(1);

    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('omits the dismiss button when onDismiss is not supplied', () => {
    render(<TopBanner variant="info" title="Heads up" />);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('respects custom dismissLabel for screen readers', () => {
    render(
      <TopBanner
        variant="warning"
        title="Heads up"
        onDismiss={() => {}}
        dismissLabel="Dismiss diagnostic"
      />
    );
    expect(screen.getByRole('button', { name: 'Dismiss diagnostic' })).toBeInTheDocument();
  });
});

describe('banner trio integration', () => {
  beforeEach(() => {
    useStore.setState(initial, true);
  });

  it('AgentInitFailedBanner renders error variant with retry + reconfigure CTAs', () => {
    useStore.setState(
      {
        ...initial,
        activeId: 's1',
        sessionInitFailures: {
          s1: {
            error: 'spawn ENOENT',
            timestamp: Date.now(),
          },
        },
      },
      true
    );
    render(<AgentInitFailedBanner onRequestReconfigure={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(document.querySelector('[data-top-banner]')).toHaveAttribute('data-variant', 'error');
    expect(screen.getByText('Agent failed to start')).toBeInTheDocument();
    expect(screen.getByText('spawn ENOENT')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reconfigure/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('AgentDiagnosticBanner renders warning variant with custom dismiss label', () => {
    useStore.setState(
      {
        ...initial,
        activeId: 's1',
        diagnostics: [
          {
            id: 'd1',
            sessionId: 's1',
            level: 'warn',
            code: 'init.timeout',
            message: 'init handshake timed out',
            timestamp: Date.now(),
          },
        ],
      },
      true
    );
    render(<AgentDiagnosticBanner />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(document.querySelector('[data-top-banner]')).toHaveAttribute('data-variant', 'warning');
    expect(screen.getByText('Agent warning')).toBeInTheDocument();
    expect(screen.getByText('init handshake timed out')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss diagnostic' })).toBeInTheDocument();
  });

  it('AgentDiagnosticBanner renders error variant when level=error', () => {
    useStore.setState(
      {
        ...initial,
        activeId: 's1',
        diagnostics: [
          {
            id: 'd2',
            sessionId: 's1',
            level: 'error',
            code: 'init.crash',
            message: 'agent crashed mid-init',
            timestamp: Date.now(),
          },
        ],
      },
      true
    );
    render(<AgentDiagnosticBanner />);
    expect(document.querySelector('[data-top-banner]')).toHaveAttribute('data-variant', 'error');
    expect(screen.getByText('Agent error')).toBeInTheDocument();
  });

  it('ClaudeCliMissingBanner renders warning variant with set-up CTA and NO dismiss', () => {
    useStore.setState(
      {
        ...initial,
        cliStatus: {
          state: 'missing',
          searchedPaths: ['/usr/local/bin'],
          dialogOpen: false,
        },
      },
      true
    );
    render(<ClaudeCliMissingBanner />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(document.querySelector('[data-top-banner]')).toHaveAttribute('data-variant', 'warning');
    // Set-up CTA exists; dismiss button does NOT (banner is state-driven, not user-dismissible).
    expect(screen.getByRole('button', { name: /set up/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('ClaudeCliMissingBanner stays hidden when dialog is open', () => {
    useStore.setState(
      {
        ...initial,
        cliStatus: {
          state: 'missing',
          searchedPaths: [],
          dialogOpen: true,
        },
      },
      true
    );
    const { container } = render(<ClaudeCliMissingBanner />);
    expect(container.querySelector('[data-top-banner]')).toBeNull();
  });
});
