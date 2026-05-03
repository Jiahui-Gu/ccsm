// SessionService.Hello handler — T2.3 spec.
//
// Covers:
//   - happy path: client_api_version compatible (proto_min_version <=
//     daemon's PROTO_VERSION) -> response with listener_id + principal
//     + meta echo + daemon_version + proto_version.
//   - too-old client: client.proto_min_version > daemon.PROTO_VERSION
//     -> ConnectError(FailedPrecondition) with ErrorDetail
//     code = "version.client_too_old" and extra["daemon_proto_version"]
//     = String(daemon.PROTO_VERSION).
//   - request_id missing: empty meta.request_id -> ConnectError(InvalidArgument)
//     with ErrorDetail code = "request.missing_id" (spec ch04 §2 F7).
//   - pure-decider tests: drive `decideHello(req, ctx)` directly with
//     synthesized `(req, ctx)` shapes; no Connect plumbing, no I/O.
//   - over-the-wire (in-process router transport): drives the bound
//     handler through `createRouterTransport` to verify the
//     `ConnectError` shape (code + ErrorDetail attached) survives the
//     decider->sink->wire conversion. Real http2 socket coverage is
//     deferred to the `__tests__/integration.spec.ts` end-to-end tests
//     in T2.x integration scope (T2.3 ships the handler; T2.4+ cover
//     the wire integration matrix).
//
// Why under `test/rpc/` (not `src/rpc/__tests__/`): per
// `packages/daemon/vitest.config.ts` the `test/**/*.spec.ts` glob is the
// out-of-tree integration / contract layer; the cross-module fixtures
// here (proto schemas + auth Principal type + Connect router transport)
// match that layer's purpose. Pure-source unit specs co-locate as
// `__tests__/` next to source — those would be appropriate if the
// decider lived in isolation, but the spec-mandated test name is
// `packages/daemon/test/rpc/hello.spec.ts` (manager prompt) so we
// honor that path verbatim.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
} from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import {
  ErrorDetailSchema,
  HelloRequestSchema,
  PROTO_VERSION,
  RequestMetaSchema,
  SessionService,
  type ErrorDetail,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../../src/auth/index.js';
import {
  LISTENER_A_HELLO_ID,
  decideHello,
  makeHelloHandler,
  type HelloDeps,
} from '../../src/rpc/hello.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_DAEMON_VERSION = '0.3.0-test';

const TEST_PRINCIPAL: AuthPrincipal = {
  kind: 'local-user',
  uid: '1000',
  displayName: 'alice',
};

const BASE_DEPS: HelloDeps = {
  daemonVersion: TEST_DAEMON_VERSION,
  protoVersion: PROTO_VERSION,
  listenerId: LISTENER_A_HELLO_ID,
};

function makeReq(overrides: {
  readonly requestId?: string;
  readonly clientKind?: string;
  readonly protoMinVersion?: number;
  readonly clientVersion?: string;
  readonly clientSendUnixMs?: bigint;
}): ReturnType<typeof create<typeof HelloRequestSchema>> {
  return create(HelloRequestSchema, {
    meta: create(RequestMetaSchema, {
      requestId: overrides.requestId ?? '11111111-2222-3333-4444-555555555555',
      clientVersion: overrides.clientVersion ?? '0.3.0',
      clientSendUnixMs: overrides.clientSendUnixMs ?? 1_700_000_000_000n,
    }),
    clientKind: overrides.clientKind ?? 'electron',
    protoMinVersion: overrides.protoMinVersion ?? PROTO_VERSION,
  });
}

// ---------------------------------------------------------------------------
// Pure-decider tests — no I/O, no Connect plumbing
// ---------------------------------------------------------------------------

describe('decideHello — pure decider', () => {
  it('happy path: returns ok verdict with full HelloResponse', () => {
    const req = makeReq({ protoMinVersion: PROTO_VERSION });
    const verdict = decideHello(req, { ...BASE_DEPS, principal: TEST_PRINCIPAL });

    expect(verdict.kind).toBe('ok');
    if (verdict.kind !== 'ok') return; // type narrow
    expect(verdict.response.daemonVersion).toBe(TEST_DAEMON_VERSION);
    expect(verdict.response.protoVersion).toBe(PROTO_VERSION);
    expect(verdict.response.listenerId).toBe(LISTENER_A_HELLO_ID);

    // Meta echo — request_id matches, optional fields preserved.
    expect(verdict.response.meta?.requestId).toBe(
      '11111111-2222-3333-4444-555555555555',
    );
    expect(verdict.response.meta?.clientVersion).toBe('0.3.0');
    expect(verdict.response.meta?.clientSendUnixMs).toBe(1_700_000_000_000n);

    // Principal echo — proto Principal oneof carries LocalUser variant.
    expect(verdict.response.principal?.kind?.case).toBe('localUser');
    if (verdict.response.principal?.kind?.case !== 'localUser') return;
    expect(verdict.response.principal.kind.value.uid).toBe('1000');
    expect(verdict.response.principal.kind.value.displayName).toBe('alice');
  });

  it('older client (proto_min_version < daemon proto_version) is accepted', () => {
    // Spec ch02 §6: only the strictly-greater client floor is rejected.
    // A client whose floor is BELOW the daemon's current version is the
    // common back-compat path.
    const req = makeReq({ protoMinVersion: 0 });
    const verdict = decideHello(req, { ...BASE_DEPS, principal: TEST_PRINCIPAL });
    expect(verdict.kind).toBe('ok');
  });

  it('exact-match (proto_min_version === daemon proto_version) is accepted', () => {
    const req = makeReq({ protoMinVersion: PROTO_VERSION });
    const verdict = decideHello(req, { ...BASE_DEPS, principal: TEST_PRINCIPAL });
    expect(verdict.kind).toBe('ok');
  });

  it('too-old client: returns failed_precondition + version.client_too_old', () => {
    const req = makeReq({ protoMinVersion: PROTO_VERSION + 1 });
    const verdict = decideHello(req, { ...BASE_DEPS, principal: TEST_PRINCIPAL });

    expect(verdict.kind).toBe('failed_precondition');
    if (verdict.kind !== 'failed_precondition') return;
    expect(verdict.code).toBe('version.client_too_old');
    expect(verdict.extra.daemon_proto_version).toBe(String(PROTO_VERSION));
  });

  it('empty request_id: returns invalid_argument + request.missing_id', () => {
    const req = makeReq({ requestId: '' });
    const verdict = decideHello(req, { ...BASE_DEPS, principal: TEST_PRINCIPAL });

    expect(verdict.kind).toBe('invalid_argument');
    if (verdict.kind !== 'invalid_argument') return;
    expect(verdict.code).toBe('request.missing_id');
  });

  it('open-set client_kind values are accepted unmodified', () => {
    // Spec ch04 §3 + ch15 §3: daemon MUST tolerate any UTF-8 string in
    // client_kind and MUST NOT branch behavior on it. Here we exercise
    // a value outside the v0.3 published `{electron, web, ios}` set.
    const req = makeReq({ clientKind: 'rust-cli' });
    const verdict = decideHello(req, { ...BASE_DEPS, principal: TEST_PRINCIPAL });
    expect(verdict.kind).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Sink wiring tests — through the in-process Connect router transport
// ---------------------------------------------------------------------------

/**
 * Build an in-process Connect transport whose `SessionService.Hello`
 * runs the T2.3 handler with `BASE_DEPS`. A SERVER-side interceptor
 * deposits `principal` under `PRINCIPAL_KEY` before the handler runs,
 * mirroring what `peerCredAuthInterceptor` does on a real connection.
 *
 * Server-side interceptors live under the router options
 * (`{ router: { interceptors: [...] } }`) because `ConnectRouterOptions
 * extends Partial<UniversalHandlerOptions>` which carries the
 * server-installed interceptor chain. Client-side `transport.interceptors`
 * fire on the request producer side and never reach the handler's
 * `HandlerContext.values`.
 */
function makeBoundTransport(principal: AuthPrincipal | null = TEST_PRINCIPAL) {
  return createRouterTransport(
    (router) => {
      router.service(SessionService, { hello: makeHelloHandler(BASE_DEPS) });
    },
    {
      router: {
        interceptors: [
          (next) => async (req) => {
            req.contextValues.set(PRINCIPAL_KEY, principal);
            return next(req);
          },
        ],
      },
    },
  );
}

describe('SessionService.Hello — in-process router transport', () => {
  it('happy path: returns HelloResponse with listener_id "A"', async () => {
    const transport = makeBoundTransport();
    const client = createClient(SessionService, transport);

    const resp = await client.hello({
      meta: {
        requestId: 'aaaa-bbbb',
        clientVersion: '0.3.0',
        clientSendUnixMs: 0n,
      },
      clientKind: 'electron',
      protoMinVersion: PROTO_VERSION,
    });

    expect(resp.listenerId).toBe(LISTENER_A_HELLO_ID);
    expect(resp.daemonVersion).toBe(TEST_DAEMON_VERSION);
    expect(resp.protoVersion).toBe(PROTO_VERSION);
    expect(resp.principal?.kind?.case).toBe('localUser');
  });

  it('too-old client: throws ConnectError(FailedPrecondition) + ErrorDetail', async () => {
    const transport = makeBoundTransport();
    const client = createClient(SessionService, transport);

    let captured: unknown = null;
    try {
      await client.hello({
        meta: {
          requestId: 'aaaa-bbbb',
          clientVersion: '0.3.0',
          clientSendUnixMs: 0n,
        },
        clientKind: 'electron',
        protoMinVersion: PROTO_VERSION + 1,
      });
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(ConnectError);
    const ce = captured as ConnectError;
    expect(ce.code).toBe(Code.FailedPrecondition);

    const details = ce.findDetails(ErrorDetailSchema) as ErrorDetail[];
    expect(details.length).toBeGreaterThanOrEqual(1);
    expect(details[0].code).toBe('version.client_too_old');
    expect(details[0].extra.daemon_proto_version).toBe(String(PROTO_VERSION));
  });

  it('missing request_id: throws ConnectError(InvalidArgument) + ErrorDetail', async () => {
    const transport = makeBoundTransport();
    const client = createClient(SessionService, transport);

    let captured: unknown = null;
    try {
      await client.hello({
        meta: {
          requestId: '',
          clientVersion: '0.3.0',
          clientSendUnixMs: 0n,
        },
        clientKind: 'electron',
        protoMinVersion: PROTO_VERSION,
      });
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(ConnectError);
    const ce = captured as ConnectError;
    expect(ce.code).toBe(Code.InvalidArgument);

    const details = ce.findDetails(ErrorDetailSchema) as ErrorDetail[];
    expect(details.length).toBeGreaterThanOrEqual(1);
    expect(details[0].code).toBe('request.missing_id');
  });

  it('handler missing peer-cred wiring: throws Internal (defensive)', async () => {
    // Simulate the wiring bug where peerCredAuthInterceptor never ran:
    // PRINCIPAL_KEY is the null sentinel default.
    const transport = createRouterTransport((router) => {
      router.service(SessionService, { hello: makeHelloHandler(BASE_DEPS) });
    });
    const client = createClient(SessionService, transport);

    let captured: unknown = null;
    try {
      await client.hello({
        meta: {
          requestId: 'aaaa-bbbb',
          clientVersion: '0.3.0',
          clientSendUnixMs: 0n,
        },
        clientKind: 'electron',
        protoMinVersion: PROTO_VERSION,
      });
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.Internal);
  });
});
