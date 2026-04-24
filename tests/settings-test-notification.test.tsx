import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import { useStore } from '../src/stores/store';
import { SettingsDialog } from '../src/components/SettingsDialog';

const initial = useStore.getState();

function resetStore() {
  useStore.setState({ ...initial }, true);
}

beforeEach(() => {
  resetStore();
  (window as unknown as { ccsm: unknown }).ccsm = {
    notify: vi.fn(async () => true),
    loadState: vi.fn(async () => null),
    saveState: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  delete (window as { ccsm?: unknown }).ccsm;
});

describe('SettingsDialog notifications test-notification status (SD6)', () => {
  it('exposes the status text via role="status" + aria-live="polite" so screen readers announce it', async () => {
    await act(async () => {
      render(<SettingsDialog open onOpenChange={() => {}} initialTab="notifications" />);
    });

    // Live region must be present in the DOM before the click so the
    // assistive-tech reader registers it as a live area; otherwise nodes
    // that mount with the message are often missed.
    const live = screen.getByTestId('notifications-test-status');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live.textContent).toBe('');

    const btn = (await screen.findByRole('button', { name: /test notification/i })) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });

    await waitFor(() => {
      expect(live.textContent).toMatch(/sent\./i);
    });
    // Attributes must remain present after the status updates so the
    // announcement is delivered as a polite live-region update, not a
    // separate node insertion the screen reader could miss.
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('announces the failure message via the same live region when notify returns false', async () => {
    (window.ccsm as { notify: ReturnType<typeof vi.fn> }).notify = vi.fn(async () => false);

    await act(async () => {
      render(<SettingsDialog open onOpenChange={() => {}} initialTab="notifications" />);
    });

    const live = screen.getByTestId('notifications-test-status');
    const btn = (await screen.findByRole('button', { name: /test notification/i })) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });

    await waitFor(() => {
      expect(live.textContent).toMatch(/failed/i);
    });
    expect(live).toHaveAttribute('aria-live', 'polite');
  });
});
