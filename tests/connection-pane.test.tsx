import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import { useStore } from '../src/stores/store';
import { SettingsDialog } from '../src/components/SettingsDialog';

const initial = useStore.getState();

function resetStore() {
  useStore.setState({ ...initial, connection: null, models: [], modelsLoaded: false }, true);
}

beforeEach(() => {
  resetStore();
  (globalThis as { window: Window & typeof globalThis }).window.agentory = {
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
  } as unknown as Window['agentory'];
});

afterEach(() => {
  delete (window as { agentory?: unknown }).agentory;
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
    (window.agentory as { connection: { openSettingsFile: typeof openFile } }).connection.openSettingsFile =
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
});
