// RequestMeta validation interceptor — rejects RPCs whose `RequestMeta.request_id`
// is empty / whitespace-only with `ConnectError(InvalidArgument)` carrying an
// `ErrorDetail{code: "request.missing_id"}` outgoing detail.
//
// Spec refs:
//   - ch04 §2 — RequestMeta semantics. Forever-stable: every RPC carries a
//     `RequestMeta meta = 1` whose `request_id` is a client-generated UUIDv4.
//   - F7 (closes R4 P1) — daemon MUST validate `request_id` is non-empty on
//     every RPC. Daemon MUST NOT silently synthesize a substitute (would
//     break client-side correlation logs and hide a misbehaving client).
//
// SRP: this module is a pure *decider*. Inputs (the inbound message's
// `meta.requestId`) → decision (accept | reject). No I/O, no logging, no
// synthesis. Synthesis is explicitly forbidden by F7; the only "side effect"
// is the throw, which Connect translates into the wire error envelope.
//
// Why an interceptor (not per-handler validation): the validation rule is
// uniform across every RPC in `@ccsm/proto` (every Request message has a
// `RequestMeta meta = 1` field by ch04 §2 contract). Encoding the rule
// once in the router pipeline guarantees no future RPC can ship without
// the check — a per-handler `validateMeta(req.meta)` call would be a
// reviewer-grep-only invariant, not a mechanical one. This matches the
// existing `peerCredAuthInterceptor` pattern in `src/auth/interceptor.ts`
// (single decider, runs before any handler).
//
// Layer 1 — alternatives checked:
//   - Validate at the proto layer via a custom option / `optional` keyword:
//     rejected by `request-id-roundtrip.spec.ts` (T0.12) which pins that
//     the wire MUST allow empty `request_id` so middleware can observe and
//     reject. Adding `optional` would bypass this code path.
//   - Validate inside each handler: scope-creeps every L3+ handler PR.
//     Reviewers would have to grep for `meta.requestId` in every diff. An
//     interceptor is the standard Connect-ES seam for cross-cutting checks.
//   - Use `connect-validate` / `protovalidate-es`: heavyweight dep for a
//     single rule (non-empty trim) on a single field. v0.4 may revisit if
//     the rule set grows; v0.3 keeps it 30 LOC and dep-free.
//
// Streaming RPCs: `RequestMeta` lives on the FIRST inbound message. We wrap
// the request's `message` AsyncIterable so the first emitted value is
// validated before being forwarded to the handler. If validation fails the
// wrapped iterable throws on its first `.next()`, which surfaces to the
// handler as the same `ConnectError(InvalidArgument)` clients of unary RPCs
// see — uniform wire shape. We do not buffer subsequent messages; the
// iterable is a thin pass-through after the first message.

import {
  Code,
  ConnectError,
  type Interceptor,
  type StreamRequest,
  type UnaryRequest,
} from '@connectrpc/connect';
import {
  ErrorDetailSchema,
  RequestMetaSchema,
  type RequestMeta,
} from '@ccsm/proto';

/**
 * The forever-stable ErrorDetail.code emitted on rejection. Pinned by the
 * `error-detail-roundtrip.spec.ts` contract test (T0.12) — drift here MUST
 * be reflected in that fixture and in every client-side error handler.
 */
export const REQUEST_MISSING_ID_CODE = 'request.missing_id';

/**
 * Forever-stable rejection message attached to the ConnectError. Matches
 * the fixture in `request-id-roundtrip.spec.ts` so contract drift is a
 * mechanical test failure rather than a silent UX change.
 */
export const REQUEST_MISSING_ID_MESSAGE =
  'request_id is required and must be a non-empty UUIDv4.';

/**
 * Pure decider: returns `true` iff `requestId` is a non-empty, non-whitespace
 * string. Exported separately so tests can exercise the predicate without
 * going through the Connect interceptor plumbing.
 */
export function isValidRequestId(requestId: string | undefined | null): boolean {
  if (typeof requestId !== 'string') return false;
  // F7: trim before measuring length so a whitespace-only id (e.g. "  ")
  // is rejected the same as "". Clients that legitimately want an opaque
  // id can use UUIDv4 (the spec's recommended shape) which never trims to
  // empty. We do NOT enforce UUIDv4 syntax here — the rule from ch04 §2
  // is "non-empty"; UUIDv4 is the recommended client-side convention,
  // not a daemon-side validator (over-validation would reject clients
  // that legitimately use other id schemes the spec hasn't yet blessed).
  return requestId.trim().length > 0;
}

/**
 * Build the canonical "request.missing_id" ConnectError. Exported so tests
 * can compare against the exact shape the interceptor throws.
 */
export function makeMissingRequestIdError(): ConnectError {
  return new ConnectError(
    REQUEST_MISSING_ID_MESSAGE,
    Code.InvalidArgument,
    undefined,
    [
      {
        desc: ErrorDetailSchema,
        value: {
          code: REQUEST_MISSING_ID_CODE,
          message: REQUEST_MISSING_ID_MESSAGE,
          extra: {},
        },
      },
    ],
  );
}

/**
 * Extract the `RequestMeta` from a v0.3 request message. By ch04 §2 every
 * Request message carries `RequestMeta meta = 1`, surfaced in the
 * generated TS as `meta?: RequestMeta`. We probe duck-typed because the
 * interceptor receives `MessageShape<DescMessage>` (the open union over
 * every request type) — an exhaustive switch on every Request type would
 * couple this file to every service in `@ccsm/proto` and break the
 * "additive without code edits" promise of new RPCs.
 *
 * Returns `undefined` if the message has no `meta` field (which itself is
 * a contract violation — handled by the caller as a missing request_id).
 */
function extractMeta(message: unknown): RequestMeta | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const meta = (message as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  // Duck-type check: a generated RequestMeta has $typeName === RequestMetaSchema.typeName.
  // We don't import `isMessage` from @bufbuild/protobuf because the duck
  // check below is sufficient and avoids a runtime dep on the registry.
  const typeName = (meta as { $typeName?: unknown }).$typeName;
  if (typeName === RequestMetaSchema.typeName) {
    return meta as RequestMeta;
  }
  // Tolerate plain-object meta shapes (test harness convenience): if it
  // has a `requestId` string field we treat it as a meta. The interceptor
  // is a decider over `requestId`; further structural assertions belong
  // in the contract tests, not here.
  if (typeof (meta as { requestId?: unknown }).requestId === 'string') {
    return meta as RequestMeta;
  }
  return undefined;
}

/**
 * Validate a single inbound message's `RequestMeta.request_id`. Throws
 * `ConnectError(InvalidArgument)` with the canonical ErrorDetail if the
 * id is empty / whitespace / missing. F7: never synthesizes a substitute.
 */
export function validateRequestMeta(message: unknown): void {
  const meta = extractMeta(message);
  if (!meta || !isValidRequestId(meta.requestId)) {
    throw makeMissingRequestIdError();
  }
}

/**
 * Wrap a streaming request's `message` AsyncIterable so the first emitted
 * value is validated before being forwarded. Subsequent values pass
 * through unchanged. If the first value fails validation, the wrapped
 * iterable throws on its first `.next()` — Connect surfaces this to the
 * client as the same InvalidArgument ConnectError unary RPCs see.
 *
 * The handler never observes a synthesized id: if the source iterable
 * yields nothing (zero-message stream), nothing is emitted and validation
 * never runs. v0.3 has no zero-message client streaming RPCs (every
 * streaming method is server-streaming with a single request message,
 * see ch04 §3-§6), so this is the correct conservative choice.
 */
function validatedAsyncIterable<T>(
  source: AsyncIterable<T>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const inner = source[Symbol.asyncIterator]();
      let validated = false;
      return {
        async next(): Promise<IteratorResult<T>> {
          const result = await inner.next();
          if (!validated && !result.done) {
            validateRequestMeta(result.value);
            validated = true;
          }
          return result;
        },
        async return(value?: unknown): Promise<IteratorResult<T>> {
          if (typeof inner.return === 'function') {
            return inner.return(value);
          }
          return { done: true, value: undefined as never };
        },
        async throw(err?: unknown): Promise<IteratorResult<T>> {
          if (typeof inner.throw === 'function') {
            return inner.throw(err);
          }
          throw err;
        },
      };
    },
  };
}

/**
 * The Connect interceptor. Composed into the router's interceptor list
 * (see `router.ts` `createDaemonNodeAdapter`); runs BEFORE any handler so
 * a missing/empty `request_id` never reaches application code.
 *
 * Order vs. `peerCredAuthInterceptor`: the spec does not pin a strict
 * ordering between the two, but the chosen wiring (auth first, then
 * meta-validation) means an unauthenticated caller sees `Unauthenticated`
 * rather than `InvalidArgument` — matching the "auth is the outer ring"
 * convention. Both checks are cheap; the relative order does not affect
 * security (the daemon rejects either way before any handler runs).
 */
export const requestMetaInterceptor: Interceptor = (next) => async (req) => {
  if (!req.stream) {
    // Unary: the single request message is already materialized; validate
    // synchronously, then forward unchanged.
    validateRequestMeta((req as UnaryRequest).message);
    return next(req);
  }
  // Streaming: wrap the message iterable so validation runs on the first
  // emitted value. We intentionally construct a new request object via
  // spread (the `message` field is `readonly`) and forward it — Connect
  // accepts any object that satisfies the `StreamRequest` shape.
  const streamReq = req as StreamRequest;
  const wrapped: StreamRequest = {
    ...streamReq,
    message: validatedAsyncIterable(streamReq.message),
  };
  return next(wrapped);
};
