import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// startSessionAndReconcile reaches into the IPC layer; stub it so the
// AgentInitFailedBanner retry path doesn't try to spawn a real session.
vi.mock('../src/agent/startSession', () => ({
  startSessionAndReconcile: vi.fn(async () => undefined),
}));

import { TopBanner, TopBannerAction } from '../src/components/chrome/TopBanner';
import { AgentInitFailedBanner } from '../src/components/AgentInitFailedBanner';
import { AgentDiagnosticBanner } from '../src/components/AgentDiagnosticBanner';
import { InstallerCorruptBanner } from '../src/components/InstallerCorruptBanner';
import { useStore } from '../src/stores/store';
import { usePreferences } from '../src/store/preferences';

const initial = useStore.getState();

afterEach(() => {
  cleanup();
  // Reset every store slice we touched so tests stay independent.
  useStore.setState(initial, true);
});

describe('<TopBanner />', () => {
  it('renders title, body, actions, and dismiss with role="alert" + aria-live="polite" for error variant', () => {
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

  it('uses role="status" (not "alert") for warning variant so screen readers do not over-announce', () => {
    render(<TopBanner variant="warning" title="Heads up" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Heads up');
    // Warning must NOT register as an assertive alert.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses role="status" (not "alert") for info variant so screen readers do not over-announce', () => {
    render(<TopBanner variant="info" title="FYI" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('FYI');
    expect(screen.queryByRole('alert')).toBeNull();
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

describe('<TopBannerAction />', () => {
  // The shared action button is the canonical surface for every banner CTA
  // (#273). These tests pin down the contract that previously lived as four
  // duplicated inline impls — every variant must keep the same focus halo
  // and forward-through behavior so the banners stay interchangeable.
  it('renders as type="button" with the focus halo applied for every tone', () => {
    const tones = ['primary', 'secondary', 'neutral', 'dismiss'] as const;
    for (const tone of tones) {
      cleanup();
      render(
        <TopBannerAction tone={tone} aria-label={`tone-${tone}`}>
          go
        </TopBannerAction>
      );
      const btn = screen.getByRole('button', { name: `tone-${tone}` });
      expect(btn).toHaveAttribute('type', 'button');
      // Focus halo class is the load-bearing piece that used to be
      // duplicated four times — assert it's still present on the rendered
      // node regardless of tone.
      expect(btn.className).toContain('focus-visible:shadow-');
    }
  });

  it('switches to a square icon-only footprint when shape="square"', () => {
    render(
      <TopBannerAction tone="dismiss" shape="square" aria-label="close">
        x
      </TopBannerAction>
    );
    const btn = screen.getByRole('button', { name: 'close' });
    // Square shape collapses width to match height (icon-only dismiss
    // button); pill shape would be `px-2.5` instead.
    expect(btn.className).toContain('h-7');
    expect(btn.className).toContain('w-7');
    expect(btn.className).not.toContain('px-2.5');
  });

  it('forwards onClick, disabled, and arbitrary data attributes to the underlying button', () => {
    const onClick = vi.fn();
    render(
      <TopBannerAction
        tone="primary"
        onClick={onClick}
        disabled
        data-test-action="retry"
      >
        Retry
      </TopBannerAction>
    );
    const btn = screen.getByRole('button', { name: 'Retry' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('data-test-action', 'retry');
    fireEvent.click(btn);
    // Disabled buttons swallow click events — the assertion proves the
    // disabled prop actually reached the DOM, not just the className.
    expect(onClick).not.toHaveBeenCalled();
  });

  it('fires onClick when enabled', () => {
    const onClick = vi.fn();
    render(
      <TopBannerAction tone="secondary" onClick={onClick}>
        Reconfigure
      </TopBannerAction>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reconfigure' }));
    expect(onClick).toHaveBeenCalledTimes(1);
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
    expect(screen.getByText('Failed to start Claude')).toBeInTheDocument();
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
    const alert = screen.getByRole('status');
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

  it('InstallerCorruptBanner renders error variant when installerCorrupt=true and stays hidden otherwise', () => {
    // Hidden by default.
    useStore.setState({ ...initial, installerCorrupt: false }, true);
    const r1 = render(<InstallerCorruptBanner />);
    expect(r1.container.querySelector('[data-top-banner]')).toBeNull();
    cleanup();

    // Shown when the agent layer reports CLAUDE_NOT_FOUND. No dismiss button —
    // banner is fully state-driven and disappears once the install is repaired.
    useStore.setState({ ...initial, installerCorrupt: true }, true);
    render(<InstallerCorruptBanner />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(document.querySelector('[data-top-banner]')).toHaveAttribute('data-variant', 'error');
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});

describe('banner trio i18n (zh locale)', () => {
  beforeEach(async () => {
    useStore.setState(initial, true);
    await act(async () => {
      usePreferences.getState().setLanguage('zh');
    });
  });

  afterEach(async () => {
    await act(async () => {
      usePreferences.getState().setLanguage('en');
    });
  });

  it('AgentInitFailedBanner renders Chinese title + CTAs when locale=zh', () => {
    useStore.setState(
      {
        ...initial,
        activeId: 's1',
        sessionInitFailures: {
          s1: { error: 'spawn ENOENT', timestamp: Date.now() },
        },
      },
      true
    );
    render(<AgentInitFailedBanner onRequestReconfigure={() => {}} />);
    expect(screen.getByText('无法启动 Claude')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新配置' })).toBeInTheDocument();
  });

  it('AgentDiagnosticBanner renders Chinese warning title + dismiss label when locale=zh', () => {
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
            message: '初始化握手超时',
            timestamp: Date.now(),
          },
        ],
      },
      true
    );
    render(<AgentDiagnosticBanner />);
    expect(screen.getByText('Agent 警告')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭诊断信息' })).toBeInTheDocument();
  });

  it('AgentDiagnosticBanner renders Chinese error title when level=error and locale=zh', () => {
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
            message: 'agent 在初始化阶段崩溃',
            timestamp: Date.now(),
          },
        ],
      },
      true
    );
    render(<AgentDiagnosticBanner />);
    expect(screen.getByText('Agent 错误')).toBeInTheDocument();
  });
});
