import { spawn } from 'child_process';

export interface WhisperCliArgs {
  binPath: string;
  modelPath: string;
  wavPath: string;
  threads: number;
  // Whisper `-l` value: a language code (e.g. 'zh', 'en') to force decoding in
  // that language, or 'auto' to language-detect. Forcing 'zh' is what fixes
  // the large-v3-turbo Chinese-as-English misfire; 'auto' is the legacy
  // behaviour kept as a valid pass-through.
  language: string;
}

export interface WhisperCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runWhisperCli(args: WhisperCliArgs): Promise<WhisperCliResult> {
  const { binPath, modelPath, wavPath, threads, language } = args;
  return new Promise((resolve, reject) => {
    const child = spawn(
      binPath,
      [
        '-m', modelPath,
        '-f', wavPath,
        '-t', String(threads),
        '-l', language,
        '-bo', '1',
        '-bs', '1',
        '-np',
        '-nt',
      ],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
