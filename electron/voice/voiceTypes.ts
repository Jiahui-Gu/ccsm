// Result of a voice transcription, returned over the `voice:transcribe`
// IPC channel. Mirrored structurally in `src/global.d.ts` (the renderer
// can't import from electron/ — same convention as `UpdateStatus`).
export type VoiceResult =
  | { ok: true; text: string }
  | { ok: false; error: 'no-model' | 'transcribe-failed' | 'empty' | 'rejected' };
