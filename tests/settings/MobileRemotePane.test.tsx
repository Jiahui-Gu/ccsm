import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileRemoteStatus } from '../../src/global';
import { MobileRemotePane } from '../../src/components/settings/MobileRemotePane';
import { SettingsDialog } from '../../src/components/SettingsDialog';

function makeBridge(initialStatus: MobileRemoteStatus = { kind: 'ready', phoneConnected: false }) {
  let statusHandler: ((status: MobileRemoteStatus) => void) | undefined;
  const unsubscribe = vi.fn();
  const bridge = {
    getStatus: vi.fn(async () => initialStatus),
    getPairingUrl: vi.fn(async () => 'https://relay.workers.dev/#pair=room.secret'),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    rotate: vi.fn(async () => {}),
    onStatus: vi.fn((handler: (status: MobileRemoteStatus) => void) => {
      statusHandler = handler;
      return unsubscribe;
    })
  };
  return {
    bridge,
    unsubscribe,
    pushStatus(status: MobileRemoteStatus) {
      act(() => statusHandler?.(status));
    }
  };
}

let remote = makeBridge();

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
  remote = makeBridge();
  window.ccsmMobileRemote = remote.bridge;
});

afterEach(() => {
  cleanup();
  delete window.ccsmMobileRemote;
  vi.restoreAllMocks();
});

describe('MobileRemotePane', () => {
  it('shows a ready QR without configuration fields', async () => {
    render(<MobileRemotePane />);

    expect(await screen.findByLabelText('Phone pairing QR code')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Waiting for phone')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Worker URL/i)).not.toBeInTheDocument();
  });

  it('rotates only after destructive confirmation and fetches the replacement URL', async () => {
    render(<MobileRemotePane />);

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh QR code' }));
    expect(screen.getByRole('dialog', { name: 'Replace pairing?' })).toBeInTheDocument();
    expect(remote.bridge.rotate).not.toHaveBeenCalled();

    remote.bridge.getPairingUrl.mockResolvedValueOnce('https://relay.workers.dev/#pair=new.secret');
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));

    await waitFor(() => expect(remote.bridge.rotate).toHaveBeenCalledTimes(1));
    expect(remote.bridge.getPairingUrl).toHaveBeenCalledTimes(2);
  });

  it('renders connecting and phone-connected desktop/phone states', async () => {
    remote = makeBridge({ kind: 'connecting' });
    window.ccsmMobileRemote = remote.bridge;
    render(<MobileRemotePane />);

    expect(await screen.findByText('Connecting')).toBeInTheDocument();
    expect(screen.getByText('Desktop is connecting to the relay…')).toBeInTheDocument();
    expect(await screen.findByLabelText('Phone pairing QR code')).toBeInTheDocument();

    remote.pushStatus({ kind: 'ready', phoneConnected: true });
    expect(await screen.findByText('Phone connected')).toBeInTheDocument();
    expect(screen.getByText('Desktop connected')).toBeInTheDocument();
  });

  it('does not let a stale initial status overwrite a newer relay event', async () => {
    let resolveInitialStatus!: (status: MobileRemoteStatus) => void;
    remote.bridge.getStatus.mockImplementation(
      () =>
        new Promise<MobileRemoteStatus>((resolve) => {
          resolveInitialStatus = resolve;
        })
    );
    render(<MobileRemotePane />);
    await waitFor(() => expect(remote.bridge.onStatus).toHaveBeenCalledTimes(1));

    remote.pushStatus({ kind: 'ready', phoneConnected: false });
    expect(await screen.findByText('Ready')).toBeInTheDocument();

    resolveInitialStatus({ kind: 'connecting' });
    await act(async () => {});
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByLabelText('Phone pairing QR code')).toBeInTheDocument();
  });

  it('pauses and resumes from the status action', async () => {
    render(<MobileRemotePane />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause mobile remote' }));
    expect(remote.bridge.pause).toHaveBeenCalledTimes(1);

    remote.pushStatus({ kind: 'paused' });
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume mobile remote' }));
    expect(remote.bridge.resume).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'relay unavailable',
      status: { kind: 'unavailable', reason: 'relay-not-configured' } as const,
      label: 'Relay unavailable',
      detail:
        'The mobile relay is not configured in this build. Install the latest CCSM release, or set CCSM_MOBILE_REMOTE_RELAY_URL for development.'
    },
    {
      name: 'secure storage unavailable',
      status: { kind: 'unavailable', reason: 'secure-storage-unavailable' } as const,
      label: 'Secure storage unavailable',
      detail:
        'Pairing credentials cannot be protected on this device. Enable your operating system credential store and restart CCSM.'
    },
    {
      name: 'relay unreachable',
      status: { kind: 'error', reason: 'relay-unreachable' } as const,
      label: 'Connection error',
      detail: 'CCSM cannot reach the mobile relay. Check your network and try again.'
    },
    {
      name: 'protocol update required',
      status: { kind: 'error', reason: 'protocol-mismatch' } as const,
      label: 'Update required',
      detail: 'Update CCSM to use the current mobile relay protocol.'
    },
    {
      name: 'pairing authentication error',
      status: { kind: 'error', reason: 'authentication-failed' } as const,
      label: 'Pairing error',
      detail: 'Pairing authentication failed. Refresh the QR code and pair again.'
    }
  ])('renders the $name state', async ({ status, label, detail }) => {
    remote = makeBridge(status);
    window.ccsmMobileRemote = remote.bridge;
    render(<MobileRemotePane />);

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it('subscribes on mount, responds to status events, and unsubscribes on unmount', async () => {
    const { unmount } = render(<MobileRemotePane />);
    await screen.findByText('Ready');
    expect(remote.bridge.onStatus).toHaveBeenCalledTimes(1);

    remote.pushStatus({ kind: 'connecting' });
    expect(await screen.findByText('Connecting')).toBeInTheDocument();

    unmount();
    expect(remote.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('is available as a Settings tab', async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} initialTab="mobileRemote" />);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: 'Mobile remote' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(await within(dialog).findByText('Pair your phone')).toBeInTheDocument();
  });
});
