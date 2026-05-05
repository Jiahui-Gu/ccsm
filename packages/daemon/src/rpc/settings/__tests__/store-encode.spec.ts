// packages/daemon/src/rpc/settings/__tests__/store-encode.spec.ts
//
// Task #434 (T8.14b-4) — rpc/ coverage push for the pure
// `encodeUpdatePatch` decider in `../store.ts`. Spec #337 §4.2: every
// UpdateSettings call funnels through this function before any
// transaction runs, so the cap-and-clamp policy + daemon-derived
// rejection contract MUST be unit-testable without a sqlite handle.
//
// The companion sink (`applySettingsWrites` + `makeUpdateSettingsHandler`)
// is exercised by the integration boot e2e — duplicating wire shape
// here would just slow CI without adding signal. Hot path covered:
// scalar UPSERT + map UPSERT/DELETE + clamp ceilings. Error branch:
// daemon-derived rejection.

import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import {
  CrashRetentionSchema,
  PtyGeometrySchema,
  SettingsSchema,
} from '@ccsm/proto';

import { CAPS, encodeUpdatePatch } from '../store.js';
import { SETTINGS_KEYS, UI_PREFS_PREFIX } from '../keys.js';

describe('encodeUpdatePatch (Task #434 — pure decider, spec #337 §4.2)', () => {
  it('emits one UPSERT per touched scalar with JSON-encoded values', () => {
    // Hot path: client supplies locale + default_geometry + a ui_prefs
    // entry. Decider returns one upsert each, all values JSON-encoded
    // per spec §2.3 (uniform-encoding rule).
    const patch = create(SettingsSchema, {
      locale: 'en-US',
      defaultGeometry: create(PtyGeometrySchema, { cols: 80, rows: 24 }),
      uiPrefs: { 'appearance.theme': 'dark' },
    });

    const result = encodeUpdatePatch(patch);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const ops = [...result.ops];
    // locale
    const localeOp = ops.find((o) => o.key === SETTINGS_KEYS.locale);
    expect(localeOp).toEqual({
      kind: 'upsert',
      key: SETTINGS_KEYS.locale,
      value: JSON.stringify('en-US'),
    });
    // default_geometry — dotted JSON shape exactly as the reader expects
    const geomOp = ops.find((o) => o.key === SETTINGS_KEYS.defaultGeometry);
    expect(geomOp).toEqual({
      kind: 'upsert',
      key: SETTINGS_KEYS.defaultGeometry,
      value: JSON.stringify({ cols: 80, rows: 24 }),
    });
    // ui_prefs entry — full key uses the canonical prefix
    const themeOp = ops.find(
      (o) => o.key === `${UI_PREFS_PREFIX}appearance.theme`,
    );
    expect(themeOp).toEqual({
      kind: 'upsert',
      key: `${UI_PREFS_PREFIX}appearance.theme`,
      value: JSON.stringify('dark'),
    });
  });

  it('clamps crash_retention max_entries / max_age_days to the spec ceilings', () => {
    // Spec §4.2 + settings.proto:121-123 — caps applied at write time so
    // the table never holds an out-of-range value. We push values past
    // both ceilings and assert the encoded JSON carries the clamped
    // numbers (NOT the originals).
    const patch = create(SettingsSchema, {
      crashRetention: create(CrashRetentionSchema, {
        maxEntries: 999_999, // > 10000 cap
        maxAgeDays: 365,     // > 90 cap
      }),
    });

    const result = encodeUpdatePatch(patch);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const op = result.ops.find(
      (o) => o.key === SETTINGS_KEYS.crashRetention,
    );
    expect(op?.kind).toBe('upsert');
    if (op?.kind !== 'upsert') return;
    const decoded = JSON.parse(op.value) as {
      max_entries: number;
      max_age_days: number;
    };
    expect(decoded.max_entries).toBe(CAPS.crashRetentionMaxEntries);
    expect(decoded.max_age_days).toBe(CAPS.crashRetentionMaxAgeDays);
  });

  it('emits a DELETE op for ui_prefs entries with empty-string values', () => {
    // Spec §4.2 last bullet: empty string == "client asked to forget
    // this key". We staple a single forget alongside a regular upsert
    // to verify the discriminator switch fires per-entry.
    const patch = create(SettingsSchema, {
      uiPrefs: {
        'composer.fontSizePx': '14',
        'notify.enabled': '', // forget signal
      },
    });

    const result = encodeUpdatePatch(patch);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const forget = result.ops.find(
      (o) => o.key === `${UI_PREFS_PREFIX}notify.enabled`,
    );
    expect(forget).toEqual({
      kind: 'delete',
      key: `${UI_PREFS_PREFIX}notify.enabled`,
    });
    const upsert = result.ops.find(
      (o) => o.key === `${UI_PREFS_PREFIX}composer.fontSizePx`,
    );
    expect(upsert?.kind).toBe('upsert');
  });

  it('rejects writes carrying daemon-derived fields with reject_daemon_derived', () => {
    // Spec §4.2 + acceptance §7 #5: client cannot set
    // `user_home_path` or `detected_claude_default_model`. Either
    // touched-with-non-empty value triggers the rejection terminal so
    // the handler can map to InvalidArgument WITHOUT applying any of
    // the other fields in the same patch (no partial writes).
    const patchHome = create(SettingsSchema, {
      userHomePath: '/tmp/spoof-home',
      locale: 'en-US', // would be a valid op if we got past the gate
    });
    const homeResult = encodeUpdatePatch(patchHome);
    expect(homeResult).toEqual({
      kind: 'reject_daemon_derived',
      key: SETTINGS_KEYS.userHomePath,
    });

    const patchModel = create(SettingsSchema, {
      detectedClaudeDefaultModel: 'claude-spoofed',
    });
    const modelResult = encodeUpdatePatch(patchModel);
    expect(modelResult).toEqual({
      kind: 'reject_daemon_derived',
      key: SETTINGS_KEYS.detectedClaudeDefaultModel,
    });
  });
});
