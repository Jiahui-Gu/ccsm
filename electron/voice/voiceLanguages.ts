// Whisper transcription language catalog. Whisper.cpp's `-l` flag takes a
// language code (or the literal `auto` to language-detect). On the distilled
// large-v3-turbo model, `-l auto` frequently mis-detects short / noisy Chinese
// mic audio as English and returns English garbage (user report: "v3 turbo
// 识别不了中文"). Making the language an explicit, user-pickable preference
// fixes that — pinning `zh` forces Chinese decoding regardless of the
// detector. `auto` is preserved as a valid pass-through for users who switch
// languages mid-session.
//
// Kept deliberately tight (auto + the two languages this app's UI ships in)
// rather than enumerating whisper's ~99 codes — the value is solving the
// Chinese-vs-English misfire, not building a language picker.
//
// The renderer mirrors `VoiceLanguage` / `VOICE_LANGUAGES` structurally in
// src/global.d.ts (renderer can't import from electron/ — same convention as
// VoiceTier / VoiceResult).

export type VoiceLanguage = 'auto' | 'zh' | 'en';

export const VOICE_LANGUAGES: readonly VoiceLanguage[] = ['auto', 'zh', 'en'] as const;

export function isVoiceLanguage(x: unknown): x is VoiceLanguage {
  return typeof x === 'string' && (VOICE_LANGUAGES as readonly string[]).includes(x);
}

// Default by UI language: a Chinese UI strongly implies the user speaks
// Chinese, and `auto` is exactly the setting that misfires for them — so seed
// `zh`. Any other UI language keeps `auto` (whisper detects; English and most
// languages survive auto-detect fine on clean input).
export function defaultVoiceLanguage(uiLanguage: string | undefined): VoiceLanguage {
  return (uiLanguage ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'auto';
}
