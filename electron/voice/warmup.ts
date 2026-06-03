import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { resolveModelPath, resolveBinPath } from './transcriber';
import { runWhisperCli } from './whisperCli';
import { encodeWav } from './wavEncoder';
import { loadVoiceTier } from '../prefs/voiceTier';

// Best-effort, fire-and-forget warmup. Runs once after app start to fault the
// whisper exe/DLLs (~52 MB) and model (148 MB) into the OS page cache, so the
// user's FIRST real transcription is as fast as subsequent ones. The slow part
// of a cold call is the page-cache miss, not process spawn — a single dummy run
// pre-reads exactly those pages. Silent: any failure here must never surface to
// the user or block startup; the real transcribe() path handles its own errors.
export async function warmUpTranscriber(): Promise<void> {
  const modelPath = resolveModelPath(loadVoiceTier());
  const binPath = resolveBinPath();
  if (!fs.existsSync(modelPath) || !fs.existsSync(binPath)) return;

  const pcm = new Float32Array(1600); // 0.1 s of silence at 16 kHz mono
  const wavPath = path.join(
    os.tmpdir(),
    `ccsm-voice-warmup-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
  );
  try {
    fs.writeFileSync(wavPath, encodeWav(pcm, 16000));
    const threads = Math.max(1, os.cpus().length - 2);
    await runWhisperCli({ binPath, modelPath, wavPath, threads });
  } catch {
    /* best-effort: warmup failure is never user-visible */
  } finally {
    try {
      fs.unlinkSync(wavPath);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}
