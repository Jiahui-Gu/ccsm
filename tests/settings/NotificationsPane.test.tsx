import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import React from 'react';
import { NotificationsPane } from '../../src/components/settings/NotificationsPane';

// In-memory localStorage stand-in. Wave 0e cutover (#297) shifted the toggle
// from window.ccsm.{loadState,saveState} to direct localStorage, mirroring
// src/stores/persist.ts (#289) — same shape, same key.
function makeStorage(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    getItem: vi.fn((key: string) => (key in store ? store[key] : null)),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      for (const k of Object.keys(store)) delete store[k];
    }),
    key: vi.fn(),
    get length() {
      return Object.keys(store).length;
    },
    __store: store,
  } as unknown as Storage & { __store: Record<string, string>; setItem: ReturnType<typeof vi.fn> };
}

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  storage = makeStorage();
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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
    // Default is ON — empty store → toggle reads checked=true after hydrate.
    await waitFor(() => {
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('persists notifyEnabled=false when the user turns the toggle off', async () => {
    await act(async () => {
      render(<NotificationsPane />);
    });

    const toggle = await screen.findByRole('switch', {
      name: /show desktop notifications/i,
    });
    await waitFor(() => expect(toggle).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(storage.setItem).toHaveBeenCalledWith('notifyEnabled', 'false');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('reflects a persisted "false" row by hydrating to OFF', async () => {
    storage = makeStorage({ notifyEnabled: 'false' });
    Object.defineProperty(window, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    });

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
