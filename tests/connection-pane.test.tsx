import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import React from 'react';
import { useStore } from '../src/stores/store';
import { SettingsDialog } from '../src/components/SettingsDialog';

const initial = useStore.getState();

function resetStore() {
  useStore.setState({ ...initial, connection: null, models: [], modelsLoaded: false }, true);
}

function setClipboard(impl: { writeText: (s: string) => Promise<void> }) {
  Object.defineProperty(navigator, 'clipboard', {
    value: impl,
    configurable: true,
    writable: true
  });
}

beforeEach(() => {
  resetStore();
  (globalThis as { window: Window & typeof globalThis }).window.ccsm = {
    connection: {
      read: vi.fn(async () => ({
        baseUrl: 'https://api.example.com/v1',
        model: 'claude-opus-4-7',
        hasAuthToken: true,
      })),
      openSettingsFile: vi.fn(async () => ({ ok: true } as const)),
    },
    models: {
      list: vi.fn(async () => [
        { id: 'claude-opus-4-7', source: 'settings' as const },
        { id: 'claude-sonnet-4-6', source: 'cli-picker' as const },
      ]),
    },
  } as unknown as Window['ccsm'];
});

afterEach(() => {
  delete (window as { ccsm?: unknown }).ccsm;
});

describe('ConnectionPane', () => {
  it('renders base URL, model, auth state, and discovered model list from IPC', async () => {
    await act(async () => {
      render(<SettingsDialog open onOpenChange={() => {}} initialTab="connection" />);
    });

    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/v1')).toBeInTheDocument();
    });
    // 'claude-opus-4-7' renders both as the Default model and inside the
    // discovered list — both occurrences are expected.
    expect(screen.getAllByText('claude-opus-4-7').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Configured')).toBeInTheDocument();

    // Both discovered model ids should render in the list (queried via the
    // data attribute since they share text with the Default-model field).
    const list = document.querySelector('[data-connection-models]');
    expect(list).not.toBeNull();
    expect(list!.textContent).toContain('claude-opus-4-7');
    expect(list!.textContent).toContain('claude-sonnet-4-6');
  });

  it('renders an "Open settings.json" button that calls the IPC', async () => {
    const openFile = vi.fn(async () => ({ ok: true } as const));
    (window.ccsm as { connection: { openSettingsFile: typeof openFile } }).connection.openSettingsFile =
      openFile;

    await act(async () => {
      render(<SettingsDialog open onOpenChange={() => {}} initialTab="connection" />);
    });

    const btn = (await screen.findByRole('button', { name: /open settings\.json/i })) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    expect(openFile).toHaveBeenCalledTimes(1);
  });

  it('renders hover-revealed copy buttons that copy baseUrl and model to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });

    await act(async () => {
      render(<SettingsDialog open onOpenChange={() => {}} initialTab="connection" />);
    });

    const copyUrl = (await screen.findByRole('button', { name: /copy url/i })) as HTMLButtonElement;
    const copyModel = (await screen.findByRole('button', { name: /copy model/i })) as HTMLButtonElement;
    expect(copyUrl).toBeInTheDocument();
    expect(copyModel).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(copyUrl);
    });
    expect(writeText).toHaveBeenCalledWith('https://api.example.com/v1');

    // After a successful copy, the accessible label flips to "Copied" so
    // screen-reader users hear the new state.
    expect(screen.getAllByRole('button', { name: /^copied$/i }).length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      fireEvent.click(copyModel);
    });
    expect(writeText).toHaveBeenCalledWith('claude-opus-4-7');
  });

  it('does not crash when navigator.clipboard is undefined', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await act(async () => {
      render(<SettingsDialog open onOpenChange={() => {}} initialTab="connection" />);
    });

    const copyUrl = (await screen.findByRole('button', { name: /copy url/i })) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(copyUrl);
    });
    // Still the idle "Copy URL" — never flipped to "Copied" because nothing landed.
    expect(screen.getByRole('button', { name: /copy url/i })).toBeInTheDocument();
    warn.mockRestore();
  });
});
