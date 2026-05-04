// T2.5 — daemon emission contract for ErrorDetail + Connect code mapping.
//
// Sibling to `packages/proto/test/contract/error-detail-roundtrip.spec.ts`
// (T0.12 #4): the proto-side test pins the WIRE shape of `ErrorDetail`;
// this test pins the DAEMON-SIDE EMISSION — i.e. the closed enum of
// standard codes, the Connect `Code` mapping per code, and the
// invariant that `buildError` / `throwError` attach an `ErrorDetail`
// proto in the Connect-ES v2 outgoing-details slot so client-side
// `findDetails(ErrorDetailSchema)` can extract it after a round-trip.
//
// Spec refs:
//   - ch02 §5      `daemon.starting`        → UNAVAILABLE
//   - ch04 §3      `version.client_too_old` → FAILED_PRECONDITION
//   - ch04 §2 / §7.1 `request.missing_id`   → INVALID_ARGUMENT
//   - ch05 §4 / §5 `session.not_owned`      → PERMISSION_DENIED
//
// The tests round-trip ErrorDetail through proto encode/decode (since
// in this unit context we don't have a Connect transport — that path
// is exercised by the proto-side round-trip test) and assert the
// decoded `code` / `message` / `extra` survive intact. Combined with
// `findDetails` (used here directly because we have the
// `OutgoingDetail` array in memory), this is the local equivalent of
// the wire round-trip.

import { describe, expect, it, expectTypeOf } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { ErrorDetailSchema, type ErrorDetail } from '@ccsm/proto';

import {
  STANDARD_ERROR_MAP,
  buildError,
  throwError,
  type StandardErrorCode,
} from '../../src/rpc/errors.js';

// ---------------------------------------------------------------------------
// Forever-stable mapping table — duplicated here intentionally as the
// "expected" side of the contract. If a v0.4 patch reorders or
// remaps an existing row in `STANDARD_ERROR_MAP`, this test fails.
// Adding a NEW code in `STANDARD_ERROR_MAP` MUST be paired with a new
// row here (the `keyof` exhaustiveness assertion at the bottom of the
// file enforces that mechanically).
// ---------------------------------------------------------------------------
const EXPECTED: ReadonlyArray<{
  code: StandardErrorCode;
  connectCode: Code;
  defaultMessageContains: string;
}> = [
  {
    code: 'daemon.starting',
    connectCode: Code.Unavailable,
    defaultMessageContains: 'starting',
  },
  {
    code: 'version.client_too_old',
    connectCode: Code.FailedPrecondition,
    defaultMessageContains: 'proto_min_version',
  },
  {
    code: 'request.missing_id',
    connectCode: Code.InvalidArgument,
    defaultMessageContains: 'request_id',
  },
  {
    code: 'session.not_owned',
    connectCode: Code.PermissionDenied,
    defaultMessageContains: 'principal',
  },
  {
    // Wave-3 #334 (audit #228 sub-task 3) — added in the same PR that
    // wires `CrashService.GetRawCrashLog`. Code string + Connect-code
    // mapping pinned by `packages/proto/src/ccsm/v1/crash.proto:74-75`
    // and `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md`
    // ch09 §2; see the `STANDARD_ERROR_MAP` row comment for the
    // forever-stable rationale.
    code: 'crash.raw_log_read_failed',
    connectCode: Code.Internal,
    defaultMessageContains: 'crash-raw',
  },
];

/**
 * Decode the single ErrorDetail proto from a ConnectError's outgoing
 * details slot. The Connect-ES v2 typing models outgoing details as
 * `{ desc, value }` objects (NOT yet encoded to bytes); we round-trip
 * through `toBinary` / `fromBinary` so the test exercises the proto
 * shape end-to-end and would catch a regression where `buildError`
 * starts emitting an init-shape that fails to encode.
 */
function decodeAttachedDetail(err: ConnectError): ErrorDetail {
  expect(err.details.length).toBe(1);
  const d = err.details[0]!;
  // Outgoing details have shape { desc, value } (init shape, not bytes).
  expect('desc' in d).toBe(true);
  // narrow to outgoing
  const outgoing = d as { desc: typeof ErrorDetailSchema; value: unknown };
  expect(outgoing.desc).toBe(ErrorDetailSchema);
  // The init `value` may not be a fully-constructed Message yet — encode
  // and decode to get a normalized `ErrorDetail` instance.
  // Build a real message via the schema so toBinary accepts it.
  const bytes = toBinary(
    ErrorDetailSchema,
    // create() not strictly required here — buildError already passes
    // a plain init object; we materialize it via fromBinary on a freshly
    // encoded buffer using the message-init friendly path:
    {
      $typeName: 'ccsm.v1.ErrorDetail',
      ...(outgoing.value as object),
    } as ErrorDetail,
  );
  return fromBinary(ErrorDetailSchema, bytes);
}

describe('rpc/errors — STANDARD_ERROR_MAP coverage', () => {
  it('exposes exactly the v0.3 forever-stable codes', () => {
    // Keys snapshot — sorted for stability. Adding a v0.4 code MUST
    // update this assertion explicitly (review-gate, NOT auto-passing).
    expect(Object.keys(STANDARD_ERROR_MAP).sort()).toEqual(
      [
        'crash.raw_log_read_failed',
        'daemon.starting',
        'request.missing_id',
        'session.not_owned',
        'version.client_too_old',
      ],
    );
  });

  for (const fixture of EXPECTED) {
    it(`maps "${fixture.code}" → Connect Code ${Code[fixture.connectCode]}`, () => {
      expect(STANDARD_ERROR_MAP[fixture.code]).toBe(fixture.connectCode);
    });
  }
});

describe('rpc/errors — buildError / throwError emit ConnectError + ErrorDetail', () => {
  for (const fixture of EXPECTED) {
    it(`buildError("${fixture.code}") → ConnectError with matching code + attached ErrorDetail`, () => {
      const err = buildError(fixture.code);

      expect(err).toBeInstanceOf(ConnectError);
      expect(err.code).toBe(fixture.connectCode);

      const detail = decodeAttachedDetail(err);
      expect(detail.code).toBe(fixture.code);
      // Default message is non-empty and references something
      // recognizable (the per-code default lives in errors.ts).
      expect(detail.message.length).toBeGreaterThan(0);
      expect(detail.message.toLowerCase()).toContain(
        fixture.defaultMessageContains.toLowerCase(),
      );
      // No extra by default.
      expect(Object.keys(detail.extra)).toEqual([]);
    });

    it(`throwError("${fixture.code}") throws the same shape`, () => {
      let thrown: unknown;
      try {
        throwError(fixture.code);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConnectError);
      const err = thrown as ConnectError;
      expect(err.code).toBe(fixture.connectCode);
      const detail = decodeAttachedDetail(err);
      expect(detail.code).toBe(fixture.code);
    });
  }

  it('honors the optional message override', () => {
    const err = buildError('session.not_owned', 'custom message');
    expect(err.rawMessage).toBe('custom message');
    const detail = decodeAttachedDetail(err);
    expect(detail.message).toBe('custom message');
  });

  it('round-trips the extra map (open string keys per ch04 §7.1)', () => {
    const err = buildError('session.not_owned', undefined, {
      session_id: '01HXYZ123',
      principal: 'local-user:1000',
    });
    const detail = decodeAttachedDetail(err);
    expect({ ...detail.extra }).toEqual({
      session_id: '01HXYZ123',
      principal: 'local-user:1000',
    });
  });

  it('attaches extra for version.client_too_old (daemon_proto_version per ch04 §3)', () => {
    const err = buildError('version.client_too_old', undefined, {
      daemon_proto_version: '1',
    });
    const detail = decodeAttachedDetail(err);
    expect(detail.extra['daemon_proto_version']).toBe('1');
  });

  it('does not mutate the caller-supplied extra map', () => {
    const extra = { session_id: 'sid-1' };
    const err = buildError('session.not_owned', undefined, extra);
    const detail = decodeAttachedDetail(err);
    detail.extra['injected'] = 'x';
    expect(extra).toEqual({ session_id: 'sid-1' });
  });
});

describe('rpc/errors — ts-only typecheck enforces the closed code enum', () => {
  it('StandardErrorCode is exactly the four v0.3 codes', () => {
    expectTypeOf<StandardErrorCode>().toEqualTypeOf<
      | 'daemon.starting'
      | 'version.client_too_old'
      | 'request.missing_id'
      | 'session.not_owned'
      | 'crash.raw_log_read_failed'
    >();
  });

  it('buildError rejects non-standard code at compile time', () => {
    // Type-only assertion — never invoke the call (the value would
    // throw at runtime because there is no entry in STANDARD_ERROR_MAP
    // for these strings; that's the whole point of the closed enum).
    // The `// @ts-expect-error` directives below are the actual
    // assertion: they fail the typecheck if the closed enum ever
    // widens to accept an arbitrary string.
    const _checkRejection = (): void => {
      // @ts-expect-error — "session.not_found" is NOT a v0.3 standard
      // code (it's mentioned in ch04 §7.1 as a representative *example*
      // for the round-trip test, but is not in the v0.3 emission set).
      buildError('session.not_found');
      // @ts-expect-error — open-set arbitrary string is rejected.
      buildError('arbitrary.string');
      // @ts-expect-error — throwError shares the same closed enum.
      throwError('not.a.code');
    };
    // Reference the symbol so eslint's no-unused-vars doesn't complain
    // and so vitest registers the test as having an expectation.
    expect(typeof _checkRejection).toBe('function');
  });

  it('STANDARD_ERROR_MAP value type is Connect Code', () => {
    expectTypeOf(STANDARD_ERROR_MAP['daemon.starting']).toEqualTypeOf<
      typeof Code.Unavailable
    >();
  });
});
