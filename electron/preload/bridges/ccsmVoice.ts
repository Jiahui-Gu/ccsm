// `window.ccsmVoice` — speech-to-text bridge. The renderer captures mic
// audio (Web Audio), resamples to 16 kHz mono Float32 PCM, and hands it
// here; main runs whisper-cli and returns the transcript. Also exposes
// runtime model-download controls (models are not bundled; downloaded on
// demand into userData/models/). Mirrors the single-concern bridge pattern
// from #769.
import { contextBridge, ipcRenderer } from 'electron';
import { VOICE_CHANNELS } from '../../shared/ipcChannels';

type VoiceResult =
  | { ok: true; text: string }
  | { ok: false; error: 'model-missing' | 'bin-missing' | 'transcribe-failed' | 'empty' };

// Mirrors electron/voice/modelTiers.ts + modelDownloader.ts (renderer can't
// import from electron/). Keep in sync with src/global.d.ts.
type VoiceTier = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo';

type VoiceModelStatus =
  | { kind: 'idle'; tier: VoiceTier }
  | { kind: 'downloading'; tier: VoiceTier; transferred: number; total: number | null }
  | { kind: 'ready'; tier: VoiceTier }
  | { kind: 'error'; tier: VoiceTier; message: string };

const api = {
  transcribe: (pcm: Float32Array): Promise<VoiceResult> =>
    ipcRenderer.invoke(VOICE_CHANNELS.transcribe, pcm),
  isModelDownloaded: (tier: VoiceTier): Promise<boolean> =>
    ipcRenderer.invoke(VOICE_CHANNELS.isDownloaded, tier),
  downloadModel: (tier: VoiceTier): Promise<VoiceModelStatus | null> =>
    ipcRenderer.invoke(VOICE_CHANNELS.download, tier),
  cancelDownload: (tier: VoiceTier): Promise<void> =>
    ipcRenderer.invoke(VOICE_CHANNELS.cancel, tier),
  onModelStatus: (handler: (status: VoiceModelStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: VoiceModelStatus) => handler(status);
    ipcRenderer.on(VOICE_CHANNELS.status, listener);
    return () => ipcRenderer.removeListener(VOICE_CHANNELS.status, listener);
  },
};

export type CCSMVoiceAPI = typeof api;

export function installCcsmVoiceBridge(): void {
  contextBridge.exposeInMainWorld('ccsmVoice', api);
}
