// T2.4 (#37) — RequestMeta validation interceptor tests.
//
// Spec refs: ch04 §2 (RequestMeta semantics), F7 (no silent synthesis,
// canonical ErrorDetail.code = "request.missing_id"). The middleware
// itself is documented in `src/rpc/middleware/request-meta.ts`.
//
// Pure decider test style — we drive the interceptor with synthetic
// UnaryRequest / StreamRequest skeletons and a mock `next` to assert:
//
//   1. Empty `request_id` rejects with InvalidArgument + canonical
//      ErrorDetail; handler is NEVER called (no synthesis).
//   2. Whitespace-only `request_id` rejects identically (F7's "non-empty"
//      rule means "non-empty after trim", per the docstring on
//      `isValidRequestId`).
//   3. A valid (non-empty) `request_id` passes through; handler runs;
//      `meta.request_id` is unmodified (no rewrite).
//   4. A request with no `meta` at all rejects (contract violation —
//      every v0.3 Request message carries `RequestMeta meta = 1`).
//   5. Streaming requests: validation runs on the FIRST emitted message;
//      the wrapped iterable forwards subsequent messages unchanged.
//   6. The pure `isValidRequestId` predicate covers the boundary cases
//      (empty, whitespace, valid) without going through the interceptor.

import { describe, expect, it, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createContextValues,
  type StreamRequest,
  type StreamResponse,
  type UnaryRequest,
  type UnaryResponse,
} from '@connectrpc/connect';
import {
  ErrorDetailSchema,
  RequestMetaSchema,
  HelloRequestSchema,
  WatchSessionsRequestSchema,
} from '@ccsm/proto';

import {
  REQUEST_MISSING_ID_CODE,
  REQUEST_MISSING_ID_MESSAGE,
  isValidRequestId,
  makeMissingRequestIdError,
  requestMetaInterceptor,
  validateRequestMeta,
} from '../../../src/rpc/middleware/request-meta.js';

// ---- Pure decider: isValidRequestId ----------------------------------------

describe('isValidRequestId (pure predicate)', () => {
  it('returns false for empty string (F7 non-empty rule)', () => {
    expect(isValidRequestId('')).toBe(false);
  });

  it('returns false for whitespace-only strings (trim before measure)', () => {
    expect(isValidRequestId(' ')).toBe(false);
    expect(isValidRequestId('   ')).toBe(false);
    expect(isValidRequestId('\t\n')).toBe(false);
    expect(isValidRequestId(' ')).toBe(false); // NBSP
  });

  it('returns false for null / undefined / non-string types', () => {
    expect(isValidRequestId(null)).toBe(false);
    expect(isValidRequestId(undefined)).toBe(false);
    expect(isValidRequestId(123 as unknown as string)).toBe(false);
  });

  it('returns true for a canonical UUIDv4', () => {
    expect(isValidRequestId('7f3c1d8e-2b94-4f01-a5c6-d9e8b2a107c4')).toBe(true);
  });

  it('returns true for any non-whitespace string (no UUID syntax enforcement)', () => {
    // F7 says "non-empty"; we deliberately do NOT enforce UUIDv4 syntax
    // (over-validation would reject clients using other id schemes).
    expect(isValidRequestId('req-1')).toBe(true);
    expect(isValidRequestId('a')).toBe(true);
  });
});

// ---- makeMissingRequestIdError: canonical error shape ----------------------

describe('makeMissingRequestIdError (canonical ConnectError shape)', () => {
  it('uses Code.InvalidArgument', () => {
    const err = makeMissingRequestIdError();
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.code).toBe(Code.InvalidArgument);
  });

  it('carries the canonical ErrorDetail with code "request.missing_id"', () => {
    const err = makeMissingRequestIdError();
    const details = err.findDetails(ErrorDetailSchema);
    expect(details).toHaveLength(1);
    expect(details[0]?.code).toBe(REQUEST_MISSING_ID_CODE);
    expect(details[0]?.message).toBe(REQUEST_MISSING_ID_MESSAGE);
  });

  it('uses the canonical human-readable rejection message', () => {
    const err = makeMissingRequestIdError();
    expect(err.rawMessage).toBe(REQUEST_MISSING_ID_MESSAGE);
  });
});

// ---- validateRequestMeta: standalone decider over a message ----------------

describe('validateRequestMeta (standalone decider)', () => {
  it('throws on a request with empty request_id', () => {
    const msg = create(HelloRequestSchema, {
      meta: create(RequestMetaSchema, { requestId: '' }),
      clientKind: 'electron',
    });
    expect(() => validateRequestMeta(msg)).toThrow(ConnectError);
  });

  it('throws on a request with whitespace-only request_id', () => {
    const msg = create(HelloRequestSchema, {
      meta: create(RequestMetaSchema, { requestId: '   ' }),
      clientKind: 'electron',
    });
    expect(() => validateRequestMeta(msg)).toThrow(ConnectError);
  });

  it('does not throw on a valid request_id', () => {
    const msg = create(HelloRequestSchema, {
      meta: create(RequestMetaSchema, { requestId: 'abc' }),
      clientKind: 'electron',
    });
    expect(() => validateRequestMeta(msg)).not.toThrow();
  });

  it('throws on a message with no meta field at all (contract violation)', () => {
    expect(() => validateRequestMeta({ clientKind: 'electron' })).toThrow(
      ConnectError,
    );
  });

  it('throws on null / non-object messages', () => {
    expect(() => validateRequestMeta(null)).toThrow(ConnectError);
    expect(() => validateRequestMeta(undefined)).toThrow(ConnectError);
    expect(() => validateRequestMeta('not-a-message')).toThrow(ConnectError);
  });
});

// ---- requestMetaInterceptor: end-to-end behavior ---------------------------

type AnyReq = UnaryRequest | StreamRequest;
type AnyResp = UnaryResponse | StreamResponse;

function makeUnaryNext(): ReturnType<typeof vi.fn<(r: AnyReq) => Promise<AnyResp>>> {
  return vi.fn(
    async (r: AnyReq): Promise<AnyResp> => ({
      stream: false,
      service: r.service,
      method: r.method as UnaryResponse['method'],
      header: new Headers(),
      trailer: new Headers(),
      message: {} as never,
    }),
  );
}

/** Build a synthetic UnaryRequest carrying the supplied request message.
 * The interceptor only reads `req.message` and `req.stream`; other fields
 * are placeholder-typed to satisfy the Connect type and are never read. */
function makeUnaryReq(message: object): UnaryRequest {
  return {
    stream: false,
    contextValues: createContextValues(),
    header: new Headers(),
    service: {} as UnaryRequest['service'],
    method: {} as UnaryRequest['method'],
    requestMethod: 'POST',
    url: 'http://test/x',
    signal: new AbortController().signal,
    message: message as never,
  };
}

describe('requestMetaInterceptor — unary RPCs', () => {
  it('rejects empty request_id with InvalidArgument + ErrorDetail; handler not called', async () => {
    const req = makeUnaryReq(
      create(HelloRequestSchema, {
        meta: create(RequestMetaSchema, { requestId: '' }),
        clientKind: 'electron',
      }),
    );
    const next = makeUnaryNext();

    await expect(requestMetaInterceptor(next)(req)).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    expect(next).not.toHaveBeenCalled();

    // Re-throw to inspect the ErrorDetail attachment.
    let captured: ConnectError | undefined;
    try {
      await requestMetaInterceptor(next)(req);
    } catch (err) {
      captured = err as ConnectError;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    const details = captured!.findDetails(ErrorDetailSchema);
    expect(details).toHaveLength(1);
    expect(details[0]?.code).toBe(REQUEST_MISSING_ID_CODE);
  });

  it('rejects whitespace-only request_id (trim before measure)', async () => {
    const req = makeUnaryReq(
      create(HelloRequestSchema, {
        meta: create(RequestMetaSchema, { requestId: '\t  \n' }),
        clientKind: 'electron',
      }),
    );
    const next = makeUnaryNext();

    await expect(requestMetaInterceptor(next)(req)).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes a valid request_id through to the handler unchanged (no synthesis)', async () => {
    const req = makeUnaryReq(
      create(HelloRequestSchema, {
        meta: create(RequestMetaSchema, {
          requestId: '7f3c1d8e-2b94-4f01-a5c6-d9e8b2a107c4',
        }),
        clientKind: 'electron',
      }),
    );
    const next = makeUnaryNext();

    await requestMetaInterceptor(next)(req);
    expect(next).toHaveBeenCalledTimes(1);
    // F7: the interceptor MUST NOT synthesize / rewrite the id.
    const forwarded = next.mock.calls[0]![0] as UnaryRequest;
    const meta = (forwarded.message as unknown as { meta: { requestId: string } }).meta;
    expect(meta.requestId).toBe('7f3c1d8e-2b94-4f01-a5c6-d9e8b2a107c4');
  });

  it('rejects a request with no meta field (contract violation)', async () => {
    // Synthesize a message-shaped object with no `meta` (impossible from
    // a real generated codec, but defensive against handler-side mistakes
    // / future RPCs that forget to include RequestMeta).
    const req = makeUnaryReq({ clientKind: 'electron' });
    const next = makeUnaryNext();

    await expect(requestMetaInterceptor(next)(req)).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    expect(next).not.toHaveBeenCalled();
  });
});

// ---- requestMetaInterceptor: streaming RPCs --------------------------------

function makeStreamReq(messages: AsyncIterable<unknown>): StreamRequest {
  return {
    stream: true,
    contextValues: createContextValues(),
    header: new Headers(),
    service: {} as StreamRequest['service'],
    method: {} as StreamRequest['method'],
    requestMethod: 'POST',
    url: 'http://test/x',
    signal: new AbortController().signal,
    message: messages as AsyncIterable<never>,
  };
}

async function* yieldAll<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

/** Mock streaming `next` that drains the request iterable into an array
 * before resolving — mirrors what a real handler would do, lets the test
 * inspect what the interceptor actually forwarded. */
function makeStreamNext(
  collected: unknown[],
): ReturnType<typeof vi.fn<(r: AnyReq) => Promise<AnyResp>>> {
  return vi.fn(async (r: AnyReq): Promise<AnyResp> => {
    if (r.stream) {
      for await (const m of (r as StreamRequest).message) {
        collected.push(m);
      }
    }
    return {
      stream: true,
      service: r.service,
      method: r.method as StreamResponse['method'],
      header: new Headers(),
      trailer: new Headers(),
      message: yieldAll([]) as AsyncIterable<never>,
    };
  });
}

describe('requestMetaInterceptor — streaming RPCs', () => {
  it('rejects on first message when request_id is empty (handler iterable throws)', async () => {
    const collected: unknown[] = [];
    const next = makeStreamNext(collected);
    const req = makeStreamReq(
      yieldAll([
        create(WatchSessionsRequestSchema, {
          meta: create(RequestMetaSchema, { requestId: '' }),
        }),
      ]),
    );

    await expect(requestMetaInterceptor(next)(req)).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    // The handler was invoked (Connect cannot rewind a stream interceptor),
    // but the wrapped iterable threw on its FIRST .next(), so no message
    // ever reached the handler's collection logic.
    expect(collected).toEqual([]);
  });

  it('forwards a valid first message to the handler unchanged', async () => {
    const collected: unknown[] = [];
    const next = makeStreamNext(collected);
    const valid = create(WatchSessionsRequestSchema, {
      meta: create(RequestMetaSchema, {
        requestId: '7f3c1d8e-2b94-4f01-a5c6-d9e8b2a107c4',
      }),
    });
    const req = makeStreamReq(yieldAll([valid]));

    await requestMetaInterceptor(next)(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(collected).toEqual([valid]);
  });

  it('rejects whitespace-only request_id on streaming first message', async () => {
    const collected: unknown[] = [];
    const next = makeStreamNext(collected);
    const req = makeStreamReq(
      yieldAll([
        create(WatchSessionsRequestSchema, {
          meta: create(RequestMetaSchema, { requestId: '  ' }),
        }),
      ]),
    );

    await expect(requestMetaInterceptor(next)(req)).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    expect(collected).toEqual([]);
  });
});
