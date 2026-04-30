// UT for src/components/ClaudeMissingGuide.tsx — full-screen guide shown
// when the `claude` CLI is not on PATH. Coverage:
//   * renders the install command verbatim (data-testid hook)
//   * recheck button is present and disabled while checking
//   * onResolved fires when ccsmPty.checkClaudeAvailable resolves with available=true
//   * onResolved is NOT called when checkClaudeAvailable returns available=false
//   * missing bridge (window.ccsmPty == undefined) does not throw and does not call onResolved
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ClaudeMissingGuide } from '../../src/components/ClaudeMissingGuide';

afterEach(() => {
  cleanup();
  // Restore window state between tests.
  delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
});

beforeEach(() => {
  delete (window as unknown as { ccsmPty?: unknown }).ccsmPty;
});

describe('<ClaudeMissingGuide />', () => {
  it('renders the npm install command verbatim', () => {
    render(<ClaudeMissingGuide onResolved={() => {}} />);
    const code = screen.getByTestId('claude-missing-install-command');
    expect(code.textContent).toBe('npm install -g @anthropic-ai/claude-code');
  });

  it('renders a recheck button', () => {
    render(<ClaudeMissingGuide onResolved={() => {}} />);
    expect(screen.getByTestId('claude-missing-recheck')).toBeInTheDocument();
  });

  it('clicking recheck without a bridge is a no-op (no throw)', async () => {
    const onResolved = vi.fn(function () {});
    render(<ClaudeMissingGuide onResolved={onResolved} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('claude-missing-recheck'));
    });
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('calls onResolved when checkClaudeAvailable resolves with available=true', async () => {
    const checkClaudeAvailable = vi.fn(function () {
      return Promise.resolve({ available: true, path: '/usr/bin/claude' });
    });
    (window as unknown as { ccsmPty: unknown }).ccsmPty = { checkClaudeAvailable };
    const onResolved = vi.fn(function () {});
    render(<ClaudeMissingGuide onResolved={onResolved} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('claude-missing-recheck'));
    });
    expect(checkClaudeAvailable).toHaveBeenCalledWith({ force: true });
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onResolved when checkClaudeAvailable returns available=false', async () => {
    const checkClaudeAvailable = vi.fn(function () {
      return Promise.resolve({ available: false });
    });
    (window as unknown as { ccsmPty: unknown }).ccsmPty = { checkClaudeAvailable };
    const onResolved = vi.fn(function () {});
    render(<ClaudeMissingGuide onResolved={onResolved} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('claude-missing-recheck'));
    });
    expect(checkClaudeAvailable).toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('button is disabled while a check is in-flight', async () => {
    let resolveCheck!: (v: { available: boolean }) => void;
    const checkClaudeAvailable = vi.fn(function () {
      return new Promise<{ available: boolean }>((resolve) => {
        resolveCheck = resolve;
      });
    });
    (window as unknown as { ccsmPty: unknown }).ccsmPty = { checkClaudeAvailable };
    render(<ClaudeMissingGuide onResolved={() => {}} />);

    const btn = screen.getByTestId('claude-missing-recheck') as HTMLButtonElement;
    fireEvent.click(btn);
    // While the promise hasn't resolved, the button stays disabled.
    expect(btn.disabled).toBe(true);

    await act(async () => {
      resolveCheck({ available: false });
      await Promise.resolve();
    });
    expect(btn.disabled).toBe(false);
  });
});
