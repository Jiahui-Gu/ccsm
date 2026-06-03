// Result of a voice transcription, returned over the `voice:transcribe`
// IPC channel. Mirrored structurally in `src/global.d.ts` (the renderer
// can't import from electron/ — same convention as `UpdateStatus`).
//
// Error split (was a single ambiguous `no-model`):
//   model-missing     — selected tier not downloaded yet → guide to Settings
//   bin-missing       — whisper-cli.exe absent → broken install (not fixable
//                       by the user; ships with the package)
//   transcribe-failed — whisper-cli ran but errored (incl. corrupt model)
//   empty             — ran fine, produced no text
export type VoiceResult =
  | { ok: true; text: string }
  | { ok: false; error: 'model-missing' | 'bin-missing' | 'transcribe-failed' | 'empty' };

