// Selected whisper model tier preference. Mirrors the notifyEnabled.ts
// pattern (Task #730 Phase A1): persisted in app_state under `voiceTier`,
// cached in main-process memory, invalidated via the stateSavedBus when the
// renderer's Settings pane writes a new value (db:save) — no restart needed.
//
// Default `base`. An unknown/corrupt stored value falls back to the default
// via isVoiceTier validation.

import { loadState } from '../db';
import { onStateSaved } from '../shared/stateSavedBus';
import { DEFAULT_TIER, isVoiceTier, type VoiceTier } from '../voice/modelTiers';

export const VOICE_TIER_KEY = 'voiceTier';

let _voiceTierCached: VoiceTier | undefined;

export function loadVoiceTier(): VoiceTier {
  if (_voiceTierCached !== undefined) return _voiceTierCached;
  try {
    const raw = loadState(VOICE_TIER_KEY);
    const value = isVoiceTier(raw) ? raw : DEFAULT_TIER;
    _voiceTierCached = value;
    return value;
  } catch {
    return DEFAULT_TIER;
  }
}

export function invalidateVoiceTierCache(): void {
  _voiceTierCached = undefined;
}

/** Wire cache invalidation to the stateSavedBus. Call once during boot
 *  (before `registerDbIpc`). Returns the unsubscribe handle. */
export function subscribeVoiceTierInvalidation(): () => void {
  return onStateSaved((key) => {
    if (key === VOICE_TIER_KEY) invalidateVoiceTierCache();
  });
}
