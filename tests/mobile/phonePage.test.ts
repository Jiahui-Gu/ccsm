import { fireEvent } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';

import { createPhonePage } from '../../src/mobile/phonePage';
import type { PhoneConnectionStatus, RelayClient } from '../../src/mobile/relayClient';
import type { MirrorServerMessage } from '../../src/shared/mobileRemote/mirrorMessages';

function fakeClient() {
  const messageHandlers = new Set<(message: MirrorServerMessage) => void>();
  const statusHandlers = new Set<(status: PhoneConnectionStatus) => void>();
  const client: RelayClient = {
    connect: vi.fn(),
    close: vi.fn(),
    send: vi.fn(async () => undefined),
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onStatus(handler) {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
  };
  return {
    client,
    emitMessage(message: MirrorServerMessage) {
      for (const handler of messageHandlers) handler(message);
    },
    emitStatus(status: PhoneConnectionStatus) {
      for (const handler of statusHandlers) handler(status);
    },
  };
}

describe('phone mirror page', () => {
  it('disables controls while disconnected and does not cache input', () => {
    const remote = fakeClient();
    const root = document.createElement('div');
    const dispose = createPhonePage(root, remote.client);
    const input = root.querySelector<HTMLInputElement>('#text-input')!;
    const controls = [...root.querySelectorAll<HTMLButtonElement>('[data-control]')];

    expect(input.disabled).toBe(true);
    expect(controls.every((control) => control.disabled)).toBe(true);
    fireEvent.input(input, { target: { value: 'stale' } });
    fireEvent.click(root.querySelector('#input-send')!);
    expect(remote.client.send).not.toHaveBeenCalled();

    remote.emitStatus('connected');
    expect(input.disabled).toBe(false);
    expect(remote.client.send).toHaveBeenCalledTimes(1);
    expect(remote.client.send).toHaveBeenLastCalledWith({ type: 'mirror.start' });

    remote.emitStatus('reconnecting');
    expect(input.disabled).toBe(true);
    remote.emitStatus('connected');
    expect(remote.client.send).toHaveBeenCalledTimes(2);
    expect(remote.client.send).toHaveBeenLastCalledWith({ type: 'mirror.start' });
    dispose();
  });

  it('sends text, key, and scroll controls when connected', () => {
    const remote = fakeClient();
    const root = document.createElement('div');
    const dispose = createPhonePage(root, remote.client);
    remote.emitStatus('connected');
    vi.mocked(remote.client.send).mockClear();
    const input = root.querySelector<HTMLInputElement>('#text-input')!;

    fireEvent.input(input, { target: { value: 'echo hello' } });
    fireEvent.submit(root.querySelector('#text-form')!);
    fireEvent.click(root.querySelector('[data-key="Enter"]')!);
    fireEvent.click(root.querySelector('[data-key="Ctrl+C"]')!);
    fireEvent.click(root.querySelector('[data-scroll="-360"]')!);

    expect(remote.client.send).toHaveBeenNthCalledWith(1, {
      type: 'mirror.text',
      text: 'echo hello',
    });
    expect(remote.client.send).toHaveBeenNthCalledWith(2, {
      type: 'mirror.key',
      key: 'Enter',
    });
    expect(remote.client.send).toHaveBeenNthCalledWith(3, {
      type: 'mirror.key',
      key: 'Ctrl+C',
    });
    expect(remote.client.send).toHaveBeenNthCalledWith(4, {
      type: 'mirror.scroll',
      deltaY: -360,
    });
    expect(input.value).toBe('');
    dispose();
  });

  it('renders JPEG frames in the mirror viewport', () => {
    const remote = fakeClient();
    const root = document.createElement('div');
    const dispose = createPhonePage(root, remote.client);

    remote.emitMessage({
      type: 'mirror.frame',
      jpegBase64: '/9j/4AAQ',
      width: 800,
      height: 600,
    });

    const frame = root.querySelector<HTMLImageElement>('#mirror-frame')!;
    expect(frame.src).toBe('data:image/jpeg;base64,/9j/4AAQ');
    expect(frame.width).toBe(800);
    expect(frame.height).toBe(600);
    dispose();
  });
});
