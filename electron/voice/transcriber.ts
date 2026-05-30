import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { VoiceResult } from './voiceTypes';
import { runWhisperCli } from './whisperCli';
import { encodeWav } from './wavEncoder';

const MODEL_FILENAME = 'ggml-base.bin';
const BIN_FILENAME = 'whisper-cli.exe';

export function resolveModelPath(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'models', MODEL_FILENAME);
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'models', MODEL_FILENAME);
}

export function resolveBinPath(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'whisper-bin', BIN_FILENAME);
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'whisper-bin', BIN_FILENAME);
}

export async function transcribe(pcm: Float32Array): Promise<VoiceResult> {
  const modelPath = resolveModelPath();
  if (!fs.existsSync(modelPath)) return { ok: false, error: 'no-model' };
  const binPath = resolveBinPath();
  if (!fs.existsSync(binPath)) return { ok: false, error: 'no-model' };

  const wavPath = path.join(
    os.tmpdir(),
    `ccsm-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
  );
  try {
    fs.writeFileSync(wavPath, encodeWav(pcm, 16000));
    const threads = Math.max(1, os.cpus().length - 2);
    const { code, stdout, stderr } = await runWhisperCli({
      binPath,
      modelPath,
      wavPath,
      threads,
    });
    if (code !== 0) {
      console.error('[voice] whisper-cli failed:', stderr);
      return { ok: false, error: 'transcribe-failed' };
    }
    const text = stdout.trim();
    if (!text) return { ok: false, error: 'empty' };
    return { ok: true, text };
  } catch {
    return { ok: false, error: 'transcribe-failed' };
  } finally {
    try {
      fs.unlinkSync(wavPath);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}
