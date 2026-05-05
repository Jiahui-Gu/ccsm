// packages/daemon/src/rpc/settings/__tests__/store-decode.spec.ts
//
// Task #434 (T8.14b-4) — rpc/ coverage push for the pure
// `rowsToSettings` decider in `../store.ts`. Spec #337 §2.4
// forward-tolerance + §4.1: GetSettings reconstructs the proto Settings
// message from the on-disk row stream, skipping draft rows and
// surfacing unknown keys via the optional onUnknown callback rather
// than throwing. These specs pin both branches without spinning up
// sqlite (the producer `readSettingsRows` is a thin SELECT).

import { describe, expect, it, vi } from 'vitest';

import { rowsToSettings } from '../store.js';
import { DRAFT_PREFIX, SETTINGS_KEYS, UI_PREFS_PREFIX } from '../keys.js';

describe('rowsToSettings (Task #434 — pure decider, spec #337 §2.4 / §4.1)', () => {
  it('projects known scalar / message / ui_prefs rows into the proto Settings shape', () => {
    // Hot path: feed the decider one row of each shape it knows about.
    // We intentionally include a draft:* row to verify the skip branch
    // (spec §4.1 step 2 — drafts owned by DraftService).
    const rows = [
      { key: SETTINGS_KEYS.locale, value: JSON.stringify('zh-CN') },
      {
        key: SETTINGS_KEYS.defaultGeometry,
        value: JSON.stringify({ cols: 100, rows: 30 }),
      },
      {
        key: SETTINGS_KEYS.crashRetention,
        value: JSON.stringify({ max_entries: 500, max_age_days: 30 }),
      },
      { key: SETTINGS_KEYS.sentryEnabled, value: JSON.stringify(false) },
      {
        key: `${UI_PREFS_PREFIX}appearance.theme`,
        value: JSON.stringify('dark'),
      },
      // draft row — MUST be skipped, not surfaced via onUnknown
      {
        key: `${DRAFT_PREFIX}01J0000000000000000000ABCD`,
        value: JSON.stringify({ text: 'hi', updated_unix_ms: 1 }),
      },
    ];

    const onUnknown = vi.fn();
    const settings = rowsToSettings(rows, { onUnknown });

    expect(settings.locale).toBe('zh-CN');
    expect(settings.defaultGeometry?.cols).toBe(100);
    expect(settings.defaultGeometry?.rows).toBe(30);
    expect(settings.crashRetention?.maxEntries).toBe(500);
    expect(settings.crashRetention?.maxAgeDays).toBe(30);
    expect(settings.sentryEnabled).toBe(false);
    expect(settings.uiPrefs).toEqual({ 'appearance.theme': 'dark' });
    // Draft row took the early `continue` (NOT the unknown branch).
    expect(onUnknown).not.toHaveBeenCalled();
  });

  it('forwards unknown keys to onUnknown without throwing (spec §2.4 forward-tolerance)', () => {
    // Error branch: a key the v0.3 daemon does not recognise (e.g. a
    // v0.4 additive row read on a downgrade) must NOT throw — proto3
    // unknown-field semantics applied at the storage layer. The optional
    // callback fires for observability, the proto Settings comes back
    // with default-only values for unrecognised slots, and the call
    // returns normally. Corrupt-JSON rows hit the same forward-tolerant
    // path (skip).
    const rows = [
      { key: 'future_v04_only_key', value: JSON.stringify('whatever') },
      // Corrupt JSON row — silently skipped per the inner try/catch.
      { key: SETTINGS_KEYS.locale, value: '{not valid json' },
    ];

    const onUnknown = vi.fn();
    const settings = rowsToSettings(rows, { onUnknown });

    expect(onUnknown).toHaveBeenCalledTimes(1);
    expect(onUnknown).toHaveBeenCalledWith('future_v04_only_key');
    // Locale row was corrupt; default empty string survives.
    expect(settings.locale).toBe('');
  });
});
