import { app } from 'electron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { VoiceResult } from './voiceTypes';

// `base` transcribes dictation accurately at ~realtime on CPU; `small` was
// 3x slower for identical output on the prebuilt (non-vectorized) Windows
// whisper.cpp binary. See docs/superpowers/specs/2026-05-30-voice-input-design.md.
const MODEL_FILENAME = 'ggml-base.bin';

// In a packaged app the model lives under `process.resourcesPath`
// (electron-builder `extraResources`). In dev it lives in the repo at
// `resources/models/`. We prefer the packaged location when the file is
// actually there, else fall back to the app path.
export function resolveModelPath(): string {
  const packaged = path.join(
    process.resourcesPath ?? '',
    'models',
    MODEL_FILENAME,
  );
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'models', MODEL_FILENAME);
}

export async function transcribe(pcm: Float32Array): Promise<VoiceResult> {
  const modelPath = resolveModelPath();
  if (!fs.existsSync(modelPath)) return { ok: false, error: 'no-model' };
  const { Whisper } = await import('smart-whisper');
  const whisper = new Whisper(modelPath, { gpu: false });
  try {
    // Greedy sampling (not the library default beam search) plus most of the
    // available cores: roughly halves CPU latency with no accuracy loss for
    // short dictation clips.
    const task = await whisper.transcribe(pcm, {
      language: 'auto',
      strategy: 0,
      n_threads: Math.max(1, os.cpus().length - 2),
    });
    const segments = await task.result;
    const text = segments.map((s) => s.text).join('').trim();
    if (!text) return { ok: false, error: 'empty' };
    return { ok: true, text };
  } catch {
    return { ok: false, error: 'transcribe-failed' };
  } finally {
    try {
      await whisper.free();
    } catch {
      /* best-effort cleanup */
    }
  }
}
