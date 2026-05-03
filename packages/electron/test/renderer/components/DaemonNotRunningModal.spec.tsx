// T6.8 — DaemonNotRunningModal component tests.
//
// @vitest-environment happy-dom
//
// Spec ref: chapter 08 §6.1.

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DaemonNotRunningModal,
  detectPlatform,
  type DaemonModalPlatform,
} from '../../../src/renderer/components/DaemonNotRunningModal.js';

afterEach(() => cleanup());

describe('DaemonNotRunningModal — render gating', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <DaemonNotRunningModal
        open={false}
        onRetry={() => undefined}
        platform="linux"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a real <dialog open> when open=true (blocking modal, not a banner)', () => {
    render(
      <DaemonNotRunningModal
        open={true}
        onRetry={() => undefined}
        platform="linux"
      />,
    );
    const modal = screen.getByTestId('daemon-not-running-modal');
    expect(modal.tagName).toBe('DIALOG');
    expect(modal.hasAttribute('open')).toBe(true);
    expect(modal.getAttribute('role')).toBe('alertdialog');
  });
});

describe('DaemonNotRunningModal — copy is user-facing (no internals leak)', () => {
  it('uses the spec-locked status text and 8-second figure', () => {
    render(
      <DaemonNotRunningModal
        open={true}
        onRetry={() => undefined}
        platform="linux"
      />,
    );
    expect(screen.getByText('ccsm daemon is not running.')).toBeTruthy();
    expect(
      screen.getByText(/did not respond after 8 seconds/i),
    ).toBeTruthy();
  });

  it('does NOT mention internals (UDS, boot_id, Hello, descriptor, RPC)', () => {
    const { container } = render(
      <DaemonNotRunningModal
        open={true}
        onRetry={() => undefined}
        platform="linux"
      />,
    );
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/UDS/i);
    expect(text).not.toMatch(/boot[_ ]?id/i);
    expect(text).not.toMatch(/\bHello\b/);
    expect(text).not.toMatch(/descriptor/i);
    expect(text).not.toMatch(/\bRPC\b/);
  });
});

describe('DaemonNotRunningModal — per-OS troubleshooting hint', () => {
  const cases: ReadonlyArray<{
    platform: DaemonModalPlatform;
    expectLabel: string;
    expectCommand: string;
  }> = [
    {
      platform: 'darwin',
      expectLabel: 'macOS',
      expectCommand: 'launchctl print system/com.ccsm.daemon',
    },
    {
      platform: 'linux',
      expectLabel: 'Linux',
      expectCommand: 'systemctl status ccsm',
    },
    {
      platform: 'win32',
      expectLabel: 'Windows',
      expectCommand: 'Get-Service ccsm',
    },
  ];

  for (const c of cases) {
    it(`renders ${c.platform} hint with command "${c.expectCommand}"`, () => {
      render(
        <DaemonNotRunningModal
          open={true}
          onRetry={() => undefined}
          platform={c.platform}
        />,
      );
      const section = screen.getByTestId('daemon-modal-troubleshooting');
      expect(section.textContent ?? '').toContain(c.expectLabel);
      const cmd = screen.getByTestId('daemon-modal-command');
      expect(cmd.textContent).toBe(c.expectCommand);
    });
  }

  it('renders a generic hint with no command for unknown platforms', () => {
    render(
      <DaemonNotRunningModal
        open={true}
        onRetry={() => undefined}
        platform="other"
      />,
    );
    expect(screen.queryByTestId('daemon-modal-command')).toBeNull();
    const section = screen.getByTestId('daemon-modal-troubleshooting');
    expect(section.textContent ?? '').toMatch(/ccsm background service/i);
  });
});

describe('DaemonNotRunningModal — retry wiring', () => {
  it('invokes onRetry when the "Try again" button is clicked', () => {
    const onRetry = vi.fn();
    render(
      <DaemonNotRunningModal
        open={true}
        onRetry={onRetry}
        platform="linux"
      />,
    );
    fireEvent.click(screen.getByTestId('daemon-modal-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables the retry button when retryDisabled=true', () => {
    const onRetry = vi.fn();
    render(
      <DaemonNotRunningModal
        open={true}
        onRetry={onRetry}
        platform="linux"
        retryDisabled
      />,
    );
    const button = screen.getByTestId('daemon-modal-retry') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe('DaemonNotRunningModal — Esc / cancel is suppressed (cannot dismiss)', () => {
  it('preventDefaults the native dialog "cancel" event', () => {
    render(
      <DaemonNotRunningModal
        open={true}
        onRetry={() => undefined}
        platform="linux"
      />,
    );
    const dialog = screen.getByTestId('daemon-not-running-modal') as HTMLDialogElement;
    const event = new Event('cancel', { cancelable: true });
    const dispatched = dialog.dispatchEvent(event);
    // dispatchEvent returns false iff a listener called preventDefault.
    expect(dispatched).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('detectPlatform', () => {
  it('returns one of the supported strings (smoke test)', () => {
    const p = detectPlatform();
    expect(['darwin', 'linux', 'win32', 'other']).toContain(p);
  });
});
