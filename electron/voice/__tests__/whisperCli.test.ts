import { describe, it, expect, vi, beforeEach } from 'vitest';

// runWhisperCli spawns whisper-cli.exe via child_process.spawn. We mock spawn
// to (a) capture the argv it was invoked with and (b) hand back a minimal
// fake child whose stdout/stderr emit nothing and whose 'close' fires with 0.
// The assertion of interest: the `-l <language>` pair the app passes is exactly
// what reaches the binary — this is the contract that fixes the Chinese-as-
// English misfire (forcing `-l zh` instead of the old hardcoded `-l auto`).

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function fakeChild() {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  return {
    stdout: { on: (_e: string, _cb: (d: unknown) => void) => {} },
    stderr: { on: (_e: string, _cb: (d: unknown) => void) => {} },
    on: (event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = cb;
      // Resolve the promise on the next tick by firing 'close' with exit 0.
      if (event === 'close') queueMicrotask(() => cb(0));
    },
  };
}

async function runWith(language: string) {
  const { runWhisperCli } = await import('../whisperCli');
  spawnMock.mockReturnValueOnce(fakeChild());
  await runWhisperCli({
    binPath: '/bin/whisper-cli.exe',
    modelPath: '/models/ggml-large-v3-turbo.bin',
    wavPath: '/tmp/clip.wav',
    threads: 4,
    language,
  });
  // spawn(binPath, argvArray, opts)
  return spawnMock.mock.calls.at(-1)?.[1] as string[];
}

// Pull the value that immediately follows the `-l` flag in the argv.
function langFlagValue(argv: string[]): string | undefined {
  const i = argv.indexOf('-l');
  return i >= 0 ? argv[i + 1] : undefined;
}

describe('runWhisperCli language flag', () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
  });

  it('passes -l zh through to whisper-cli when language is "zh"', async () => {
    const argv = await runWith('zh');
    expect(argv).toContain('-l');
    expect(langFlagValue(argv)).toBe('zh');
  });

  it('passes -l en through when language is "en"', async () => {
    const argv = await runWith('en');
    expect(langFlagValue(argv)).toBe('en');
  });

  it('passes -l auto through unchanged (legacy auto-detect still valid)', async () => {
    const argv = await runWith('auto');
    expect(langFlagValue(argv)).toBe('auto');
  });

  it('always spawns the resolved binary with the model and wav paths', async () => {
    const argv = await runWith('zh');
    expect(spawnMock.mock.calls.at(-1)?.[0]).toBe('/bin/whisper-cli.exe');
    expect(argv).toContain('/models/ggml-large-v3-turbo.bin');
    expect(argv).toContain('/tmp/clip.wav');
  });
});
