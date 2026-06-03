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
  const handlers = new Map<string, (e: unknown, pcm: unknown) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn((ch: string, h: (e: unknown, pcm: unknown) => Promise<unknown>) => {
      handlers.set(ch, h);
    }),
  };
  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
  });

  it('short-circuits invalid payloads with empty error and never calls transcribe', async () => {
    const transcribe = vi.fn();
    vi.doMock('../../voice/transcriber', () => ({ transcribe }));
    vi.doMock('../../voice/modelDownloader', () => ({
      isTierDownloaded: vi.fn(),
      downloadTier: vi.fn(),
      cancelDownload: vi.fn(),
    }));
    const { registerVoiceIpc } = await import('../voiceIpc');
    const { VOICE_CHANNELS } = await import('../../shared/ipcChannels');
    registerVoiceIpc({ ipcMain: ipcMain as never });
    const handler = handlers.get(VOICE_CHANNELS.transcribe)!;
    const res = await handler({}, new Float32Array(0));
    expect(res).toEqual({ ok: false, error: 'empty' });
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe('registerVoiceIpc — model-download handlers', () => {
  const handlers = new Map<string, (e: unknown, arg: unknown) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn((ch: string, h: (e: unknown, arg: unknown) => Promise<unknown>) => {
      handlers.set(ch, h);
    }),
  };

  const isTierDownloaded = vi.fn();
  const downloadTier = vi.fn();
  const cancelDownload = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    handlers.clear();
    isTierDownloaded.mockReset();
    downloadTier.mockReset();
    cancelDownload.mockReset();
    vi.doMock('../../voice/transcriber', () => ({ transcribe: vi.fn() }));
    vi.doMock('../../voice/modelDownloader', () => ({
      isTierDownloaded,
      downloadTier,
      cancelDownload,
    }));
    const { registerVoiceIpc } = await import('../voiceIpc');
    registerVoiceIpc({ ipcMain: ipcMain as never });
  });

  it('registers transcribe, isDownloaded, download, and cancel channels', async () => {
    const { VOICE_CHANNELS } = await import('../../shared/ipcChannels');
    expect(handlers.has(VOICE_CHANNELS.transcribe)).toBe(true);
    expect(handlers.has(VOICE_CHANNELS.isDownloaded)).toBe(true);
    expect(handlers.has(VOICE_CHANNELS.download)).toBe(true);
    expect(handlers.has(VOICE_CHANNELS.cancel)).toBe(true);
  });

  it('isDownloaded delegates valid tiers and rejects unknown ones without delegating', async () => {
    const { VOICE_CHANNELS } = await import('../../shared/ipcChannels');
    const h = handlers.get(VOICE_CHANNELS.isDownloaded)!;
    isTierDownloaded.mockReturnValue(true);
    expect(await h({}, 'base')).toBe(true);
    expect(isTierDownloaded).toHaveBeenCalledWith('base');
    expect(await h({}, 'bogus')).toBe(false);
    expect(isTierDownloaded).toHaveBeenCalledTimes(1);
  });

  it('download delegates valid tiers and returns null for unknown ones', async () => {
    const { VOICE_CHANNELS } = await import('../../shared/ipcChannels');
    const h = handlers.get(VOICE_CHANNELS.download)!;
    const ready = { kind: 'ready', tier: 'tiny' };
    downloadTier.mockResolvedValue(ready);
    expect(await h({}, 'tiny')).toBe(ready);
    expect(downloadTier).toHaveBeenCalledWith('tiny');
    expect(await h({}, 42)).toBeNull();
    expect(downloadTier).toHaveBeenCalledTimes(1);
  });

  it('cancel delegates valid tiers and ignores unknown ones', async () => {
    const { VOICE_CHANNELS } = await import('../../shared/ipcChannels');
    const h = handlers.get(VOICE_CHANNELS.cancel)!;
    await h({}, 'small');
    expect(cancelDownload).toHaveBeenCalledWith('small');
    await h({}, null);
    expect(cancelDownload).toHaveBeenCalledTimes(1);
  });
});
