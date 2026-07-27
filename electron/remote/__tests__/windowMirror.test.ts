import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWindowMirror } from '../windowMirror';

function image(width: number, height: number, bytes = Buffer.from('jpeg')) {
  const resized = {
    getSize: vi.fn(() => ({ width: 1152, height: 648 })),
    resize: vi.fn(),
    toJPEG: vi.fn(() => bytes),
  };
  const source = {
    getSize: vi.fn(() => ({ width, height })),
    resize: vi.fn(() => resized),
    toJPEG: vi.fn(() => bytes),
  };
  return { source, resized };
}

function fakeWindow(capturePage: () => Promise<unknown>) {
  return {
    isDestroyed: vi.fn(() => false),
    getContentSize: vi.fn(() => [1000, 500] as [number, number]),
    capturePage: vi.fn(capturePage),
    webContents: {
      insertText: vi.fn(),
      sendInputEvent: vi.fn(),
    },
  };
}

describe('window mirror', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('captures a resized JPEG immediately and every 250ms', async () => {
    const frame = image(1600, 900);
    const window = fakeWindow(async () => frame.source);
    const send = vi.fn();
    const mirror = createWindowMirror({
      getWindow: () => window as never,
      send,
    });

    mirror.handle({ type: 'mirror.start' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    expect(frame.source.resize).toHaveBeenCalledWith({
      width: 1152,
      height: 648,
      quality: 'good',
    });
    expect(frame.resized.toJPEG).toHaveBeenCalledWith(65);
    expect(send).toHaveBeenLastCalledWith({
      type: 'mirror.frame',
      jpegBase64: Buffer.from('jpeg').toString('base64'),
      width: 1152,
      height: 648,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(window.capturePage).toHaveBeenCalledTimes(2);
    mirror.stop();
  });

  it('keeps capture single-flight and requests one fresh frame after input', async () => {
    const frame = image(800, 600);
    let resolveCapture: ((value: unknown) => void) | undefined;
    const window = fakeWindow(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const mirror = createWindowMirror({
      getWindow: () => window as never,
      send: vi.fn(),
    });

    mirror.handle({ type: 'mirror.start' });
    mirror.handle({ type: 'mirror.text', text: 'hello' });
    mirror.handle({ type: 'mirror.key', key: 'Enter' });
    expect(window.capturePage).toHaveBeenCalledTimes(1);

    resolveCapture!(frame.source);
    await vi.waitFor(() => expect(window.capturePage).toHaveBeenCalledTimes(2));
    mirror.stop();
  });

  it('maps tap, text, keys, and scroll to BrowserWindow input', () => {
    const frame = image(800, 600);
    const window = fakeWindow(async () => frame.source);
    const mirror = createWindowMirror({
      getWindow: () => window as never,
      send: vi.fn(),
    });

    mirror.handle({ type: 'mirror.tap', x: 0.25, y: 0.5 });
    mirror.handle({ type: 'mirror.text', text: 'hello' });
    mirror.handle({ type: 'mirror.key', key: 'Ctrl+C' });
    mirror.handle({ type: 'mirror.scroll', deltaY: -240 });

    expect(window.webContents.insertText).toHaveBeenCalledWith('hello');
    expect(window.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: 'mouseMove', x: 250, y: 250 }],
      [{ type: 'mouseDown', button: 'left', clickCount: 1, x: 250, y: 250 }],
      [{ type: 'mouseUp', button: 'left', clickCount: 1, x: 250, y: 250 }],
      [{ type: 'keyDown', keyCode: 'C', modifiers: ['control'] }],
      [{ type: 'keyUp', keyCode: 'C', modifiers: ['control'] }],
      [{ type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: -240 }],
    ]);
  });

  it('drops oversized frames and sends a small error', async () => {
    const frame = image(800, 600, Buffer.alloc(525_001));
    const send = vi.fn();
    const mirror = createWindowMirror({
      getWindow: () => fakeWindow(async () => frame.source) as never,
      send,
    });

    mirror.handle({ type: 'mirror.start' });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'mirror.error',
        message: 'frame_too_large',
      }),
    );
    expect(send.mock.calls.some(([message]) => message.type === 'mirror.frame')).toBe(false);
    mirror.stop();
  });

  it('does not emit a pending frame after stop', async () => {
    const frame = image(800, 600);
    let resolveCapture: ((value: unknown) => void) | undefined;
    const send = vi.fn();
    const window = fakeWindow(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const mirror = createWindowMirror({
      getWindow: () => window as never,
      send,
    });

    mirror.handle({ type: 'mirror.start' });
    mirror.stop();
    resolveCapture!(frame.source);
    await Promise.resolve();
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
