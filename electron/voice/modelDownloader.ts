// Runtime whisper-model downloader. Models are NOT in the installer; this
// fetches the selected tier into the writable userData/models/ dir on demand.
//
// Integrity: the landed file size is checked against THIS response's
// Content-Length (catches truncated/dropped connections). We deliberately do
// NOT compare against a hardcoded size — HuggingFace re-uploads models on
// `main` and mirrors lag, so a fixed-byte gate would false-flag a good file.
// Corrupt-but-right-size content is caught later by whisper-cli failing to
// load (→ transcribe-failed). If a source omits Content-Length (some mirrors
// do), we accept any non-empty file.
//
// Sources: HuggingFace primary → hf-mirror.com fallback (HF is often
// unreachable from mainland China). No proxy is hardcoded — Node's fetch
// honors the user's HTTP(S)_PROXY env.

import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { VOICE_CHANNELS } from '../shared/ipcChannels';
import { buildDownloadUrls, tierFilename, type VoiceTier } from './modelTiers';

export type VoiceModelStatus =
  | { kind: 'idle'; tier: VoiceTier }
  | { kind: 'downloading'; tier: VoiceTier; transferred: number; total: number | null }
  | { kind: 'ready'; tier: VoiceTier }
  | { kind: 'error'; tier: VoiceTier; message: string };

const PROGRESS_THROTTLE_MS = 200;

// One in-flight download per tier; concurrent requests for the same tier
// share the Promise. Also used to drive cancellation.
const inFlight = new Map<VoiceTier, { promise: Promise<VoiceModelStatus>; controller: AbortController }>();

let lastStatus: VoiceModelStatus | null = null;

function modelsDir(): string {
  return path.join(app.getPath('userData'), 'models');
}

function modelPath(tier: VoiceTier): string {
  return path.join(modelsDir(), tierFilename(tier));
}

export function isTierDownloaded(tier: VoiceTier): boolean {
  try {
    return fs.statSync(modelPath(tier)).size > 0;
  } catch {
    return false;
  }
}

function sendAll(channel: string, payload: VoiceModelStatus): void {
  lastStatus = payload;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function broadcastStatus(payload: VoiceModelStatus): void {
  sendAll(VOICE_CHANNELS.status, payload);
}

export function getLastStatus(): VoiceModelStatus | null {
  return lastStatus;
}

export function cancelDownload(tier: VoiceTier): void {
  inFlight.get(tier)?.controller.abort();
}

async function downloadFromUrl(
  url: string,
  tier: VoiceTier,
  tmpPath: string,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`);
  }
  const lenHeader = res.headers.get('content-length');
  const total = lenHeader ? Number(lenHeader) : null;

  let transferred = 0;
  let lastEmit = 0;
  const sink = fs.createWriteStream(tmpPath);
  const meter = new Writable({
    write(chunk: Buffer, _enc, cb) {
      transferred += chunk.length;
      const now = Date.now();
      if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
        lastEmit = now;
        broadcastStatus({ kind: 'downloading', tier, transferred, total });
      }
      sink.write(chunk, (err) => cb(err ?? null));
    },
    final(cb) {
      sink.end(() => cb());
    },
  });

  // pipeline rejects (and aborts) on signal abort, propagating cleanup.
  await pipeline(res.body as unknown as NodeJS.ReadableStream, meter, { signal });

  // Integrity: landed size must match the response's declared length.
  const landed = fs.statSync(tmpPath).size;
  if (total != null && landed !== total) {
    throw new Error(`size mismatch: got ${landed}, expected ${total}`);
  }
  if (landed === 0) {
    throw new Error('empty download');
  }
}

async function run(tier: VoiceTier, controller: AbortController): Promise<VoiceModelStatus> {
  fs.mkdirSync(modelsDir(), { recursive: true });
  const dest = modelPath(tier);
  const tmpPath = `${dest}.download-${Math.random().toString(36).slice(2)}`;
  const urls = buildDownloadUrls(tier);

  broadcastStatus({ kind: 'downloading', tier, transferred: 0, total: null });

  let lastErr: unknown;
  try {
    for (const url of urls) {
      try {
        await downloadFromUrl(url, tier, tmpPath, controller.signal);
        fs.renameSync(tmpPath, dest); // atomic landing
        const ready: VoiceModelStatus = { kind: 'ready', tier };
        broadcastStatus(ready);
        return ready;
      } catch (err) {
        lastErr = err;
        // Clean the partial before trying the next source.
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* best-effort */
        }
        if (controller.signal.aborted) break; // don't fall through to mirror on cancel
      }
    }
    const message = controller.signal.aborted
      ? 'cancelled'
      : lastErr instanceof Error
        ? lastErr.message
        : 'download failed';
    const errStatus: VoiceModelStatus = { kind: 'error', tier, message };
    broadcastStatus(errStatus);
    return errStatus;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort: gone after rename or already cleaned */
    }
  }
}

export function downloadTier(tier: VoiceTier): Promise<VoiceModelStatus> {
  const existing = inFlight.get(tier);
  if (existing) return existing.promise;

  const controller = new AbortController();
  const promise = run(tier, controller).finally(() => {
    inFlight.delete(tier);
  });
  inFlight.set(tier, { promise, controller });
  return promise;
}
