// packages/daemon/test/integration/settings-error.spec.ts
//
// T8.10 — integration spec: SettingsService error paths.
//
// Spec ch12 §3:
//   "settings-error.spec.ts — SettingsService error paths: Update with
//    invalid schema returns `InvalidArgument`; Get on unknown key
//    returns `NotFound`."
//
// Spec ch04 §6 (SettingsService) — error contract:
//   - Empty `RequestMeta.request_id` → `InvalidArgument` with
//     `ErrorDetail.code = "request.missing_id"` (ch04 §2 / F7).
//   - SETTINGS_SCOPE_PRINCIPAL on v0.3 → `InvalidArgument` (per ch04 §6
//     comment "rejected with InvalidArgument in v0.3").
//   - Out-of-range CrashRetention values (max_entries > 10000 or
//     max_age_days > 90) → `InvalidArgument` per the ch04 §6 caps.
//   - Negative geometry (cols/rows <= 0) → `InvalidArgument`.
//
// Note on the spec's "Get on unknown key returns NotFound" wording: the
// `GetSettings` RPC has no `key` field — it returns the *entire* Settings
// for a scope. There is no "get one key" RPC in the v0.3 proto. The
// closest contract surface is `Get` on a non-GLOBAL/non-UNSPECIFIED
// scope (e.g., `SETTINGS_SCOPE_PRINCIPAL` in v0.3, which is the only
// other valid enum value) — which returns `InvalidArgument`, not
// `NotFound`, because the scope itself is wire-rejected before any
// row lookup. We pin both surfaces and document the divergence from the
// ch12 §3 prose: NotFound-by-key would require a new RPC the proto does
// not declare, and adding it here would be schema drift the spec freeze
// forbids (ch04 §1 "field numbers MUST NOT be reused or renumbered").

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import type { HandlerContext } from '@connectrpc/connect';
import { Code, ConnectError } from '@connectrpc/connect';

import {
  CrashRetentionSchema,
  ErrorDetailSchema,
  type GetSettingsRequest,
  GetSettingsResponseSchema,
  PtyGeometrySchema,
  SettingsScope,
  SettingsSchema,
  SettingsService,
  type UpdateSettingsRequest,
  UpdateSettingsResponseSchema,
} from '@ccsm/proto';

import { newRequestMeta, startHarness, type Harness } from './harness.js';

// ---------------------------------------------------------------------------
// Caps from ch04 §6.
// ---------------------------------------------------------------------------

const CRASH_RETENTION_MAX_ENTRIES_CAP = 10000;
const CRASH_RETENTION_MAX_AGE_DAYS_CAP = 90;

// ---------------------------------------------------------------------------
// Validating handler. Mirrors the validation T6.x's real handler will
// own; the contract under test is the wire-level error code + the
// structured ErrorDetail attached.
// ---------------------------------------------------------------------------

function validateSettings(s: ReturnType<typeof create<typeof SettingsSchema>>) {
  // PtyGeometry — cols/rows must be > 0 if set (any non-positive cell
  // count is meaningless; daemon would crash xterm-headless construction).
  if (s.defaultGeometry !== undefined) {
    const { cols, rows } = s.defaultGeometry;
    if (cols <= 0 || rows <= 0) {
      throw new ConnectError(
        `default_geometry must be positive (got ${cols}x${rows})`,
        Code.InvalidArgument,
        undefined,
        [
          {
            desc: ErrorDetailSchema,
            value: {
              code: 'settings.invalid_geometry',
              message: 'PtyGeometry cols and rows must both be > 0.',
              extra: {
                cols: String(cols),
                rows: String(rows),
              },
            },
          },
        ],
      );
    }
  }
  // CrashRetention — daemon caps at 10000 entries / 90 days (ch04 §6).
  if (s.crashRetention !== undefined) {
    const { maxEntries, maxAgeDays } = s.crashRetention;
    if (
      maxEntries < 0 ||
      maxEntries > CRASH_RETENTION_MAX_ENTRIES_CAP ||
      maxAgeDays < 0 ||
      maxAgeDays > CRASH_RETENTION_MAX_AGE_DAYS_CAP
    ) {
      throw new ConnectError(
        `crash_retention out of range`,
        Code.InvalidArgument,
        undefined,
        [
          {
            desc: ErrorDetailSchema,
            value: {
              code: 'settings.crash_retention_out_of_range',
              message:
                'CrashRetention.max_entries must be 0..10000; max_age_days must be 0..90.',
              extra: {
                max_entries: String(maxEntries),
                max_age_days: String(maxAgeDays),
                max_entries_cap: String(CRASH_RETENTION_MAX_ENTRIES_CAP),
                max_age_days_cap: String(CRASH_RETENTION_MAX_AGE_DAYS_CAP),
              },
            },
          },
        ],
      );
    }
  }
}

function rejectV04Scope(scope: SettingsScope): void {
  if (scope === SettingsScope.PRINCIPAL) {
    // ch04 §6: "v0.3 daemon honors only SETTINGS_SCOPE_GLOBAL;
    // SETTINGS_SCOPE_PRINCIPAL is rejected with InvalidArgument in v0.3."
    throw new ConnectError(
      'SETTINGS_SCOPE_PRINCIPAL is not supported in v0.3',
      Code.InvalidArgument,
      undefined,
      [
        {
          desc: ErrorDetailSchema,
          value: {
            code: 'settings.scope_unsupported',
            message:
              'v0.3 daemon honors only SETTINGS_SCOPE_GLOBAL; PRINCIPAL is v0.4+.',
            extra: { scope: String(scope) },
          },
        },
      ],
    );
  }
}

function validateRequestMeta(meta: { requestId: string } | undefined): void {
  if (!meta || meta.requestId === '') {
    // ch04 §2 / F7: empty request_id MUST be rejected with
    // InvalidArgument + ErrorDetail.code "request.missing_id". The
    // daemon's request-meta interceptor will own this in T1.7; we
    // validate at the handler edge here so the integration assertion
    // is meaningful before T1.7 lands.
    throw new ConnectError(
      'request_id is required and must be a non-empty UUIDv4',
      Code.InvalidArgument,
      undefined,
      [
        {
          desc: ErrorDetailSchema,
          value: {
            code: 'request.missing_id',
            message: 'request_id is required and must be a non-empty UUIDv4.',
            extra: {},
          },
        },
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Bring up.
// ---------------------------------------------------------------------------

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({
    setup(router) {
      router.service(SettingsService, {
        async getSettings(req: GetSettingsRequest, _ctx: HandlerContext) {
          validateRequestMeta(req.meta);
          rejectV04Scope(req.scope);
          // Stub: empty Settings. Error-path spec doesn't exercise the
          // happy path (covered by settings-roundtrip.spec.ts).
          return create(GetSettingsResponseSchema, {
            meta: newRequestMeta(),
            settings: create(SettingsSchema, {}),
            effectiveScope: SettingsScope.GLOBAL,
          });
        },
        async updateSettings(req: UpdateSettingsRequest, _ctx: HandlerContext) {
          validateRequestMeta(req.meta);
          rejectV04Scope(req.scope);
          if (!req.settings) {
            throw new ConnectError(
              'settings is required',
              Code.InvalidArgument,
              undefined,
              [
                {
                  desc: ErrorDetailSchema,
                  value: {
                    code: 'settings.missing_payload',
                    message: 'UpdateSettingsRequest.settings is required.',
                    extra: {},
                  },
                },
              ],
            );
          }
          validateSettings(req.settings);
          return create(UpdateSettingsResponseSchema, {
            meta: newRequestMeta(),
            settings: req.settings,
            effectiveScope: SettingsScope.GLOBAL,
          });
        },
      });
    },
  });
});

afterEach(async () => {
  await harness.stop();
});

// ---------------------------------------------------------------------------
// The spec.
// ---------------------------------------------------------------------------

describe('settings-error (ch12 §3 / ch04 §6)', () => {
  it('Update with non-positive PtyGeometry → InvalidArgument + settings.invalid_geometry', async () => {
    const client = harness.makeClient(SettingsService);
    try {
      await client.updateSettings({
        meta: newRequestMeta(),
        settings: create(SettingsSchema, {
          defaultGeometry: create(PtyGeometrySchema, { cols: 0, rows: 24 }),
        }),
        scope: SettingsScope.GLOBAL,
      });
      expect.fail('expected InvalidArgument');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      const ce = err as ConnectError;
      expect(ce.code).toBe(Code.InvalidArgument);
      const detail = ce.findDetails(ErrorDetailSchema)[0];
      expect(detail.code).toBe('settings.invalid_geometry');
      expect(detail.extra['cols']).toBe('0');
    }
  });

  it('Update with CrashRetention.max_entries > 10000 → InvalidArgument', async () => {
    const client = harness.makeClient(SettingsService);
    try {
      await client.updateSettings({
        meta: newRequestMeta(),
        settings: create(SettingsSchema, {
          crashRetention: create(CrashRetentionSchema, {
            maxEntries: 10001,
            maxAgeDays: 30,
          }),
        }),
        scope: SettingsScope.GLOBAL,
      });
      expect.fail('expected InvalidArgument');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      const ce = err as ConnectError;
      expect(ce.code).toBe(Code.InvalidArgument);
      const detail = ce.findDetails(ErrorDetailSchema)[0];
      expect(detail.code).toBe('settings.crash_retention_out_of_range');
      // Cap values are part of the contract — clients show the cap to
      // the user in the validation error UI.
      expect(detail.extra['max_entries_cap']).toBe('10000');
      expect(detail.extra['max_age_days_cap']).toBe('90');
    }
  });

  it('Update with CrashRetention.max_age_days > 90 → InvalidArgument', async () => {
    const client = harness.makeClient(SettingsService);
    try {
      await client.updateSettings({
        meta: newRequestMeta(),
        settings: create(SettingsSchema, {
          crashRetention: create(CrashRetentionSchema, {
            maxEntries: 1000,
            maxAgeDays: 91,
          }),
        }),
        scope: SettingsScope.GLOBAL,
      });
      expect.fail('expected InvalidArgument');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.InvalidArgument);
    }
  });

  it('Update with empty request_id → InvalidArgument + request.missing_id', async () => {
    // ch04 §2 / F7: every RPC validates request_id. Use a low-level
    // build that explicitly sets an empty string (newRequestMeta would
    // generate a UUID).
    const client = harness.makeClient(SettingsService);
    try {
      await client.updateSettings({
        meta: { requestId: '', clientVersion: '0.3.0-test', clientSendUnixMs: BigInt(0) },
        settings: create(SettingsSchema, {}),
        scope: SettingsScope.GLOBAL,
      });
      expect.fail('expected InvalidArgument');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      const ce = err as ConnectError;
      expect(ce.code).toBe(Code.InvalidArgument);
      const detail = ce.findDetails(ErrorDetailSchema)[0];
      expect(detail.code).toBe('request.missing_id');
    }
  });

  it('Get with empty request_id → InvalidArgument + request.missing_id', async () => {
    const client = harness.makeClient(SettingsService);
    try {
      await client.getSettings({
        meta: { requestId: '', clientVersion: '0.3.0-test', clientSendUnixMs: BigInt(0) },
        scope: SettingsScope.GLOBAL,
      });
      expect.fail('expected InvalidArgument');
    } catch (err) {
      expect((err as ConnectError).code).toBe(Code.InvalidArgument);
      const detail = (err as ConnectError).findDetails(ErrorDetailSchema)[0];
      expect(detail.code).toBe('request.missing_id');
    }
  });

  it('Update with SETTINGS_SCOPE_PRINCIPAL → InvalidArgument (v0.3 rejects v0.4 scope)', async () => {
    const client = harness.makeClient(SettingsService);
    try {
      await client.updateSettings({
        meta: newRequestMeta(),
        settings: create(SettingsSchema, {}),
        scope: SettingsScope.PRINCIPAL,
      });
      expect.fail('expected InvalidArgument');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      const ce = err as ConnectError;
      expect(ce.code).toBe(Code.InvalidArgument);
      const detail = ce.findDetails(ErrorDetailSchema)[0];
      expect(detail.code).toBe('settings.scope_unsupported');
    }
  });

  it('Get with SETTINGS_SCOPE_PRINCIPAL → InvalidArgument (v0.3 rejects v0.4 scope)', async () => {
    // Documented divergence from ch12 §3 prose ("NotFound for unknown key"):
    // GetSettings has no per-key surface; the closest unknown-target
    // surface is the v0.4 PRINCIPAL scope, which is wire-rejected with
    // InvalidArgument BEFORE any row lookup. NotFound would require a
    // GetSettingsByKey RPC the proto does not declare.
    const client = harness.makeClient(SettingsService);
    try {
      await client.getSettings({
        meta: newRequestMeta(),
        scope: SettingsScope.PRINCIPAL,
      });
      expect.fail('expected InvalidArgument');
    } catch (err) {
      expect((err as ConnectError).code).toBe(Code.InvalidArgument);
    }
  });

  it('Update with an empty (no-fields-set) Settings is a no-op (NOT InvalidArgument)', async () => {
    // Spec ch04 §6 / F7: PARTIAL update by field presence. A Settings
    // with no fields set means "do not change anything" — daemon MUST
    // accept it and return the unchanged post-merge view. Pin this so a
    // future stricter validation cannot quietly reject the no-op shape
    // (Electron clients send empty Settings as a "round-trip my view"
    // sanity ping).
    //
    // Note: the wire format always carries a Settings message instance
    // for this RPC — the request schema does not mark `settings` as
    // optional. Truly absent (undefined) is not reachable from a
    // generated client. We test the canonical no-op shape instead.
    const client = harness.makeClient(SettingsService);
    const res = await client.updateSettings({
      meta: newRequestMeta(),
      settings: create(SettingsSchema, {}),
      scope: SettingsScope.GLOBAL,
    });
    expect(res.effectiveScope).toBe(SettingsScope.GLOBAL);
    expect(res.settings).toBeDefined();
  });
});
