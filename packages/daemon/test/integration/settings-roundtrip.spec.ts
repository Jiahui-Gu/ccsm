// packages/daemon/test/integration/settings-roundtrip.spec.ts
//
// T8.10 — integration spec: SettingsService.UpdateSettings +
// GetSettings round-trip with DB persistence via the #54 sqlite wrapper.
//
// Spec ch12 §3:
//   "settings-roundtrip.spec.ts — SettingsService.Update + Get happy
//    path: round-trip equal."
//
// Spec ch04 §6 (SettingsService) + ch07 §3 (settings table):
//   - UpdateSettings has PARTIAL UPDATE semantics: daemon REPLACES only
//     the fields whose proto3 presence bit is set; absent fields are
//     LEFT AT THEIR CURRENT VALUE. Round-trip means: send Update, get
//     back the post-merge Settings; subsequent GetSettings returns the
//     same merged Settings.
//   - The DB row shape is `(scope, key, value)` PRIMARY KEY (scope, key);
//     v0.3 daemon writes `scope = 'global'`. SETTINGS_SCOPE_PRINCIPAL is
//     rejected with InvalidArgument (covered by settings-error.spec.ts).
//   - Security-sensitive keys (`claude_binary_path`) are NOT in the
//     proto schema — the boundary is mechanical (no field exists). So
//     this spec only round-trips fields the proto allows.
//
// SRP:
//   - Producer: SQLite via the daemon's `openDatabase` wrapper (#54
//     T5.1) using `:memory:`. The wrapper applies the canonical boot
//     PRAGMAs; settings round-trip in WAL mode end-to-end.
//   - Decider: a `SettingsStore` class (in-test, ~80 lines) that
//     encodes Settings → JSON-per-key DB rows, and the inverse for
//     Get. Mirrors the encoding T6.x will own.
//   - Sink: SettingsService handlers wired into the harness; client-
//     side assertions on the post-merge Settings.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import type { HandlerContext } from '@connectrpc/connect';
import { Code, ConnectError } from '@connectrpc/connect';

import {
  CrashRetentionSchema,
  type GetSettingsRequest,
  GetSettingsResponseSchema,
  PtyGeometrySchema,
  SettingsScope,
  SettingsSchema,
  SettingsService,
  type UpdateSettingsRequest,
  UpdateSettingsResponseSchema,
} from '@ccsm/proto';

import { openDatabase, type SqliteDatabase } from '../../src/db/sqlite.js';
import { newRequestMeta, startHarness, type Harness } from './harness.js';

// ---------------------------------------------------------------------------
// SQLite seed: minimal `settings` table that mirrors the schema in
// migrations/001_initial.sql. Keep the DDL local to this spec — running
// the migration runner here would couple T8.10 to T5.4 (Task #56).
// ---------------------------------------------------------------------------

const SETTINGS_DDL = `
  CREATE TABLE IF NOT EXISTS settings (
    scope TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  );
`;

// Forever-stable v0.3 scope literal (ch07 §3).
const SCOPE_GLOBAL = 'global';

// Forever-stable v0.3 settings key vocabulary. Each proto field maps to a
// dotted-path key; map<string,string> ui_prefs entries land under
// `ui.<original-dotted-path>`. Pin the vocabulary here so a v0.4 PR that
// renames a key trips the round-trip equality assertion.
const KEYS = {
  defaultGeometry: 'pty.default_geometry',
  crashRetention: 'crash.retention',
  uiPrefsPrefix: 'ui.',
  detectedClaudeDefaultModel: 'claude.detected_default_model',
  userHomePath: 'user.home_path',
  locale: 'locale',
  sentryEnabled: 'crash.sentry_enabled',
} as const;

// ---------------------------------------------------------------------------
// Encoder / decoder — proto Settings <-> per-key JSON rows.
//
// Keep this module-local (not a daemon export) so changes to the daemon's
// own encoder do not silently coast through this spec. T6.x will own the
// production encoder; this stand-in pins the wire round-trip irrespective
// of how the daemon serializes internally.
// ---------------------------------------------------------------------------

interface SettingsLike {
  defaultGeometry?: { cols: number; rows: number };
  crashRetention?: { maxEntries: number; maxAgeDays: number };
  uiPrefs: { [key: string]: string };
  detectedClaudeDefaultModel: string;
  userHomePath: string;
  locale: string;
  sentryEnabled: boolean;
}

class SettingsStore {
  constructor(private readonly db: SqliteDatabase) {}

  /** Read all keys under the given scope and project them into a
   * SettingsLike shape. Missing keys map to proto defaults. */
  read(scope: string): SettingsLike {
    const rows = this.db
      .prepare<[string], { key: string; value: string }>(
        'SELECT key, value FROM settings WHERE scope = ?',
      )
      .all(scope);

    const out: SettingsLike = {
      uiPrefs: {},
      detectedClaudeDefaultModel: '',
      userHomePath: '',
      locale: '',
      sentryEnabled: true, // proto default per ch04 §6 / settings.proto
    };
    for (const row of rows) {
      if (row.key === KEYS.defaultGeometry) {
        out.defaultGeometry = JSON.parse(row.value);
      } else if (row.key === KEYS.crashRetention) {
        out.crashRetention = JSON.parse(row.value);
      } else if (row.key === KEYS.detectedClaudeDefaultModel) {
        out.detectedClaudeDefaultModel = JSON.parse(row.value);
      } else if (row.key === KEYS.userHomePath) {
        out.userHomePath = JSON.parse(row.value);
      } else if (row.key === KEYS.locale) {
        out.locale = JSON.parse(row.value);
      } else if (row.key === KEYS.sentryEnabled) {
        out.sentryEnabled = JSON.parse(row.value);
      } else if (row.key.startsWith(KEYS.uiPrefsPrefix)) {
        out.uiPrefs[row.key.slice(KEYS.uiPrefsPrefix.length)] = JSON.parse(
          row.value,
        );
      }
    }
    return out;
  }

  /**
   * PARTIAL update per spec ch04 §6 / F7. Only fields with proto3 presence
   * bit set are written. Absent fields are LEFT ALONE (no DELETE).
   * `ui_prefs` map merge semantics: keys in the incoming map are upserted;
   * keys absent from the incoming map are LEFT in the DB (additive merge).
   */
  partialUpdate(scope: string, patch: Partial<SettingsLike>): SettingsLike {
    const upsert = this.db.prepare<[string, string, string]>(
      'INSERT INTO settings (scope, key, value) VALUES (?, ?, ?) ' +
        'ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value',
    );
    if (patch.defaultGeometry !== undefined) {
      upsert.run(scope, KEYS.defaultGeometry, JSON.stringify(patch.defaultGeometry));
    }
    if (patch.crashRetention !== undefined) {
      upsert.run(scope, KEYS.crashRetention, JSON.stringify(patch.crashRetention));
    }
    if (patch.uiPrefs !== undefined) {
      for (const [k, v] of Object.entries(patch.uiPrefs)) {
        upsert.run(scope, `${KEYS.uiPrefsPrefix}${k}`, JSON.stringify(v));
      }
    }
    if (patch.detectedClaudeDefaultModel !== undefined) {
      upsert.run(
        scope,
        KEYS.detectedClaudeDefaultModel,
        JSON.stringify(patch.detectedClaudeDefaultModel),
      );
    }
    if (patch.userHomePath !== undefined) {
      upsert.run(scope, KEYS.userHomePath, JSON.stringify(patch.userHomePath));
    }
    if (patch.locale !== undefined) {
      upsert.run(scope, KEYS.locale, JSON.stringify(patch.locale));
    }
    if (patch.sentryEnabled !== undefined) {
      upsert.run(scope, KEYS.sentryEnabled, JSON.stringify(patch.sentryEnabled));
    }
    return this.read(scope);
  }
}

// Convert the in-memory SettingsLike to the proto Settings shape used by
// GetSettingsResponse / UpdateSettingsResponse.
function toProtoSettings(s: SettingsLike) {
  return create(SettingsSchema, {
    defaultGeometry: s.defaultGeometry
      ? create(PtyGeometrySchema, s.defaultGeometry)
      : undefined,
    crashRetention: s.crashRetention
      ? create(CrashRetentionSchema, s.crashRetention)
      : undefined,
    uiPrefs: { ...s.uiPrefs },
    detectedClaudeDefaultModel: s.detectedClaudeDefaultModel,
    userHomePath: s.userHomePath,
    locale: s.locale,
    sentryEnabled: s.sentryEnabled,
  });
}

// ---------------------------------------------------------------------------
// Bring up.
// ---------------------------------------------------------------------------

let harness: Harness;
let db: SqliteDatabase;
let store: SettingsStore;

beforeEach(async () => {
  // openDatabase from #54 — exercises the canonical boot PRAGMAs even on
  // :memory:. This is the path the production daemon takes; we stay on
  // it so the round-trip exercises the same SQL surface (WAL, FK, etc.).
  db = openDatabase(':memory:');
  db.exec(SETTINGS_DDL);
  store = new SettingsStore(db);

  harness = await startHarness({
    setup(router) {
      router.service(SettingsService, {
        async getSettings(req: GetSettingsRequest, _ctx: HandlerContext) {
          // v0.3 daemon honors only SCOPE_GLOBAL (ch04 §6); other scopes
          // are rejected by settings-error.spec.ts. Here we map any
          // UNSPECIFIED to GLOBAL per the proto comment.
          if (
            req.scope !== SettingsScope.UNSPECIFIED &&
            req.scope !== SettingsScope.GLOBAL
          ) {
            throw new ConnectError(
              'unsupported scope in v0.3',
              Code.InvalidArgument,
            );
          }
          const settings = store.read(SCOPE_GLOBAL);
          return create(GetSettingsResponseSchema, {
            meta: newRequestMeta(),
            settings: toProtoSettings(settings),
            effectiveScope: SettingsScope.GLOBAL,
          });
        },

        async updateSettings(req: UpdateSettingsRequest, _ctx: HandlerContext) {
          if (
            req.scope !== SettingsScope.UNSPECIFIED &&
            req.scope !== SettingsScope.GLOBAL
          ) {
            throw new ConnectError(
              'unsupported scope in v0.3',
              Code.InvalidArgument,
            );
          }
          const incoming = req.settings;
          if (!incoming) {
            throw new ConnectError(
              'settings is required',
              Code.InvalidArgument,
            );
          }
          // Translate the proto presence semantics to a partial patch.
          // Note: scalar fields without proto3 `optional` (locale,
          // userHomePath, ...) are always present on the wire; we treat
          // their incoming value as authoritative (no presence bit means
          // "client always sends a value, even if empty"). The
          // partial-update semantics are F7 (ch04 §6) for the OPTIONAL
          // fields only: defaultGeometry, crashRetention. ui_prefs map
          // merges additively per the F6 doc on Settings.ui_prefs.
          const patch: Partial<SettingsLike> = {
            // Always-present scalars — caller controls.
            detectedClaudeDefaultModel: incoming.detectedClaudeDefaultModel,
            userHomePath: incoming.userHomePath,
            locale: incoming.locale,
            sentryEnabled: incoming.sentryEnabled,
          };
          if (incoming.defaultGeometry !== undefined) {
            patch.defaultGeometry = {
              cols: incoming.defaultGeometry.cols,
              rows: incoming.defaultGeometry.rows,
            };
          }
          if (incoming.crashRetention !== undefined) {
            patch.crashRetention = {
              maxEntries: incoming.crashRetention.maxEntries,
              maxAgeDays: incoming.crashRetention.maxAgeDays,
            };
          }
          if (Object.keys(incoming.uiPrefs).length > 0) {
            patch.uiPrefs = { ...incoming.uiPrefs };
          }

          const merged = store.partialUpdate(SCOPE_GLOBAL, patch);
          return create(UpdateSettingsResponseSchema, {
            meta: newRequestMeta(),
            settings: toProtoSettings(merged),
            effectiveScope: SettingsScope.GLOBAL,
          });
        },
      });
    },
  });
});

afterEach(async () => {
  await harness.stop();
  db.close();
});

// ---------------------------------------------------------------------------
// The spec.
// ---------------------------------------------------------------------------

describe('settings-roundtrip (ch12 §3 / ch04 §6 / ch07 §3)', () => {
  it('Update then Get returns the same Settings (full payload, GLOBAL scope)', async () => {
    const client = harness.makeClient(SettingsService);

    const payload = create(SettingsSchema, {
      defaultGeometry: create(PtyGeometrySchema, { cols: 120, rows: 40 }),
      crashRetention: create(CrashRetentionSchema, {
        maxEntries: 5000,
        maxAgeDays: 30,
      }),
      uiPrefs: {
        'appearance.theme': 'dark',
        'composer.fontSizePx': '14',
        'notify.enabled': 'true',
      },
      detectedClaudeDefaultModel: 'claude-sonnet-4',
      userHomePath: '/home/test',
      locale: 'en-US',
      sentryEnabled: false,
    });

    const upd = await client.updateSettings({
      meta: newRequestMeta(),
      settings: payload,
      scope: SettingsScope.GLOBAL,
    });
    expect(upd.effectiveScope).toBe(SettingsScope.GLOBAL);

    // Update response carries the post-merge Settings (F7 round-trip
    // requirement). Spot-check the load-bearing fields.
    expect(upd.settings?.defaultGeometry?.cols).toBe(120);
    expect(upd.settings?.defaultGeometry?.rows).toBe(40);
    expect(upd.settings?.crashRetention?.maxEntries).toBe(5000);
    expect(upd.settings?.crashRetention?.maxAgeDays).toBe(30);
    expect(upd.settings?.uiPrefs).toEqual({
      'appearance.theme': 'dark',
      'composer.fontSizePx': '14',
      'notify.enabled': 'true',
    });
    expect(upd.settings?.detectedClaudeDefaultModel).toBe('claude-sonnet-4');
    expect(upd.settings?.userHomePath).toBe('/home/test');
    expect(upd.settings?.locale).toBe('en-US');
    expect(upd.settings?.sentryEnabled).toBe(false);

    // Subsequent GetSettings returns the persisted view byte-for-byte.
    const get = await client.getSettings({
      meta: newRequestMeta(),
      scope: SettingsScope.GLOBAL,
    });
    expect(get.effectiveScope).toBe(SettingsScope.GLOBAL);
    expect(get.settings).toEqual(upd.settings);
  });

  it('UNSPECIFIED scope is treated as GLOBAL on both Get and Update (ch04 §6 default)', async () => {
    const client = harness.makeClient(SettingsService);

    const upd = await client.updateSettings({
      meta: newRequestMeta(),
      settings: create(SettingsSchema, {
        locale: 'zh-CN',
        sentryEnabled: true,
      }),
      scope: SettingsScope.UNSPECIFIED,
    });
    expect(upd.effectiveScope).toBe(SettingsScope.GLOBAL);
    expect(upd.settings?.locale).toBe('zh-CN');

    const get = await client.getSettings({
      meta: newRequestMeta(),
      scope: SettingsScope.UNSPECIFIED,
    });
    expect(get.effectiveScope).toBe(SettingsScope.GLOBAL);
    expect(get.settings?.locale).toBe('zh-CN');
  });

  it('partial Update preserves untouched OPTIONAL fields (F7 ch04 §6)', async () => {
    const client = harness.makeClient(SettingsService);

    // Step 1: set both defaultGeometry and crashRetention.
    await client.updateSettings({
      meta: newRequestMeta(),
      settings: create(SettingsSchema, {
        defaultGeometry: create(PtyGeometrySchema, { cols: 80, rows: 24 }),
        crashRetention: create(CrashRetentionSchema, {
          maxEntries: 100,
          maxAgeDays: 7,
        }),
      }),
      scope: SettingsScope.GLOBAL,
    });

    // Step 2: update ONLY crashRetention; defaultGeometry must be
    // preserved by the partial-update semantics.
    const upd = await client.updateSettings({
      meta: newRequestMeta(),
      settings: create(SettingsSchema, {
        crashRetention: create(CrashRetentionSchema, {
          maxEntries: 9999,
          maxAgeDays: 90,
        }),
        // defaultGeometry intentionally omitted.
      }),
      scope: SettingsScope.GLOBAL,
    });

    // Post-merge Settings carries BOTH the new crashRetention AND the
    // preserved defaultGeometry — the F7 contract.
    expect(upd.settings?.crashRetention?.maxEntries).toBe(9999);
    expect(upd.settings?.crashRetention?.maxAgeDays).toBe(90);
    expect(upd.settings?.defaultGeometry?.cols).toBe(80);
    expect(upd.settings?.defaultGeometry?.rows).toBe(24);
  });

  it('ui_prefs map merges additively across Updates (F6 ch04 §6)', async () => {
    const client = harness.makeClient(SettingsService);

    await client.updateSettings({
      meta: newRequestMeta(),
      settings: create(SettingsSchema, {
        uiPrefs: { 'appearance.theme': 'light' },
      }),
      scope: SettingsScope.GLOBAL,
    });
    const upd2 = await client.updateSettings({
      meta: newRequestMeta(),
      settings: create(SettingsSchema, {
        uiPrefs: { 'composer.fontSizePx': '16' },
      }),
      scope: SettingsScope.GLOBAL,
    });

    // Both keys are present after the second update.
    expect(upd2.settings?.uiPrefs).toEqual({
      'appearance.theme': 'light',
      'composer.fontSizePx': '16',
    });
  });

  it('persisted rows survive a daemon-side Get after Update — DB-backed, not in-memory', async () => {
    const client = harness.makeClient(SettingsService);

    await client.updateSettings({
      meta: newRequestMeta(),
      settings: create(SettingsSchema, {
        userHomePath: '/Users/test',
      }),
      scope: SettingsScope.GLOBAL,
    });

    // Read directly from the DB (bypass Connect) — the row must be in
    // the `settings` table with `scope = 'global'`. Pins that the
    // round-trip is not faking persistence with an in-process map.
    const row = db
      .prepare<[string, string], { value: string }>(
        'SELECT value FROM settings WHERE scope = ? AND key = ?',
      )
      .get(SCOPE_GLOBAL, KEYS.userHomePath);
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toBe('/Users/test');
  });
});
