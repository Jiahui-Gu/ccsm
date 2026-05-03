// T0.12 contract test #2 — version negotiation truth-table (shape).
//
// Closes design spec ch04 §7.1 #2 (`proto/proto-min-version-truth-table.spec.ts`
// — renamed for the per-task suite layout under `test/contract/`).
//
// What it pins (forever-stable):
//
//   1. The DATA SHAPE the negotiation contract is built on:
//      - `HelloRequest` carries `proto_min_version: int32`.
//      - `HelloResponse` carries `proto_version: int32` (and NOT a
//        `min_compatible_client` — version negotiation is one-directional
//        per ch04 §3 / ch02 §6).
//      - Failure mode is encoded via `ErrorDetail.code` strings:
//        `"version.client_too_old"` (with `extra["daemon_proto_version"]`)
//        and (symmetric inverse, valid for client-side decision logic)
//        `"version.server_too_old"`.
//
//   2. The pure decision function used by both sides — given
//      `(clientMin, serverProtoVersion, clientMaxKnown)` it returns
//      `success | client_too_old | server_too_old`. The truth-table here
//      is forever-stable; v0.4 may NOT change the verdict for any row.
//
// Out of scope (NOT a behavior test): this file does NOT call a Hello
// RPC, does NOT exercise daemon dispatch, does NOT reach Connect-RPC.
// Those land in T2.3 #33 (Hello handler). This is a CONTRACT shape +
// pure-decider test only.

import { describe, expect, it } from 'vitest';
import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { HelloRequestSchema, HelloResponseSchema } from '../../gen/ts/ccsm/v1/session_pb.js';
import { RequestMetaSchema, ErrorDetailSchema } from '../../gen/ts/ccsm/v1/common_pb.js';

// Pure decider mirroring the contract wording in ch04 §3 + ch02 §6.
// Both client and daemon implementations MUST produce these verdicts.
type Verdict = 'success' | 'version.client_too_old' | 'version.server_too_old';
function negotiate(args: {
  clientMin: number;
  clientMaxKnown: number;
  serverProtoVersion: number;
}): Verdict {
  const { clientMin, clientMaxKnown, serverProtoVersion } = args;
  if (serverProtoVersion < clientMin) return 'version.client_too_old';
  if (serverProtoVersion > clientMaxKnown) return 'version.server_too_old';
  return 'success';
}

function meta() {
  return create(RequestMetaSchema, {
    requestId: '22222222-2222-4222-8222-222222222222',
    clientVersion: '0.3.0',
    clientSendUnixMs: 1730000000000n,
  });
}

describe('version negotiation contract (ch04 §7.1 #2 / ch04 §3)', () => {
  it('HelloRequest data shape: carries proto_min_version (int32) only', () => {
    const req = create(HelloRequestSchema, {
      meta: meta(),
      clientKind: 'electron',
      protoMinVersion: 1,
    });
    const bytes = toBinary(HelloRequestSchema, req);
    const decoded = fromBinary(HelloRequestSchema, bytes);
    expect(decoded.protoMinVersion).toBe(1);
    expect(decoded.clientKind).toBe('electron');
    // Sanity: round-trip preserves zero (proto3 default) too.
    const zero = create(HelloRequestSchema, { meta: meta(), clientKind: 'electron', protoMinVersion: 0 });
    const zeroBytes = toBinary(HelloRequestSchema, zero);
    expect(fromBinary(HelloRequestSchema, zeroBytes).protoMinVersion).toBe(0);
  });

  it('HelloResponse data shape: carries proto_version + listener_id, NOT min_compatible_client', () => {
    const resp = create(HelloResponseSchema, {
      meta: meta(),
      daemonVersion: '0.3.0',
      protoVersion: 1,
      listenerId: 'A',
    });
    const decoded = fromBinary(HelloResponseSchema, toBinary(HelloResponseSchema, resp));
    expect(decoded.protoVersion).toBe(1);
    expect(decoded.daemonVersion).toBe('0.3.0');
    expect(decoded.listenerId).toBe('A');
    // Mechanical proof that `min_compatible_client` is not a field on the
    // generated message — version negotiation is one-directional.
    expect('minCompatibleClient' in decoded).toBe(false);
    // listener_id is open string set (see ch04 §3 — "B" in v0.4, "C" in v0.5+).
    const b = create(HelloResponseSchema, { meta: meta(), daemonVersion: '0.4.0', protoVersion: 2, listenerId: 'B' });
    expect(fromBinary(HelloResponseSchema, toBinary(HelloResponseSchema, b)).listenerId).toBe('B');
  });

  it('truth-table: success / client_too_old / server_too_old verdicts are forever-stable', () => {
    // Each row is (clientMin, clientMaxKnown, serverProtoVersion, verdict).
    // Locked at v0.3; v0.4 MUST NOT change any verdict.
    const rows: Array<[number, number, number, Verdict]> = [
      // Exact match.
      [1, 1, 1, 'success'],
      // Server within client's known range (min..max).
      [1, 3, 2, 'success'],
      [1, 3, 3, 'success'],
      // Server too old — client minimum exceeds what daemon serves.
      [2, 5, 1, 'version.client_too_old'],
      [3, 3, 2, 'version.client_too_old'],
      // Server too new — daemon serves a version newer than client knows.
      [1, 2, 3, 'version.server_too_old'],
      [1, 1, 2, 'version.server_too_old'],
      // Edge: client wants only a single version equal to server.
      [2, 2, 2, 'success'],
    ];
    for (const [clientMin, clientMaxKnown, serverProtoVersion, expected] of rows) {
      const got = negotiate({ clientMin, clientMaxKnown, serverProtoVersion });
      expect(got, `row clientMin=${clientMin} max=${clientMaxKnown} server=${serverProtoVersion}`).toBe(expected);
    }
  });

  it('ErrorDetail shape carries the negotiation failure codes (data shape only)', () => {
    // Exercises the CONTRACT that Hello rejection surfaces a structured
    // ErrorDetail with `code = "version.client_too_old"` and
    // `extra["daemon_proto_version"]`. The actual ConnectError attachment
    // path is T2.3 #33; this file pins only the proto shape consumed there.
    const detail = create(ErrorDetailSchema, {
      code: 'version.client_too_old',
      message: 'Daemon serves proto v1; client minimum is v3.',
      extra: { daemon_proto_version: '1' },
    });
    const decoded = fromBinary(ErrorDetailSchema, toBinary(ErrorDetailSchema, detail));
    expect(decoded.code).toBe('version.client_too_old');
    expect(decoded.extra['daemon_proto_version']).toBe('1');

    // Symmetric inverse — same shape, used by client-side upgrade logic
    // when the daemon advertises a newer proto_version than the client
    // knows about. Not emitted by daemon over the wire today but the
    // string is reserved at the contract level for symmetry / discoverability.
    const inverse = create(ErrorDetailSchema, {
      code: 'version.server_too_old',
      message: 'Client knows proto up to v2; daemon serves v3.',
      extra: { client_max_known: '2' },
    });
    const inverseDecoded = fromBinary(ErrorDetailSchema, toBinary(ErrorDetailSchema, inverse));
    expect(inverseDecoded.code).toBe('version.server_too_old');
  });
});
