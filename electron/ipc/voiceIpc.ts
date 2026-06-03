import type { IpcMain } from 'electron';
import { transcribe } from '../voice/transcriber';
import type { VoiceResult } from '../voice/voiceTypes';
import { VOICE_CHANNELS } from '../shared/ipcChannels';
import { isVoiceTier } from '../voice/modelTiers';
import {
  isTierDownloaded,
  downloadTier,
  cancelDownload,
  type VoiceModelStatus,
} from '../voice/modelDownloader';

// 10 minutes of 16 kHz mono audio. IPC payloads are untrusted by
// convention; cap the buffer so a hostile/buggy renderer can't OOM main
// by handing us an enormous Float32Array.
export const MAX_PCM_SAMPLES = 16000 * 60 * 10;

export function validateVoicePayload(pcm: unknown): pcm is Float32Array {
  return pcm instanceof Float32Array && pcm.length > 0 && pcm.length <= MAX_PCM_SAMPLES;
}

export interface VoiceIpcDeps {
  ipcMain: IpcMain;
}

export function registerVoiceIpc(deps: VoiceIpcDeps): void {
  const { ipcMain } = deps;

  ipcMain.handle(VOICE_CHANNELS.transcribe, async (_e, pcm: unknown): Promise<VoiceResult> => {
    if (!validateVoicePayload(pcm)) return { ok: false, error: 'empty' };
    return transcribe(pcm);
  });

  ipcMain.handle(VOICE_CHANNELS.isDownloaded, async (_e, tier: unknown): Promise<boolean> => {
    if (!isVoiceTier(tier)) return false;
    return isTierDownloaded(tier);
  });

  ipcMain.handle(VOICE_CHANNELS.download, async (_e, tier: unknown): Promise<VoiceModelStatus | null> => {
    if (!isVoiceTier(tier)) return null;
    return downloadTier(tier);
  });

  ipcMain.handle(VOICE_CHANNELS.cancel, async (_e, tier: unknown): Promise<void> => {
    if (isVoiceTier(tier)) cancelDownload(tier);
  });
}
