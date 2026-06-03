import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/repo', getPath: () => '/userData' },
}));

// transcribe() reads the current tier from prefs; pin it to 'base' so the
// model filename is deterministic.
vi.mock('../../prefs/voiceTier', () => ({
  loadVoiceTier: () => 'base',
}));

describe('resolveModelPath / resolveBinPath', () => {
  beforeEach(() => vi.resetModules());

  it('prefers the userData models dir for the requested tier', async () => {
    vi.doMock('fs', () => ({ existsSync: () => true }));
    const { resolveModelPath } = await import('../transcriber');
    expect(resolveModelPath('small').replace(/\\/g, '/')).toBe(
      '/userData/models/ggml-small.bin',
    );
  });

  it('falls back to the dev resources tree when userData/packaged are absent', async () => {
    vi.doMock('fs', () => ({ existsSync: () => false }));
    const { resolveModelPath } = await import('../transcriber');
    expect(resolveModelPath('base').replace(/\\/g, '/')).toContain(
      'resources/models/ggml-base.bin',
    );
  });

  it('resolves repo-local whisper-cli path in dev', async () => {
    vi.doMock('fs', () => ({ existsSync: () => false }));
    const { resolveBinPath } = await import('../transcriber');
    expect(resolveBinPath().replace(/\\/g, '/')).toContain(
      'resources/whisper-bin/whisper-cli.exe',
    );
  });
});

describe('transcribe', () => {
  beforeEach(() => vi.resetModules());

  function mockFs(opts: { modelExists: boolean; binExists: boolean }) {
    vi.doMock('fs', () => ({
      existsSync: (p: string) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.includes('ggml-base.bin')) return opts.modelExists;
        if (s.includes('whisper-cli.exe')) return opts.binExists;
        return false;
      },
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));
  }

  it('returns model-missing when the model file is absent', async () => {
    mockFs({ modelExists: false, binExists: true });
    const { transcribe } = await import('../transcriber');
    expect(await transcribe(new Float32Array(16000))).toEqual({
      ok: false,
      error: 'model-missing',
    });
  });

  it('returns bin-missing when the engine binary is absent', async () => {
    mockFs({ modelExists: true, binExists: false });
    const { transcribe } = await import('../transcriber');
    expect(await transcribe(new Float32Array(16000))).toEqual({
      ok: false,
      error: 'bin-missing',
    });
  });

  it('returns ok with trimmed text on success', async () => {
    mockFs({ modelExists: true, binExists: true });
    vi.doMock('../whisperCli', () => ({
      runWhisperCli: vi
        .fn()
        .mockResolvedValue({ code: 0, stdout: '  Hello world  \n', stderr: '' }),
    }));
    const { transcribe } = await import('../transcriber');
    expect(await transcribe(new Float32Array(16000))).toEqual({
      ok: true,
      text: 'Hello world',
    });
  });

  it('returns transcribe-failed on non-zero exit', async () => {
    mockFs({ modelExists: true, binExists: true });
    vi.doMock('../whisperCli', () => ({
      runWhisperCli: vi
        .fn()
        .mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' }),
    }));
    const { transcribe } = await import('../transcriber');
    expect(await transcribe(new Float32Array(16000))).toEqual({
      ok: false,
      error: 'transcribe-failed',
    });
  });

  it('returns empty when stdout is blank after trim', async () => {
    mockFs({ modelExists: true, binExists: true });
    vi.doMock('../whisperCli', () => ({
      runWhisperCli: vi
        .fn()
        .mockResolvedValue({ code: 0, stdout: '   \n', stderr: '' }),
    }));
    const { transcribe } = await import('../transcriber');
    expect(await transcribe(new Float32Array(16000))).toEqual({
      ok: false,
      error: 'empty',
    });
  });
});
