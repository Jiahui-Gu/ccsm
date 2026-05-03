// SessionService.Hello handler — version negotiation + listener-id surfacing.
// Spec ch04 §3 (Hello{Request,Response} shape) + ch02 §6 (one-directional
// version negotiation) + ch04 §2 (ErrorDetail on rejection).
//
// T2.3 scope: replace the T2.2 empty `{}` stub for SessionService.Hello with
// a real handler. Three responsibilities:
//   1. validate `RequestMeta.request_id` is non-empty (ch04 §2 — F7 rule
//      "Daemon MUST NOT silently synthesize"); reject with INVALID_ARGUMENT
//      and ErrorDetail.code = "request.missing_id";
//   2. validate the client's `proto_min_version` is <= the daemon's
//      `PROTO_VERSION`; reject too-old clients with FAILED_PRECONDITION and
//      ErrorDetail.code = "version.client_too_old", carrying
//      extra["daemon_proto_version"] so the client can decide whether to
//      upgrade (ch02 §6 + ch04 §3);
//   3. surface the daemon-derived `listener_id` ("A" for Listener A on
//      v0.3) and the per-call `Principal` echo onto the HelloResponse.
//
// SRP layering — three roles, kept separate:
//   - decider: `decideHello(req, ctx)` — pure function `(req, ctx) → verdict`.
//     No I/O, no Connect plumbing, no `ConnectError`. Returns a tagged-union
//     verdict so callers (and unit tests) can introspect the decision
//     before any side effect. Spec test ref `proto/proto-min-version-truth-table.spec.ts`
//     exercises this directly via the truth table.
//   - sink:    `makeHelloHandler(deps)` — wraps the decider in the Connect
//     handler signature `(req, handlerContext) → HelloResponse | throws
//     ConnectError`. The only place `ConnectError` is constructed.
//   - producer: caller (router wiring in `./router.ts`) supplies the
//     `HelloDeps` (daemonVersion / protoVersion / listenerId / Listener-A
//     descriptor accessor / boot-id reader). Producer composition is the
//     daemon-startup wiring's responsibility (T1.7), not this module's.
//
// What this file is NOT:
//   - principal-derivation: that is `auth/interceptor.ts`'s
//     `peerCredAuthInterceptor`, which deposits the `Principal` under
//     `PRINCIPAL_KEY` BEFORE this handler runs. The handler reads the
//     deposited principal and translates it to the proto `Principal`
//     oneof shape.
//   - boot_id surfacing: the spec ch03 §3.3 "Hello-echo boot_id" mechanism
//     references a `boot_id` field that does NOT exist on the current
//     `HelloResponse` proto (fields 1-5: meta / daemon_version /
//     proto_version / principal / listener_id — no boot_id slot, no
//     `reserved 6`). The forever-stable `session.proto` would need a
//     coordinated additive bump (lock.json + PROTO_VERSION + electron
//     client mirror) to add it; that is its own task and is intentionally
//     out of scope here. See PR body for the push-back.
//
// Layer 1 — alternatives checked:
//   - We could thread `(daemonVersion, protoVersion, listenerId)` as
//     plain function args into a single closure. Rejected: the daemon's
//     version + proto version are process-global constants
//     (`PROTO_VERSION` from `@ccsm/proto`, daemon semver from package
//     metadata), but the listener-id and the future boot-id are
//     descriptor-level — bundling all four into a `HelloDeps` shape
//     keeps the call site (router wiring) symmetric with the other RPC
//     handlers that will land in T3.x / T4.x.
//   - We could read `PROTO_VERSION` directly inside the decider. Rejected:
//     the decider must be pure — taking it as a context arg lets unit
//     tests pin a specific version without monkey-patching the @ccsm/proto
//     re-export.
//   - The Connect router's "unimplemented for absent method" behavior
//     (ch04 §3 footnote) means this handler simply replaces the empty
//     stub `{}` for SessionService.Hello in `./router.ts`'s opt-in
//     `makeDaemonRoutes(deps)` factory. The plain `stubRoutes` (no deps)
//     remains untouched so the T2.2 `router.spec.ts` and
//     `__tests__/integration.spec.ts` over-the-wire Unimplemented assertions
//     still hold.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  ErrorDetailSchema,
  HelloResponseSchema,
  LocalUserSchema,
  PrincipalSchema,
  RequestMetaSchema,
  SessionService,
  type HelloRequest,
  type HelloResponse,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../auth/index.js';

/**
 * Stable per-listener identifier surfaced on `HelloResponse.listener_id`.
 * Spec ch04 §3 + the schema migration table row "HelloResponse.listener_id
 * string values" — v0.3 always emits `"A"`; v0.4 Listener B emits `"B"`.
 * Open string set on the wire; clients tolerate unknown values.
 *
 * Exported as a typed constant (not a magic string) so the call-site
 * wiring in `./router.ts` and the daemon-startup composition (T1.7) both
 * read from one place. This is also the value the daemon writes into
 * `listener-a.json`'s analogous fields (descriptor's `listener_addr` is
 * the bind address, not the id; the id discriminates which listener
 * handled the call when v0.4 ships Listener B).
 */
export const LISTENER_A_HELLO_ID = 'A' as const;

/**
 * Inputs the Hello handler needs to assemble a response. Pure-data shape
 * (no functions) so unit tests can construct it inline without mocks.
 *
 * Field semantics:
 *   - `daemonVersion` — daemon semver string surfaced on
 *     `HelloResponse.daemon_version`. Spec ch04 §3 — informational, the
 *     wire-stable contract is `proto_version`, not this string.
 *   - `protoVersion` — daemon's current `PROTO_VERSION` (`@ccsm/proto`).
 *     Used both as the negotiation ceiling (decider compares
 *     `client.proto_min_version <= protoVersion`) and as the value
 *     surfaced on `HelloResponse.proto_version`.
 *   - `listenerId` — which listener answered; v0.3 Listener A always
 *     passes `LISTENER_A_HELLO_ID` (`"A"`).
 */
export interface HelloDeps {
  readonly daemonVersion: string;
  readonly protoVersion: number;
  readonly listenerId: string;
}

/**
 * Decider verdict — discriminated union so unit tests can assert on the
 * chosen branch without parsing a `ConnectError` shape (the sink layer's
 * concern). Three terminals:
 *
 *   - `kind: 'ok'`   — accept; `response` is the full `HelloResponse`
 *                      ready for wire encode.
 *   - `kind: 'invalid_argument'` — reject; `code` / `message` populate
 *                      the `ErrorDetail` and the ConnectError text. v0.3
 *                      uses this exclusively for the request_id missing
 *                      check (`code: "request.missing_id"`).
 *   - `kind: 'failed_precondition'` — reject; ditto for the version
 *                      negotiation (`code: "version.client_too_old"`),
 *                      with an `extra` map carrying the daemon's
 *                      `proto_version` so the client can tell the user
 *                      to upgrade.
 *
 * Why three branches, not one "reject with code" branch: the Connect
 * status code (`INVALID_ARGUMENT` vs `FAILED_PRECONDITION`) is a wire
 * decision per spec ch04 §3 wording — encoding it in the verdict's
 * discriminant keeps the sink mechanical (`switch (verdict.kind)` →
 * `Code.X`) and pushes the choice into the decider where it belongs.
 */
export type HelloVerdict =
  | { readonly kind: 'ok'; readonly response: HelloResponse }
  | {
      readonly kind: 'invalid_argument';
      readonly code: 'request.missing_id';
      readonly message: string;
      readonly extra: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'failed_precondition';
      readonly code: 'version.client_too_old';
      readonly message: string;
      readonly extra: Readonly<Record<string, string>>;
    };

/**
 * Pure decider. No I/O, no `ConnectError`, no contextValues access — the
 * `principal` is passed in (the sink reads `PRINCIPAL_KEY` and threads it
 * here). Spec refs: ch04 §3 (negotiation contract) + ch02 §6 (one-directional
 * negotiation: daemon does NOT push a `min_compatible_client` value back).
 *
 * Validation ordering matches the spec test suite expectations:
 *   1. `meta.request_id` non-empty — F7 universal rule, applied to every
 *      RPC. Empty `request_id` is the FIRST gate so a malformed client
 *      never reaches the version-negotiation branch and confuses the
 *      operator about which contract was violated.
 *   2. `proto_min_version <= protoVersion` — too-old clients are rejected
 *      with the structured `version.client_too_old` detail. The strictly
 *      `>` comparison surfaces the "client wants a newer proto than the
 *      daemon speaks" case as the rejection. Older clients (lower
 *      `proto_min_version`) are accepted — the daemon supports back-compat
 *      as long as its current `protoVersion` meets the client's floor.
 *   3. otherwise — accept; build `HelloResponse` echoing meta, populating
 *      daemon_version / proto_version / listener_id, and translating the
 *      in-process `AuthPrincipal` into the proto `Principal` oneof.
 */
export function decideHello(
  req: HelloRequest,
  ctx: HelloDeps & { readonly principal: AuthPrincipal },
): HelloVerdict {
  const requestId = req.meta?.requestId ?? '';
  if (requestId.length === 0) {
    return {
      kind: 'invalid_argument',
      code: 'request.missing_id',
      message:
        'HelloRequest.meta.request_id MUST be a non-empty client-generated UUIDv4 (spec ch04 §2)',
      extra: {},
    };
  }

  if (req.protoMinVersion > ctx.protoVersion) {
    return {
      kind: 'failed_precondition',
      code: 'version.client_too_old',
      message:
        `client requires proto_min_version=${req.protoMinVersion} but ` +
        `daemon speaks proto_version=${ctx.protoVersion} ` +
        '(spec ch02 §6 + ch04 §3 — version negotiation is one-directional; ' +
        'client decides upgrade based on daemon_proto_version)',
      // Spec ch04 §3 names the key explicitly: `extra["daemon_proto_version"]
      // = <int>`. Stringify because `ErrorDetail.extra` is `map<string, string>`.
      extra: { daemon_proto_version: String(ctx.protoVersion) },
    };
  }

  const response = create(HelloResponseSchema, {
    // Echo `meta` so the client's request/response correlation in
    // structured logs lines up. We forward the full RequestMeta fields
    // we observed (request_id is the only one daemon validates; client_version
    // and client_send_unix_ms are observability echoes).
    meta: create(RequestMetaSchema, {
      requestId,
      clientVersion: req.meta?.clientVersion ?? '',
      clientSendUnixMs: req.meta?.clientSendUnixMs ?? 0n,
    }),
    daemonVersion: ctx.daemonVersion,
    protoVersion: ctx.protoVersion,
    principal: authPrincipalToProto(ctx.principal),
    listenerId: ctx.listenerId,
  });

  return { kind: 'ok', response };
}

/**
 * Translate the in-process `AuthPrincipal` (`auth/principal.ts`) into the
 * proto `Principal` oneof shape (`@ccsm/proto`'s `LocalUser local_user = 1`
 * variant). v0.3 only ships `local-user`; the switch-default throws so a
 * future v0.4 `cf-access` variant on the in-process side without a
 * matching update here fails loud.
 */
function authPrincipalToProto(p: AuthPrincipal): ReturnType<typeof create<typeof PrincipalSchema>> {
  switch (p.kind) {
    case 'local-user': {
      return create(PrincipalSchema, {
        kind: {
          case: 'localUser',
          value: create(LocalUserSchema, {
            uid: p.uid,
            displayName: p.displayName,
          }),
        },
      });
    }
    default: {
      const _exhaustive: never = p.kind;
      throw new Error(
        `unhandled AuthPrincipal kind in Hello handler: ${String(_exhaustive)}`,
      );
    }
  }
}

/**
 * Build the Connect `ServiceImpl<typeof SessionService>['hello']` handler
 * — the sink layer. Reads `PRINCIPAL_KEY` from the `HandlerContext` (the
 * `peerCredAuthInterceptor` deposited it before this runs); throws
 * `Unauthenticated` if the interceptor wiring is missing (defensive — the
 * spec ch05 §2 invariant is "every handler reads `ctx.principal` and
 * assumes it is set", and the missing-principal sentinel is `null` per
 * `auth/interceptor.ts`).
 *
 * The decider's verdict is mapped to wire shapes here:
 *   - `ok`                     → return `HelloResponse`
 *   - `invalid_argument`       → throw `ConnectError(INVALID_ARGUMENT)`
 *                                with an `ErrorDetail` outgoing detail
 *   - `failed_precondition`    → throw `ConnectError(FAILED_PRECONDITION)`
 *                                with an `ErrorDetail` outgoing detail
 *
 * Outgoing details use the `{ desc, value }` shape Connect-ES v2 expects
 * for server-side error details (see `ConnectError` constructor signature
 * in `@connectrpc/connect/dist/esm/connect-error.d.ts`).
 */
export function makeHelloHandler(
  deps: HelloDeps,
): ServiceImpl<typeof SessionService>['hello'] {
  return (req: HelloRequest, handlerContext: HandlerContext): HelloResponse => {
    const principal = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      // Defensive — the peerCredAuthInterceptor MUST have run and set
      // PRINCIPAL_KEY before this handler executes. If we observe `null`,
      // the interceptor was not installed in the chain (a wiring bug,
      // not an auth failure of the caller). We surface as Internal so
      // operators see a daemon-side bug indicator rather than the client
      // being told they are unauthenticated.
      throw new ConnectError(
        'Hello handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }

    const verdict = decideHello(req, { ...deps, principal });
    switch (verdict.kind) {
      case 'ok':
        return verdict.response;
      case 'invalid_argument':
        throw new ConnectError(verdict.message, Code.InvalidArgument, undefined, [
          {
            desc: ErrorDetailSchema,
            value: {
              code: verdict.code,
              message: verdict.message,
              extra: { ...verdict.extra },
            },
          },
        ]);
      case 'failed_precondition':
        throw new ConnectError(
          verdict.message,
          Code.FailedPrecondition,
          undefined,
          [
            {
              desc: ErrorDetailSchema,
              value: {
                code: verdict.code,
                message: verdict.message,
                extra: { ...verdict.extra },
              },
            },
          ],
        );
      default: {
        const _exhaustive: never = verdict;
        throw new Error(
          `unhandled HelloVerdict kind: ${String((_exhaustive as { kind: string }).kind)}`,
        );
      }
    }
  };
}
