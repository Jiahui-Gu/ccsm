import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import React from 'react';
import { UpdatesPane } from '../../src/components/settings/UpdatesPane';

// In-memory shape of the renderer-side bridge for the updater. Exposes the
// minimum surface UpdatesPane mounts: version + status read, auto-check
// read/set, and an update-status push hook.
function makeUpdaterCcsm(opts?: {
  version?: string;
  initialStatus?: { kind: string };
  initialAutoCheck?: boolean;
}) {
  const checkSpy = vi.fn(async () => {});
  const downloadSpy = vi.fn(async () => {});
  const installSpy = vi.fn(async () => {});
  const setAutoSpy = vi.fn(async (v: boolean) => v);
  let pushCb: ((s: { kind: string }) => void) | null = null;
  return {
    api: {
      getVersion: vi.fn(async () => opts?.version ?? '1.2.3'),
      updatesStatus: vi.fn(async () => opts?.initialStatus ?? { kind: 'idle' }),
      updatesGetAutoCheck: vi.fn(async () => opts?.initialAutoCheck ?? true),
      updatesSetAutoCheck: setAutoSpy,
      updatesCheck: checkSpy,
      updatesDownload: downloadSpy,
      updatesInstall: installSpy,
      onUpdateStatus: (cb: (s: { kind: string }) => void) => {
        pushCb = cb;
        return () => {
          pushCb = null;
        };
      },
      // CrashReportingField now reads/writes localStorage directly (Wave 0e
      // cutover #298); these stubs are kept harmless for any future re-add.
      loadState: vi.fn(async () => undefined),
      saveState: vi.fn(async () => {}),
    } as unknown as Window['ccsm'],
    spies: { checkSpy, downloadSpy, installSpy, setAutoSpy },
    push: (s: { kind: string }) => pushCb?.(s),
  };
}

beforeEach(() => {
  const { api } = makeUpdaterCcsm();
  (window as { ccsm?: unknown }).ccsm = api;
});

afterEach(() => {
  delete (window as { ccsm?: unknown }).ccsm;
});

describe('UpdatesPane', () => {
  it('renders the running version returned by getVersion()', async () => {
    const { api } = makeUpdaterCcsm({ version: '4.2.0' });
    (window as { ccsm?: unknown }).ccsm = api;

    await act(async () => {
      render(<UpdatesPane />);
    });

    await waitFor(() => {
      expect(screen.getByText('4.2.0')).toBeInTheDocument();
    });
  });

  it('clicking "Check for updates" calls updatesCheck and flips status to checking', async () => {
    const { api, spies } = makeUpdaterCcsm();
    (window as { ccsm?: unknown }).ccsm = api;

    await act(async () => {
      render(<UpdatesPane />);
    });

    const btn = await screen.findByRole('button', { name: /check for updates/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(spies.checkSpy).toHaveBeenCalledTimes(1);
    // Status flipped to "Checking…" — UpdatesPane renders the "Checking…"
    // label both in the button and the status row.
    expect(screen.getAllByText(/checking/i).length).toBeGreaterThanOrEqual(1);
  });

  it('toggling automatic checks persists the new value via updatesSetAutoCheck', async () => {
    const { api, spies } = makeUpdaterCcsm({ initialAutoCheck: true });
    (window as { ccsm?: unknown }).ccsm = api;

    await act(async () => {
      render(<UpdatesPane />);
    });

    const toggle = await screen.findByRole('switch', {
      name: /check for updates automatically/i,
    });
    await waitFor(() => {
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(spies.setAutoSpy).toHaveBeenCalledWith(false);
  });
});
