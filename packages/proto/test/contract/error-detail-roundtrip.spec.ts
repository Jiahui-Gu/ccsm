// T0.12 contract test #4 — ErrorDetail round-trip for all v0.3 standard codes.
//
// Closes design spec ch04 §7.1 #4 (`proto/error-detail-roundtrip.spec.ts`).
//
// What it pins (forever-stable):
//
//   1. The four standard `ErrorDetail.code` strings v0.3 ships are
//      forever-stable — neither the spelling nor the wire shape may
//      change. v0.4+ may ADD new codes; existing codes MUST NOT be
//      renamed, removed, or repurposed (per ch04 §8 additivity rule).
//
//        - `daemon.starting`        — ch02 §5 (UNAVAILABLE during boot)
//        - `version.client_too_old` — ch04 §3 (Hello negotiation)
//        - `request.missing_id`     — ch04 §2 (RequestMeta validation)
//        - `session.not_owned`      — ch05 §5 (per-RPC enforcement matrix)
//
//   2. ErrorDetail encoding is byte-stable: serialize -> deserialize ->
//      re-serialize MUST produce a buffer byte-identical to the first
//      serialization. This is the canonical-encoding guarantee Connect
//      relies on for `details` propagation through Connect's error
//      envelope.
//
//   3. The `extra` map (string -> string) round-trips for representative
//      payloads: `daemon_proto_version`, `session_id`, `principal`.
//
// Out of scope (NOT a behavior test): this file does NOT exercise
// ConnectError attachment / extraction (that lives at the Connect
// transport layer; T2.x). This is a CONTRACT shape + byte-stability
// test for the underlying message.

import { describe, expect, it } from 'vitest';
import { create, toBinary, fromBinary, toJson, fromJson } from '@bufbuild/protobuf';
import { ErrorDetailSchema } from '../../gen/ts/ccsm/v1/common_pb.js';

// The 4 forever-stable v0.3 standard codes called out in the task scope.
// Drift detection: renaming any of these strings here MUST also rename them
// at the call sites (daemon middleware, Electron client error handlers).
const STANDARD_CODES = [
  {
    code: 'daemon.starting',
    message: 'Daemon is still starting; retry in 200ms.',
    extra: {},
  },
  {
    code: 'version.client_too_old',
    message: 'Client proto_min_version exceeds daemon proto_version.',
    extra: { daemon_proto_version: '1' },
  },
  {
    code: 'request.missing_id',
    message: 'request_id is required and must be a non-empty UUIDv4.',
    extra: {},
  },
  {
    code: 'session.not_owned',
    message: 'Session is owned by a different principal.',
    extra: { session_id: '01HXYZ123ABCDEFGHJKMNPQRSTV', principal: 'local-user:1000' },
  },
] as const;

describe('ErrorDetail round-trip — standard codes (ch04 §7.1 #4)', () => {
  for (const fixture of STANDARD_CODES) {
    it(`code "${fixture.code}" serializes -> deserializes -> re-serializes byte-identical`, () => {
      const detail = create(ErrorDetailSchema, {
        code: fixture.code,
        message: fixture.message,
        extra: { ...fixture.extra },
      });

      // First binary serialization.
      const bytes1 = toBinary(ErrorDetailSchema, detail);

      // Decode and assert every field survived intact.
      const decoded = fromBinary(ErrorDetailSchema, bytes1);
      expect(decoded.code).toBe(fixture.code);
      expect(decoded.message).toBe(fixture.message);
      // `extra` is a map<string,string>. Compare as an object snapshot.
      expect({ ...decoded.extra }).toEqual({ ...fixture.extra });

      // Re-serialize the decoded value. The bytes MUST be byte-identical
      // to the first encoding — proto3 canonical-encoding contract for
      // a message with no unset optional fields.
      const bytes2 = toBinary(ErrorDetailSchema, decoded);
      expect(Buffer.from(bytes2).equals(Buffer.from(bytes1))).toBe(true);
    });
  }

  it('JSON round-trip preserves code + message + extra map for all standard codes', () => {
    for (const fixture of STANDARD_CODES) {
      const detail = create(ErrorDetailSchema, {
        code: fixture.code,
        message: fixture.message,
        extra: { ...fixture.extra },
      });
      const json = toJson(ErrorDetailSchema, detail);
      const decoded = fromJson(ErrorDetailSchema, json);
      expect(decoded.code).toBe(fixture.code);
      expect(decoded.message).toBe(fixture.message);
      expect({ ...decoded.extra }).toEqual({ ...fixture.extra });
    }
  });

  it('extra map preserves multiple entries with arbitrary string values (open key set)', () => {
    const detail = create(ErrorDetailSchema, {
      code: 'session.not_owned',
      message: 'Cross-principal access denied.',
      extra: {
        session_id: '01HXYZ123',
        principal: 'local-user:1000',
        attempted_by: 'local-user:1001',
        rpc: 'SessionService.GetSession',
      },
    });
    const decoded = fromBinary(ErrorDetailSchema, toBinary(ErrorDetailSchema, detail));
    expect(Object.keys(decoded.extra).sort()).toEqual(
      ['attempted_by', 'principal', 'rpc', 'session_id'],
    );
    expect(decoded.extra['rpc']).toBe('SessionService.GetSession');
  });
});
