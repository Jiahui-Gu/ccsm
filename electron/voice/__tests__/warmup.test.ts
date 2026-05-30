import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/repo' },
}));

const MODEL = '/repo/resources/models/ggml-base.bin';
const BIN = '/repo/resources/whisper-bin/whisper-cli.exe';

function mockTranscriberPaths() {
  vi.doMock('../transcriber', () => ({
    resolveModelPath: () => MODEL,
    resolveBinPath: () => BIN,
  }));
}

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

describe('warmUpTranscriber', () => {
  beforeEach(() => vi.resetModules());

  it('runs one whisper-cli pass when model and binary both exist', async () => {
    mockTranscriberPaths();
    mockFs({ modelExists: true, binExists: true });
    const runWhisperCli = vi
      .fn()
      .mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    vi.doMock('../whisperCli', () => ({ runWhisperCli }));

    const { warmUpTranscriber } = await import('../warmup');
    await warmUpTranscriber();

    expect(runWhisperCli).toHaveBeenCalledTimes(1);
    const arg = runWhisperCli.mock.calls[0][0];
    expect(arg.modelPath).toBe(MODEL);
    expect(arg.binPath).toBe(BIN);
  });

  it('does not spawn whisper-cli when the model is missing', async () => {
    mockTranscriberPaths();
    mockFs({ modelExists: false, binExists: true });
    const runWhisperCli = vi.fn();
    vi.doMock('../whisperCli', () => ({ runWhisperCli }));

    const { warmUpTranscriber } = await import('../warmup');
    await expect(warmUpTranscriber()).resolves.toBeUndefined();
    expect(runWhisperCli).not.toHaveBeenCalled();
  });

  it('does not spawn whisper-cli when the binary is missing', async () => {
    mockTranscriberPaths();
    mockFs({ modelExists: true, binExists: false });
    const runWhisperCli = vi.fn();
    vi.doMock('../whisperCli', () => ({ runWhisperCli }));

    const { warmUpTranscriber } = await import('../warmup');
    await expect(warmUpTranscriber()).resolves.toBeUndefined();
    expect(runWhisperCli).not.toHaveBeenCalled();
  });

  it('resolves without throwing when whisper-cli rejects', async () => {
    mockTranscriberPaths();
    const unlinkSync = vi.fn();
    // Single fs mock that keeps existsSync truthy and captures unlinkSync.
    vi.doMock('fs', () => ({
      existsSync: () => true,
      writeFileSync: vi.fn(),
      unlinkSync,
    }));
    vi.doMock('../whisperCli', () => ({
      runWhisperCli: vi.fn().mockRejectedValue(new Error('spawn ENOENT')),
    }));

    const { warmUpTranscriber } = await import('../warmup');
    await expect(warmUpTranscriber()).resolves.toBeUndefined();
    expect(unlinkSync).toHaveBeenCalledTimes(1); // temp wav cleaned up in finally
  });
});
