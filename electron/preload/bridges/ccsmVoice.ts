// `window.ccsmVoice` — speech-to-text bridge. The renderer captures mic
// audio (Web Audio), resamples to 16 kHz mono Float32 PCM, and hands it
// here; main runs smart-whisper and returns the transcript. One IPC hop
// each way. Mirrors the single-concern bridge pattern from #769.
import { contextBridge, ipcRenderer } from 'electron';

type VoiceResult =
  | { ok: true; text: string }
  | { ok: false; error: 'no-model' | 'transcribe-failed' | 'empty' };

const api = {
  transcribe: (pcm: Float32Array): Promise<VoiceResult> =>
    ipcRenderer.invoke('voice:transcribe', pcm),
};

export type CCSMVoiceAPI = typeof api;

export function installCcsmVoiceBridge(): void {
  contextBridge.exposeInMainWorld('ccsmVoice', api);
}
