import type {
  BrowserWindow,
  KeyboardInputEvent,
  MouseInputEvent,
  MouseWheelInputEvent,
} from 'electron';

import type {
  MirrorClientMessage,
  MirrorKey,
  MirrorServerMessage,
} from '../../src/shared/mobileRemote/mirrorMessages';

const MAX_EDGE = 1152;
const JPEG_QUALITY = 65;
const FRAME_INTERVAL_MS = 250;
const MAX_JPEG_BASE64_LENGTH = 700_000;

export type WindowMirror = {
  handle(message: MirrorClientMessage): void;
  stop(): void;
};

type WindowMirrorOptions = {
  getWindow(): BrowserWindow | null;
  send(message: MirrorServerMessage): void;
};

function scaledSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return { width, height };
  const scale = MAX_EDGE / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

type WindowInputEvent = MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent;

function keyInput(
  key: MirrorKey,
): Pick<KeyboardInputEvent, 'keyCode' | 'modifiers'> {
  if (key === 'Ctrl+C') return { keyCode: 'C', modifiers: ['control'] };
  return { keyCode: key };
}

export function createWindowMirror(options: WindowMirrorOptions): WindowMirror {
  let running = false;
  let capturing = false;
  let captureAgain = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastInputX: number | null = null;
  let lastInputY: number | null = null;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const scheduleCapture = (): void => {
    clearTimer();
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      requestCapture();
    }, FRAME_INTERVAL_MS);
    timer.unref?.();
  };

  const capture = async (): Promise<void> => {
    const currentGeneration = generation;
    const window = options.getWindow();
    if (!window || window.isDestroyed()) {
      options.send({ type: 'mirror.error', message: 'window_unavailable' });
      scheduleCapture();
      return;
    }
    capturing = true;
    try {
      const source = await window.capturePage();
      if (!running || currentGeneration !== generation) return;
      const sourceSize = source.getSize();
      const targetSize = scaledSize(sourceSize.width, sourceSize.height);
      const frame =
        targetSize.width === sourceSize.width && targetSize.height === sourceSize.height
          ? source
          : source.resize({ ...targetSize, quality: 'good' });
      const frameSize = frame.getSize();
      const jpegBase64 = frame.toJPEG(JPEG_QUALITY).toString('base64');
      if (jpegBase64.length > MAX_JPEG_BASE64_LENGTH) {
        options.send({ type: 'mirror.error', message: 'frame_too_large' });
      } else {
        options.send({
          type: 'mirror.frame',
          jpegBase64,
          width: frameSize.width,
          height: frameSize.height,
        });
      }
    } catch {
      if (running && currentGeneration === generation) {
        options.send({ type: 'mirror.error', message: 'capture_failed' });
      }
    } finally {
      capturing = false;
      if (running && (captureAgain || currentGeneration !== generation)) {
        captureAgain = false;
        requestCapture();
      } else if (running) {
        scheduleCapture();
      }
    }
  };

  function requestCapture(): void {
    if (!running) return;
    clearTimer();
    if (capturing) {
      captureAgain = true;
      return;
    }
    void capture();
  }

  const sendInput = (event: WindowInputEvent): void => {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.sendInputEvent(event);
  };

  const handleInput = (
    message: Exclude<MirrorClientMessage, { type: 'mirror.start' | 'mirror.stop' }>,
  ): void => {
    if (!running) return;
    const window = options.getWindow();
    if (!window || window.isDestroyed()) return;
    window.focus();
    if (message.type === 'mirror.tap') {
      const contentSize = window.getContentSize();
      const width = contentSize[0] ?? 0;
      const height = contentSize[1] ?? 0;
      const x = Math.min(Math.max(0, Math.round(message.x * width)), Math.max(0, width - 1));
      const y = Math.min(Math.max(0, Math.round(message.y * height)), Math.max(0, height - 1));
      lastInputX = x;
      lastInputY = y;
      sendInput({ type: 'mouseMove', x, y });
      sendInput({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
      sendInput({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
    } else if (message.type === 'mirror.text') {
      window.webContents.insertText(message.text);
    } else if (message.type === 'mirror.key') {
      const input = keyInput(message.key);
      sendInput({ type: 'keyDown', ...input });
      sendInput({ type: 'keyUp', ...input });
    } else {
      const contentSize = window.getContentSize();
      sendInput({
        type: 'mouseWheel',
        x: lastInputX ?? Math.round((contentSize[0] ?? 0) / 2),
        y: lastInputY ?? Math.round((contentSize[1] ?? 0) / 2),
        deltaX: 0,
        deltaY: -message.deltaY,
      });
    }
    requestCapture();
  };

  return {
    handle(message) {
      if (message.type === 'mirror.start') {
        if (running) return;
        running = true;
        generation += 1;
        requestCapture();
      } else if (message.type === 'mirror.stop') {
        this.stop();
      } else {
        handleInput(message);
      }
    },
    stop() {
      if (!running && !capturing) return;
      running = false;
      generation += 1;
      captureAgain = false;
      clearTimer();
    },
  };
}
