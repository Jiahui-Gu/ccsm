// Selected whisper transcription language preference. Mirrors the
// voiceTier.ts pattern: persisted in app_state under `voiceLanguage`, cached
// in main-process memory, invalidated via the stateSavedBus when the
// renderer's Settings pane writes a new value (db:save) — no restart needed.
//
// Default is locale-derived (`zh` on a Chinese UI, else `auto`) via
// defaultVoiceLanguage(getMainLanguage()). An unknown/corrupt stored value
// also falls back to that locale default through isVoiceLanguage validation.
// The locale default exists because `-l auto` mis-detects Chinese mic audio as
// English on large-v3-turbo (user report); a Chinese UI user gets `zh` by
// default so transcription works out of the box.

import { loadState } from '../db';
import { getMainLanguage } from '../i18n';
import { onStateSaved } from '../shared/stateSavedBus';
import { defaultVoiceLanguage, isVoiceLanguage, type VoiceLanguage } from '../voice/voiceLanguages';

export const VOICE_LANGUAGE_KEY = 'voiceLanguage';

let _voiceLanguageCached: VoiceLanguage | undefined;

export function loadVoiceLanguage(): VoiceLanguage {
  if (_voiceLanguageCached !== undefined) return _voiceLanguageCached;
  const fallback = defaultVoiceLanguage(getMainLanguage());
  try {
    const raw = loadState(VOICE_LANGUAGE_KEY);
    const value = isVoiceLanguage(raw) ? raw : fallback;
    _voiceLanguageCached = value;
    return value;
  } catch {
    return fallback;
  }
}

export function invalidateVoiceLanguageCache(): void {
  _voiceLanguageCached = undefined;
}

/** Wire cache invalidation to the stateSavedBus. Call once during boot
 *  (before `registerDbIpc`). Returns the unsubscribe handle. */
export function subscribeVoiceLanguageInvalidation(): () => void {
  return onStateSaved((key) => {
    if (key === VOICE_LANGUAGE_KEY) invalidateVoiceLanguageCache();
  });
}
