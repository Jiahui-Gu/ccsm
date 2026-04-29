import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import React from 'react';
import { NotificationsPane } from '../../src/components/settings/NotificationsPane';

// Stand-in for the preload bridge. Holds an in-memory record of saved keys
// so the toggle's persistence path can be observed without a real DB.
function makeCcsm(initial: Record<string, string | undefined> = {}) {
  const store: Record<string, string | undefined> = { ...initial };
  return {
    loadState: vi.fn(async (key: string) => store[key]),
    saveState: vi.fn(async (key: string, val: string) => {
      store[key] = val;
    }),
    __store: store,
  };
}

beforeEach(() => {
  (window as { ccsm?: unknown }).ccsm = makeCcsm() as unknown as Window['ccsm'];
});

afterEach(() => {
  delete (window as { ccsm?: unknown }).ccsm;
});

describe('NotificationsPane', () => {
  it('renders the enable toggle with the i18n label and hydrates from storage', async () => {
    await act(async () => {
      render(<NotificationsPane />);
    });

    const toggle = await screen.findByRole('switch', {
      name: /show desktop notifications/i,
    });
    expect(toggle).toBeInTheDocument();
    // Default is ON — empty store row → toggle reads checked=true after hydrate.
    await waitFor(() => {
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('persists notifyEnabled=false when the user turns the toggle off', async () => {
    const ccsm = makeCcsm();
    (window as { ccsm?: unknown }).ccsm = ccsm as unknown as Window['ccsm'];

    await act(async () => {
      render(<NotificationsPane />);
    });

    const toggle = await screen.findByRole('switch', {
      name: /show desktop notifications/i,
    });
    // Wait for hydration so the click is enabled.
    await waitFor(() => expect(toggle).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(ccsm.saveState).toHaveBeenCalledWith('notifyEnabled', 'false');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('reflects a persisted "false" row by hydrating to OFF', async () => {
    (window as { ccsm?: unknown }).ccsm = makeCcsm({
      notifyEnabled: 'false',
    }) as unknown as Window['ccsm'];

    await act(async () => {
      render(<NotificationsPane />);
    });

    const toggle = await screen.findByRole('switch', {
      name: /show desktop notifications/i,
    });
    await waitFor(() => {
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });
  });
});
