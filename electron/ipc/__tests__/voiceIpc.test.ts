import { describe, it, expect, vi, beforeEach } from 'vitest';

// voiceIpc imports transcriber, which reads electron's `app` at module
// load. Mock electron so the test doesn't pull in the real binary.
vi.mock('electron', () => ({
  app: { getAppPath: () => '/repo' },
}));

import { validateVoicePayload, MAX_PCM_SAMPLES } from '../voiceIpc';

describe('validateVoicePayload', () => {
  it('accepts a bounded Float32Array', () => {
    expect(validateVoicePayload(new Float32Array(16000))).toBe(true);
  });
  it('rejects non-Float32Array', () => {
    expect(validateVoicePayload([1, 2, 3])).toBe(false);
    expect(validateVoicePayload(new Int16Array(8))).toBe(false);
    expect(validateVoicePayload(null)).toBe(false);
  });
  it('rejects empty', () => {
    expect(validateVoicePayload(new Float32Array(0))).toBe(false);
  });
  it('rejects oversized (> ~10 min @ 16kHz)', () => {
    expect(validateVoicePayload(new Float32Array(MAX_PCM_SAMPLES + 1))).toBe(false);
  });
});

describe('registerVoiceIpc', () => {
  let handler: (e: unknown, pcm: unknown) => Promise<unknown>;
  const ipcMain = {
    handle: vi.fn((_ch: string, h: typeof handler) => {
      handler = h;
    }),
  };
  beforeEach(() => vi.resetModules());

  it('short-circuits invalid payloads with empty error and never calls transcribe', async () => {
    const transcribe = vi.fn();
    vi.doMock('../../voice/transcriber', () => ({ transcribe }));
    const { registerVoiceIpc } = await import('../voiceIpc');
    registerVoiceIpc({ ipcMain: ipcMain as never });
    const res = await handler({}, new Float32Array(0));
    expect(res).toEqual({ ok: false, error: 'empty' });
    expect(transcribe).not.toHaveBeenCalled();
  });
});
