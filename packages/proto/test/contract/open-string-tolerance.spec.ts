// T0.12 contract test #1 — open-string-set tolerance.
//
// Closes design spec ch04 §7.1 #1 (`proto/open-string-tolerance.spec.ts` —
// renamed for the per-task suite layout under `test/contract/`).
//
// What it pins (forever-stable):
//
//   1. Proto3 unknown-field semantics: a JSON payload that names a field
//      not declared in the schema parses cleanly when `ignoreUnknownFields:
//      true` is set, and the known fields round-trip unchanged through the
//      generated codec. This is the wire-level guarantee behind the
//      "open string set" rule for `Settings.ui_prefs` keys, `CrashEntry.source`
//      values, and `HelloRequest.client_kind` values: producers may emit
//      values from a wider set than v0.3 declares, and v0.3 consumers MUST
//      tolerate them rather than reject the whole message.
//
//   2. Open-string-set FIELDS (declared as `string`, not enum, on purpose):
//      `HelloRequest.client_kind` accepts any UTF-8 string — including ones
//      v0.3 does not enumerate (`"electron" | "web" | "ios"`). v0.4+ adding
//      a new client kind (e.g. `"cli"`) MUST NOT require a proto bump or
//      break existing daemons. Same shape rule for `Settings.ui_prefs` map
//      values: arbitrary client-defined dotted-path keys are accepted.
//
// Out of scope (NOT a behavior test): this file does NOT assert daemon
// branches on `client_kind` (forbidden by ch15 §3 — separately tested by
// the lint rule referenced in spec ch15) and does NOT assert the daemon
// rejects unknown ENUM values (different rule; enums are closed in v0.3).
// This is a CONTRACT shape test only.

import { describe, expect, it } from 'vitest';
import { create, fromJson, toBinary, fromBinary, toJson } from '@bufbuild/protobuf';
import { SettingsSchema } from '../../gen/ts/ccsm/v1/settings_pb.js';
import { HelloRequestSchema } from '../../gen/ts/ccsm/v1/session_pb.js';
import { RequestMetaSchema } from '../../gen/ts/ccsm/v1/common_pb.js';

describe('open-string-set tolerance (ch04 §7.1 #1)', () => {
  it('Settings JSON with an unknown field parses (ignoreUnknownFields=true) and known fields round-trip', () => {
    // Authored as raw JSON so the unknown field cannot be normalized away
    // by the generated TypeScript types. `futureOnlyKnob` is a v0.4+
    // hypothetical field that MUST NOT cause a v0.3 consumer to fail.
    const rawJson = {
      uiPrefs: {
        'appearance.theme': 'dark',
        'composer.fontSizePx': '14',
      },
      detectedClaudeDefaultModel: 'claude-sonnet-4',
      futureOnlyKnob: 'should-be-ignored-by-v03',
      anotherFutureKnob: { nested: 'also-ignored' },
    };

    // Without ignoreUnknownFields, proto3 JSON parser MUST reject. This is
    // the proto3 default contract — confirms the codec is compliant.
    expect(() => fromJson(SettingsSchema, rawJson)).toThrow();

    // With ignoreUnknownFields: true, the message parses and known fields
    // are populated correctly. This is the "tolerant consumer" path the
    // open-string-set rule depends on.
    const parsed = fromJson(SettingsSchema, rawJson, { ignoreUnknownFields: true });
    expect(parsed.uiPrefs['appearance.theme']).toBe('dark');
    expect(parsed.uiPrefs['composer.fontSizePx']).toBe('14');
    expect(parsed.detectedClaudeDefaultModel).toBe('claude-sonnet-4');

    // Known fields round-trip through binary unchanged.
    const bytes = toBinary(SettingsSchema, parsed);
    const decoded = fromBinary(SettingsSchema, bytes);
    expect(decoded.uiPrefs['appearance.theme']).toBe('dark');
    expect(decoded.uiPrefs['composer.fontSizePx']).toBe('14');
    expect(decoded.detectedClaudeDefaultModel).toBe('claude-sonnet-4');
  });

  it('HelloRequest.client_kind accepts arbitrary UTF-8 (open string set, not enum)', () => {
    // v0.3 publishes `{electron, web, ios}` but the field MUST tolerate any
    // string — see ch04 §3 (Hello). This is the wire guarantee that v0.4+
    // can ship a new client kind without a proto bump.
    const exotic = ['electron', 'web', 'ios', 'cli', 'plugin-vscode', '未来客户端', '🚀'];
    for (const kind of exotic) {
      const meta = create(RequestMetaSchema, {
        requestId: '11111111-1111-4111-8111-111111111111',
        clientVersion: '0.3.0',
        clientSendUnixMs: 1730000000000n,
      });
      const msg = create(HelloRequestSchema, {
        meta,
        clientKind: kind,
        protoMinVersion: 1,
      });
      const bytes = toBinary(HelloRequestSchema, msg);
      const decoded = fromBinary(HelloRequestSchema, bytes);
      expect(decoded.clientKind).toBe(kind);
      // JSON also round-trips unchanged.
      const json = toJson(HelloRequestSchema, decoded);
      expect((json as { clientKind: string }).clientKind).toBe(kind);
    }
  });

  it('Settings.ui_prefs map accepts arbitrary dotted-path keys (open key set)', () => {
    // Per ch04 §6 — the `ui_prefs` map keys are open; clients own the
    // schema for their own keys; daemon does NOT validate value shape.
    const settings = create(SettingsSchema, {
      uiPrefs: {
        'appearance.theme': 'dark',
        'composer.fontSizePx': '14',
        'notify.enabled': 'true',
        'v04.web.someFutureKey': '{"nested":"json-encoded-value"}',
      },
    });
    const bytes = toBinary(SettingsSchema, settings);
    const decoded = fromBinary(SettingsSchema, bytes);
    expect(decoded.uiPrefs['v04.web.someFutureKey']).toBe('{"nested":"json-encoded-value"}');
    expect(Object.keys(decoded.uiPrefs).length).toBe(4);
  });
});
