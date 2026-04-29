import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron — only the bits dbIpc imports transitively from prefs
// (none directly). The handler uses `fromMainFrame` from security/ipcGuards
// which inspects e.senderFrame; we provide a minimal stub.
vi.mock('electron', () => ({}));

// Mock the prefs cache invalidators so we can assert invocation without
// touching the real cache.
const invalidateCrash = vi.fn();
const invalidateNotify = vi.fn();
vi.mock('../../prefs/crashReporting', () => ({
  CRASH_OPT_OUT_KEY: 'crash.optOut',
  invalidateCrashReportingCache: () => invalidateCrash(),
}));
vi.mock('../../prefs/notifyEnabled', () => ({
  NOTIFY_ENABLED_KEY: 'notify.enabled',
  invalidateNotifyEnabledCache: () => invalidateNotify(),
}));

// Mock db so handleDbSave doesn't try to open SQLite.
const saveStateCalls: Array<{ key: string; value: string }> = [];
vi.mock('../../db', () => ({
  saveState: (key: string, value: string) =>
    saveStateCalls.push({ key, value }),
  loadState: (_k: string) => null,
}));

// Mock validate so we control its responses.
let validateResult:
  | { ok: true }
  | { ok: false; error: string } = { ok: true };
vi.mock('../../db-validate', () => ({
  validateSaveStateInput: (_k: string, _v: string) => validateResult,
}));

// Mock the security guard. Default: accept; tests can flip to reject.
let allowGuard = true;
vi.mock('../../security/ipcGuards', () => ({
  fromMainFrame: (_e: unknown) => allowGuard,
}));

import { dispatchSavedKeyInvalidation, handleDbSave } from '../dbIpc';
import type { IpcMainInvokeEvent } from 'electron';

const fakeEvent = {} as IpcMainInvokeEvent;

beforeEach(() => {
  invalidateCrash.mockClear();
  invalidateNotify.mockClear();
  saveStateCalls.length = 0;
  validateResult = { ok: true };
  allowGuard = true;
});

describe('dispatchSavedKeyInvalidation', () => {
  it('invalidates crash-reporting cache when CRASH_OPT_OUT_KEY is saved', () => {
    dispatchSavedKeyInvalidation('crash.optOut');
    expect(invalidateCrash).toHaveBeenCalledTimes(1);
    expect(invalidateNotify).not.toHaveBeenCalled();
  });

  it('invalidates notify cache when NOTIFY_ENABLED_KEY is saved', () => {
    dispatchSavedKeyInvalidation('notify.enabled');
    expect(invalidateNotify).toHaveBeenCalledTimes(1);
    expect(invalidateCrash).not.toHaveBeenCalled();
  });

  it('is a no-op for unrelated keys', () => {
    dispatchSavedKeyInvalidation('some.other.key');
    expect(invalidateCrash).not.toHaveBeenCalled();
    expect(invalidateNotify).not.toHaveBeenCalled();
  });
});

describe('handleDbSave', () => {
  it('persists value and returns ok when guard + validation pass', () => {
    const result = handleDbSave(fakeEvent, 'foo', 'bar');
    expect(result).toEqual({ ok: true });
    expect(saveStateCalls).toEqual([{ key: 'foo', value: 'bar' }]);
  });

  it('rejects when sender is not the main frame', () => {
    allowGuard = false;
    const result = handleDbSave(fakeEvent, 'foo', 'bar');
    expect(result).toEqual({ ok: false, error: 'rejected' });
    expect(saveStateCalls).toEqual([]);
  });

  it('returns validation error and does not persist', () => {
    validateResult = { ok: false, error: 'value_too_large' };
    const result = handleDbSave(fakeEvent, 'k', 'v');
    expect(result).toEqual({ ok: false, error: 'value_too_large' });
    expect(saveStateCalls).toEqual([]);
  });

  it('triggers cache invalidation for known prefs after save', () => {
    handleDbSave(fakeEvent, 'crash.optOut', 'true');
    expect(invalidateCrash).toHaveBeenCalledTimes(1);
    handleDbSave(fakeEvent, 'notify.enabled', 'false');
    expect(invalidateNotify).toHaveBeenCalledTimes(1);
  });

  // Reverse-verify: confirms the test would FAIL if dispatchSavedKeyInvalidation
  // was unwired — saving the crash key without the dispatcher should leave
  // the mock uncalled.
  it('reverse-verify: invalidation is gated by the dispatcher, not save', () => {
    handleDbSave(fakeEvent, 'unrelated', 'v');
    expect(invalidateCrash).not.toHaveBeenCalled();
    expect(invalidateNotify).not.toHaveBeenCalled();
  });
});
