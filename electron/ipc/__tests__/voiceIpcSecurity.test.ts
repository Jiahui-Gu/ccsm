// Security gate around the `voice:transcribe` IPC handler.
//
// `transcribe` hands renderer-supplied PCM to an external transcription path.
// It is privileged, so it must confirm the message came from our top-level
// renderer frame before invoking the transcriber.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const transcribeMock = vi.fn(async () => ({ ok: true, text: 'hello' }));
vi.mock('../../voice/transcriber', () => ({
  transcribe: (pcm: Float32Array) => transcribeMock(pcm),
}));

// Mock the security guard. Default: accept; tests can flip to reject.
let allowGuard = true;
vi.mock('../../security/ipcGuards', () => ({
  fromMainFrame: (_e: unknown) => allowGuard,
}));

import { registerVoiceIpc } from '../voiceIpc';

type Handler = (e: unknown, ...args: unknown[]) => Promise<unknown>;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (ch: string, fn: Handler) => handlers.set(ch, fn),
    on: (ch: string, fn: Handler) => handlers.set(ch, fn),
  } as unknown as Electron.IpcMain;
  return { ipcMain, handlers };
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent;

describe('voice:transcribe security gate', () => {
  let transcribeHandler: Handler;

  beforeEach(() => {
    transcribeMock.mockClear();
    allowGuard = true;
    const { ipcMain, handlers } = fakeIpcMain();
    registerVoiceIpc({ ipcMain });
    transcribeHandler = handlers.get('voice:transcribe')!;
    expect(transcribeHandler).toBeDefined();
  });

  it('transcribes when the sender is the main frame', async () => {
    const pcm = new Float32Array([0.1, 0.2, 0.3]);
    const result = await transcribeHandler(fakeEvent, pcm);
    expect(transcribeMock).toHaveBeenCalledWith(pcm);
    expect(result).toEqual({ ok: true, text: 'hello' });
  });

  it('rejects without transcribing when the sender is not the main frame', async () => {
    allowGuard = false;
    const pcm = new Float32Array([0.1, 0.2, 0.3]);
    const result = await transcribeHandler(fakeEvent, pcm);
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: 'rejected' });
  });
});
