import { describe, it, expect, vi, beforeEach } from 'vitest';

// app.getAppPath / resourcesPath are read at module load via electron — mock it.
vi.mock('electron', () => ({
  app: { getAppPath: () => '/repo' },
}));

describe('resolveModelPath', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CCSM_FORCE_PACKAGED;
  });

  it('resolves the repo-local path in dev', async () => {
    const { resolveModelPath } = await import('../transcriber');
    // dev: process.resourcesPath points into electron's own dir, so we
    // fall back to the app path's resources/models.
    const p = resolveModelPath();
    expect(p.replace(/\\/g, '/')).toContain('resources/models/ggml-base.bin');
  });
});

describe('transcribe', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns no-model when the model file is missing', async () => {
    vi.doMock('fs', () => ({ existsSync: () => false }));
    const { transcribe } = await import('../transcriber');
    const result = await transcribe(new Float32Array(16000));
    expect(result).toEqual({ ok: false, error: 'no-model' });
  });

  it('returns joined text on success and frees the model', async () => {
    vi.doMock('fs', () => ({ existsSync: () => true }));
    const free = vi.fn().mockResolvedValue(undefined);
    vi.doMock('smart-whisper', () => ({
      Whisper: class {
        async transcribe() {
          return { result: Promise.resolve([{ text: 'Hello' }, { text: ' world' }]) };
        }
        free = free;
      },
    }));
    const { transcribe } = await import('../transcriber');
    const result = await transcribe(new Float32Array(16000));
    expect(result).toEqual({ ok: true, text: 'Hello world' });
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('returns transcribe-failed and still frees when whisper throws', async () => {
    vi.doMock('fs', () => ({ existsSync: () => true }));
    const free = vi.fn().mockResolvedValue(undefined);
    vi.doMock('smart-whisper', () => ({
      Whisper: class {
        async transcribe() {
          throw new Error('boom');
        }
        free = free;
      },
    }));
    const { transcribe } = await import('../transcriber');
    const result = await transcribe(new Float32Array(16000));
    expect(result).toEqual({ ok: false, error: 'transcribe-failed' });
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('returns empty when transcription yields no segments', async () => {
    vi.doMock('fs', () => ({ existsSync: () => true }));
    vi.doMock('smart-whisper', () => ({
      Whisper: class {
        async transcribe() {
          return { result: Promise.resolve([]) };
        }
        free = vi.fn().mockResolvedValue(undefined);
      },
    }));
    const { transcribe } = await import('../transcriber');
    const result = await transcribe(new Float32Array(16000));
    expect(result).toEqual({ ok: false, error: 'empty' });
  });
});
