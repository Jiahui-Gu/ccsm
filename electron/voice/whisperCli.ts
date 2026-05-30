import { spawn } from 'child_process';

export interface WhisperCliArgs {
  binPath: string;
  modelPath: string;
  wavPath: string;
  threads: number;
}

export interface WhisperCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runWhisperCli(args: WhisperCliArgs): Promise<WhisperCliResult> {
  const { binPath, modelPath, wavPath, threads } = args;
  return new Promise((resolve, reject) => {
    const child = spawn(
      binPath,
      [
        '-m', modelPath,
        '-f', wavPath,
        '-t', String(threads),
        '-l', 'auto',
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
