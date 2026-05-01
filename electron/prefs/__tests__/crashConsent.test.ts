// Phase 4 crash observability — consent gate unit tests.
//
// Asserts:
//   - Tri-state resolver: 'pending' / 'opted-in' / 'opted-out' round-trip.
//   - Default = 'pending' when neither the new key nor legacy boolean is set.
//   - Legacy fallback: opt-out boolean produces 'opted-out' so an upgrade
//     never silently re-enables uploads for someone who already opted out.
//   - `isCrashUploadAllowed()` is true ONLY for 'opted-in'.
//   - Cache invalidates via stateSavedBus on either the new key or the
//     legacy key (handles both write paths).
//   - REVERSE-VERIFY: when the gate is removed (we drive
//     `isCrashUploadAllowed()` to true via 'opted-in'), the assertion that
//     blocks upload on opted-out FAILS — proving the gate is what stops it.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const stateStore = new Map<string, string | null>();

vi.mock('../../db', () => ({
  loadState: (key: string) => (stateStore.has(key) ? stateStore.get(key)! : null),
  saveState: (key: string, value: string) => {
    stateStore.set(key, value);
  },
}));

beforeEach(() => {
  stateStore.clear();
  vi.resetModules();
});

describe('loadCrashConsent', () => {
  it('defaults to pending when nothing is persisted', async () => {
    const { loadCrashConsent } = await import('../crashConsent');
    expect(loadCrashConsent()).toBe('pending');
  });

  it('returns opted-in when the key holds opted-in', async () => {
    stateStore.set('crashUploadConsent', 'opted-in');
    const { loadCrashConsent } = await import('../crashConsent');
    expect(loadCrashConsent()).toBe('opted-in');
  });

  it('returns opted-out when the key holds opted-out', async () => {
    stateStore.set('crashUploadConsent', 'opted-out');
    const { loadCrashConsent } = await import('../crashConsent');
    expect(loadCrashConsent()).toBe('opted-out');
  });

  it('falls back to opted-out when only the legacy boolean is set to true', async () => {
    stateStore.set('crashReportingOptOut', 'true');
    const { loadCrashConsent } = await import('../crashConsent');
    expect(loadCrashConsent()).toBe('opted-out');
  });

  it('falls back to pending when only legacy boolean is false', async () => {
    stateStore.set('crashReportingOptOut', 'false');
    const { loadCrashConsent } = await import('../crashConsent');
    // We deliberately do NOT silent-opt-in old users — false legacy still
    // requires the user to answer the new modal.
    expect(loadCrashConsent()).toBe('pending');
  });

  it('rejects bogus values and returns pending', async () => {
    stateStore.set('crashUploadConsent', 'maybe-tomorrow');
    const { loadCrashConsent } = await import('../crashConsent');
    expect(loadCrashConsent()).toBe('pending');
  });
});

describe('isCrashUploadAllowed', () => {
  it('is false for pending (the user has not answered)', async () => {
    const { isCrashUploadAllowed } = await import('../crashConsent');
    expect(isCrashUploadAllowed()).toBe(false);
  });

  it('is false for opted-out', async () => {
    stateStore.set('crashUploadConsent', 'opted-out');
    const { isCrashUploadAllowed } = await import('../crashConsent');
    expect(isCrashUploadAllowed()).toBe(false);
  });

  it('is true ONLY for opted-in', async () => {
    stateStore.set('crashUploadConsent', 'opted-in');
    const { isCrashUploadAllowed } = await import('../crashConsent');
    expect(isCrashUploadAllowed()).toBe(true);
  });
});

describe('subscribeCrashConsentInvalidation', () => {
  it('invalidates the cache when the new key is rewritten', async () => {
    stateStore.set('crashUploadConsent', 'opted-in');
    const { loadCrashConsent, subscribeCrashConsentInvalidation } = await import('../crashConsent');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeCrashConsentInvalidation();

    expect(loadCrashConsent()).toBe('opted-in');
    stateStore.set('crashUploadConsent', 'opted-out');
    emitStateSaved('crashUploadConsent');
    expect(loadCrashConsent()).toBe('opted-out');
    off();
  });

  it('also invalidates when the legacy key is rewritten', async () => {
    stateStore.set('crashUploadConsent', 'opted-in');
    const { loadCrashConsent, subscribeCrashConsentInvalidation } = await import('../crashConsent');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeCrashConsentInvalidation();
    expect(loadCrashConsent()).toBe('opted-in');

    // Renderer toggled the legacy opt-out from a downgrade scenario.
    stateStore.delete('crashUploadConsent');
    stateStore.set('crashReportingOptOut', 'true');
    emitStateSaved('crashReportingOptOut');
    expect(loadCrashConsent()).toBe('opted-out');
    off();
  });

  it('ignores unrelated keys', async () => {
    stateStore.set('crashUploadConsent', 'opted-in');
    const { loadCrashConsent, subscribeCrashConsentInvalidation } = await import('../crashConsent');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeCrashConsentInvalidation();
    expect(loadCrashConsent()).toBe('opted-in');

    stateStore.set('crashUploadConsent', 'opted-out');
    emitStateSaved('notifyEnabled');
    // No invalidation — cache still reports opted-in.
    expect(loadCrashConsent()).toBe('opted-in');
    off();
  });
});

// Reverse-verify the gate by asserting the OPPOSITE outcome when consent is
// flipped. If a future refactor accidentally drops the gate (e.g. always
// returns true regardless of consent), the first assertion still passes BUT
// the second assertion (consent=opted-out → blocked) flips and the test
// FAILS. Documents the exact semantics the Sentry init relies on.
describe('reverse-verify: gate behavior', () => {
  it('opted-in passes AND opted-out blocks (both required for the gate to be real)', async () => {
    stateStore.set('crashUploadConsent', 'opted-in');
    const { isCrashUploadAllowed, _resetCrashConsentForTests } = await import('../crashConsent');
    expect(isCrashUploadAllowed()).toBe(true);

    _resetCrashConsentForTests();
    stateStore.set('crashUploadConsent', 'opted-out');
    expect(isCrashUploadAllowed()).toBe(false);

    _resetCrashConsentForTests();
    stateStore.set('crashUploadConsent', 'pending');
    expect(isCrashUploadAllowed()).toBe(false);
  });
});
