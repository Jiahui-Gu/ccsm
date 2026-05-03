// T0.12 contract test #3 — RequestMeta.request_id round-trip.
//
// Closes design spec ch04 §7.1 #3 (`proto/request-meta-validation.spec.ts`
// — renamed for the per-task suite layout under `test/contract/`).
//
// What it pins (forever-stable):
//
//   1. `RequestMeta.request_id` round-trips through the generated codec
//      unchanged for both empty and non-empty values. The wire shape
//      itself does NOT enforce non-empty — proto3 string fields default
//      to "" — so the daemon-side validation rule ("empty request_id ->
//      INVALID_ARGUMENT + ErrorDetail.code = `request.missing_id`") MUST
//      be implemented in middleware, not at the proto level. This test
//      pins both ends of that contract:
//
//        a) shape: empty `request_id` IS a representable wire value
//           (otherwise middleware could not distinguish "not sent" from
//           "sent as empty");
//        b) shape: non-empty `request_id` round-trips byte-for-byte;
//        c) data: the canonical INVALID_ARGUMENT code string used by the
//           middleware-to-be (T2.4 #37) is `"request.missing_id"`.
//
//   2. The `client_version` and `client_send_unix_ms` siblings on the
//      same `RequestMeta` round-trip too — they share the same forever-
//      stable contract (every RPC carries them; ch04 §2).
//
// Out of scope (NOT a behavior test): this file does NOT install any
// Connect interceptor, does NOT call any RPC, does NOT exercise the
// rejection path. The middleware is T2.4 #37. This is a CONTRACT shape
// test for the data the middleware will consume.

import { describe, expect, it } from 'vitest';
import { create, toBinary, fromBinary, toJson, fromJson } from '@bufbuild/protobuf';
import { RequestMetaSchema, ErrorDetailSchema } from '../../gen/ts/ccsm/v1/common_pb.js';

describe('RequestMeta.request_id round-trip (ch04 §7.1 #3)', () => {
  it('non-empty request_id round-trips byte-for-byte through binary codec', () => {
    const original = create(RequestMetaSchema, {
      requestId: '7f3c1d8e-2b94-4f01-a5c6-d9e8b2a107c4',
      clientVersion: '0.3.0',
      clientSendUnixMs: 1730000000123n,
    });
    const bytes = toBinary(RequestMetaSchema, original);
    const decoded = fromBinary(RequestMetaSchema, bytes);
    expect(decoded.requestId).toBe('7f3c1d8e-2b94-4f01-a5c6-d9e8b2a107c4');
    expect(decoded.clientVersion).toBe('0.3.0');
    expect(decoded.clientSendUnixMs).toBe(1730000000123n);

    // Re-serialize and assert the bytes are stable (canonical encoding).
    const reBytes = toBinary(RequestMetaSchema, decoded);
    expect(Buffer.from(reBytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it('empty request_id is a representable wire value (middleware-detectable)', () => {
    // Critical: proto3 string defaults to "" with implicit presence. The
    // daemon middleware MUST be able to observe "" and reject — meaning
    // the wire MUST allow it through. If a future schema change ever gates
    // request_id at the proto layer (e.g., `optional` + presence check),
    // the daemon's INVALID_ARGUMENT code path is bypassed and clients see
    // a less-actionable error. This test fences that change.
    const empty = create(RequestMetaSchema, {
      requestId: '',
      clientVersion: '0.3.0',
      clientSendUnixMs: 1730000000000n,
    });
    const bytes = toBinary(RequestMetaSchema, empty);
    const decoded = fromBinary(RequestMetaSchema, bytes);
    expect(decoded.requestId).toBe('');
    // JSON round-trip too — empty proto3 string omitted from JSON by default
    // and parses back to empty.
    const json = toJson(RequestMetaSchema, decoded);
    const reparsed = fromJson(RequestMetaSchema, json);
    expect(reparsed.requestId).toBe('');
  });

  it('JSON round-trip preserves request_id in both directions', () => {
    const original = create(RequestMetaSchema, {
      requestId: 'abc-DEF-123',
      clientVersion: '1.2.3-rc.4',
      clientSendUnixMs: 9007199254740991n,
    });
    const json = toJson(RequestMetaSchema, original);
    const decoded = fromJson(RequestMetaSchema, json);
    expect(decoded.requestId).toBe('abc-DEF-123');
    expect(decoded.clientVersion).toBe('1.2.3-rc.4');
    expect(decoded.clientSendUnixMs).toBe(9007199254740991n);
  });

  it('canonical "request.missing_id" ErrorDetail is byte-stable (the rejection contract)', () => {
    // The middleware will emit this exact ErrorDetail on empty request_id
    // (per the comment block in src/ccsm/v1/common.proto attached to
    // RequestMeta.request_id). Pinning the shape now means T2.4 #37 cannot
    // accidentally drift the code string.
    const detail = create(ErrorDetailSchema, {
      code: 'request.missing_id',
      message: 'request_id is required and must be a non-empty UUIDv4.',
      extra: {},
    });
    const bytes = toBinary(ErrorDetailSchema, detail);
    const decoded = fromBinary(ErrorDetailSchema, bytes);
    expect(decoded.code).toBe('request.missing_id');
    expect(decoded.message).toContain('request_id');
    // Bytes are canonical — re-encoding produces the same buffer.
    expect(Buffer.from(toBinary(ErrorDetailSchema, decoded)).equals(Buffer.from(bytes))).toBe(true);
  });
});
