// Crash-upload consent (tri-state). Phase 4 crash observability
// (spec §7, plan phase 4: first-run consent).
//
// Wire-shape: stored in app_state under `crashUploadConsent`. Three values:
//
//   - 'pending'    — user has not answered the first-run modal yet. Treated
//                    as opt-OUT for upload purposes (no Sentry init) until
//                    they answer.
//   - 'opted-in'   — user clicked "Allow" in the modal or flipped the toggle
//                    on in Settings. Sentry init runs; events flow.
//   - 'opted-out'  — user clicked "Not now" or flipped the toggle off.
//                    Sentry init early-returns; no SDK client created.
//
// Per the user's hard constraint: local crash logs (phase 1 collector) ALWAYS
// write regardless of consent. This module only gates the *network upload*
// path through Sentry init.
//
// Migration from the legacy `crashReportingOptOut` boolean: when no
// consent row exists but the legacy opt-out row does, we materialise a
// derived consent ('opted-out' when the legacy row is true, otherwise
// 'pending' — we never silent-opt-in old users). The Settings toggle now
// writes the consent key; the legacy key is left in place so a downgrade
// stays safe.
//
// Cache + invalidation pattern mirrors `crashReporting.ts` so the renderer
// toggle takes effect within one event without an app restart.

import { loadState } from '../db';
import { onStateSaved } from '../shared/stateSavedBus';
import { CRASH_OPT_OUT_KEY } from './crashReporting';

export const CRASH_CONSENT_KEY = 'crashUploadConsent';

export type CrashConsent = 'pending' | 'opted-in' | 'opted-out';

const VALID: ReadonlySet<string> = new Set(['pending', 'opted-in', 'opted-out']);

let _cached: CrashConsent | undefined;

function readRaw(): CrashConsent {
  // Explicit consent row wins.
  try {
    const raw = loadState(CRASH_CONSENT_KEY);
    if (raw && VALID.has(raw)) return raw as CrashConsent;
  } catch {
    /* fall through to legacy / default */
  }
  // Legacy fallback: respect a previously-set opt-out boolean so we don't
  // silently start uploading for users who already opted out before phase 4.
  try {
    const legacy = loadState(CRASH_OPT_OUT_KEY);
    if (legacy === 'true' || legacy === '1') return 'opted-out';
  } catch {
    /* swallow */
  }
  return 'pending';
}

/** Read the current consent state (cached). */
export function loadCrashConsent(): CrashConsent {
  if (_cached !== undefined) return _cached;
  const value = readRaw();
  _cached = value;
  return value;
}

/** Drop the cached value; the next `loadCrashConsent()` re-reads from DB. */
export function invalidateCrashConsentCache(): void {
  _cached = undefined;
}

/** True iff the user has explicitly opted in. The Sentry init gate calls
 *  this — `pending` and `opted-out` both block upload. */
export function isCrashUploadAllowed(): boolean {
  return loadCrashConsent() === 'opted-in';
}

/** Wire cache invalidation to the stateSavedBus. Call once during boot. */
export function subscribeCrashConsentInvalidation(): () => void {
  return onStateSaved((key) => {
    if (key === CRASH_CONSENT_KEY || key === CRASH_OPT_OUT_KEY) {
      invalidateCrashConsentCache();
    }
  });
}

/** Test-only reset of module-scope cache (not exported via index). */
export function _resetCrashConsentForTests(): void {
  _cached = undefined;
}
