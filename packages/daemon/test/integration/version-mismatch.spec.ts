// packages/daemon/test/integration/version-mismatch.spec.ts
//
// T8.10 — integration spec: SessionService.Hello version negotiation
// (error path).
//
// Spec ch12 §3:
//   "version-mismatch.spec.ts — SessionService.Hello error path:
//    `proto_min_version` higher than daemon's; assert `FailedPrecondition`
//    with structured detail."
//
// Spec ch04 §3 (proto-min-version negotiation contract): when the
// client's `HelloRequest.proto_min_version` exceeds the daemon's
// `PROTO_VERSION`, the daemon MUST reject the handshake with
// `Code.FailedPrecondition` and attach an `ErrorDetail` with the
// forever-stable code `version.client_too_old` and an `extra` map carrying
// the daemon's actual `proto_version`. The client uses the structured
// detail (not the human message) to drive an upgrade prompt.
//
// Out of scope:
//   - The unit truth-table for proto-min-version negotiation lives in
//     `@ccsm/proto`'s `proto-min-version-truth-table.spec.ts` (ch12 §2).
//     This integration spec asserts only the *wire surface*: ConnectError
//     code + the byte shape of the attached ErrorDetail.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';

import {
  ErrorDetailSchema,
  HelloResponseSchema,
  PROTO_VERSION,
  SessionService,
} from '@ccsm/proto';

import { newRequestMeta, startHarness, type Harness } from './harness.js';

// ---------------------------------------------------------------------------
// Hello handler that enforces the proto-min-version contract. T2.2's real
// SessionService impl will own this; we stand in a minimal contract-shape
// version here so the wire assertion is meaningful even before T2.2 lands.
// Once T2.2 ships, the harness wiring stays the same and the handler can
// be replaced with the real implementation.
// ---------------------------------------------------------------------------

function helloEnforcingVersion(req: {
  protoMinVersion: number;
  clientKind: string;
}) {
  if (req.protoMinVersion > PROTO_VERSION) {
    // Spec ch04 §3: structured ErrorDetail.code MUST be
    // `version.client_too_old` and `extra.daemon_proto_version` MUST
    // be the daemon's PROTO_VERSION as a decimal string. Electron's
    // upgrade-prompt UX reads this map keys directly.
    throw new ConnectError(
      `client requires proto v${req.protoMinVersion}; daemon serves v${PROTO_VERSION}`,
      Code.FailedPrecondition,
      undefined,
      [
        {
          desc: ErrorDetailSchema,
          value: {
            code: 'version.client_too_old',
            message: 'Client proto_min_version exceeds daemon proto_version.',
            extra: {
              daemon_proto_version: String(PROTO_VERSION),
              client_proto_min_version: String(req.protoMinVersion),
            },
          },
        },
      ],
    );
  }
  return create(HelloResponseSchema, {
    meta: newRequestMeta(),
    daemonVersion: '0.3.0-test',
    protoVersion: PROTO_VERSION,
    listenerId: 'A',
  });
}

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({
    setup(router) {
      router.service(SessionService, {
        hello: helloEnforcingVersion,
      });
    },
  });
});

afterEach(async () => {
  await harness.stop();
});

// ---------------------------------------------------------------------------
// Happy-path control: proto_min_version <= PROTO_VERSION succeeds. Pinned
// alongside the error path so the rejection assertion cannot pass
// vacuously by, e.g., the handler always throwing.
// ---------------------------------------------------------------------------

describe('version-mismatch (ch04 §3)', () => {
  it('proto_min_version equal to daemon PROTO_VERSION succeeds', async () => {
    const client = harness.makeClient(SessionService);
    const res = await client.hello({
      meta: newRequestMeta(),
      clientKind: 'electron',
      protoMinVersion: PROTO_VERSION,
    });
    expect(res.protoVersion).toBe(PROTO_VERSION);
    expect(res.daemonVersion).toBe('0.3.0-test');
    expect(res.listenerId).toBe('A');
  });

  it('proto_min_version below daemon PROTO_VERSION succeeds (forever-additive contract)', async () => {
    const client = harness.makeClient(SessionService);
    const res = await client.hello({
      meta: newRequestMeta(),
      clientKind: 'electron',
      protoMinVersion: Math.max(0, PROTO_VERSION - 1),
    });
    expect(res.protoVersion).toBe(PROTO_VERSION);
  });

  // -----------------------------------------------------------------------
  // The error path the spec names.
  // -----------------------------------------------------------------------

  it('proto_min_version above daemon PROTO_VERSION → FailedPrecondition + version.client_too_old detail', async () => {
    const client = harness.makeClient(SessionService);
    const tooHigh = PROTO_VERSION + 1;
    try {
      await client.hello({
        meta: newRequestMeta(),
        clientKind: 'electron',
        protoMinVersion: tooHigh,
      });
      expect.fail('expected FailedPrecondition');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      const ce = err as ConnectError;
      expect(ce.code).toBe(Code.FailedPrecondition);

      // Structured detail is the load-bearing surface for the
      // Electron-side upgrade-prompt UX. Spec ch04 §3 + ch04 §7.1 #4.
      const details = ce.findDetails(ErrorDetailSchema);
      expect(details).toHaveLength(1);
      const detail = details[0];
      expect(detail.code).toBe('version.client_too_old');
      // The exact daemon proto_version value is the contract — Electron
      // shows the user "daemon supports up to v<N>".
      expect(detail.extra['daemon_proto_version']).toBe(String(PROTO_VERSION));
      expect(detail.extra['client_proto_min_version']).toBe(String(tooHigh));
    }
  });

  it('extreme client min-version still produces the same structured error code', async () => {
    // Defensive: a client that requests v999 (the v0.4 / v0.5 minor we
    // have not shipped) MUST receive the same `version.client_too_old`
    // code so the Electron upgrade prompt is uniform regardless of how
    // far ahead the client thinks it is.
    const client = harness.makeClient(SessionService);
    try {
      await client.hello({
        meta: newRequestMeta(),
        clientKind: 'electron',
        protoMinVersion: 999,
      });
      expect.fail('expected FailedPrecondition');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      const ce = err as ConnectError;
      expect(ce.code).toBe(Code.FailedPrecondition);
      const detail = ce.findDetails(ErrorDetailSchema)[0];
      expect(detail.code).toBe('version.client_too_old');
    }
  });
});
