// Tests for the peer-cred Connect interceptor + the pure derivePrincipal
// decision table. We drive the interceptor with a synthetic request /
// next-fn pair so the tests stay decoupled from any HTTP/2 server
// adapter (which lands in T1.5). Spec refs: ch03 §1, §5; ch05 §2, §3.

import { describe, expect, it, vi } from 'vitest';
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
  PRINCIPAL_KEY,
  TEST_BEARER_TOKEN,
  derivePrincipal,
  peerCredAuthInterceptor,
} from '../interceptor.js';
import { PEER_INFO_KEY, type PeerInfo } from '../peer-info.js';

// ---- derivePrincipal: pure decision table ---------------------------------

describe('derivePrincipal', () => {
  it('UDS uid → local-user:<uid> with empty displayName', () => {
    const p = derivePrincipal({ transport: 'uds', uid: 1000, gid: 100, pid: 1 });
    expect(p).toEqual({ kind: 'local-user', uid: '1000', displayName: '' });
  });

  it('UDS uid 0 (root) is accepted — kernel-vouched, not a privilege check', () => {
    // This module derives identity, NOT authorization. Spec ch05 §3 says
    // uid MUST resolve; root is a valid uid. The supervisor admin
    // allowlist (T1.7) is the place that restricts who may call /shutdown.
    const p = derivePrincipal({ transport: 'uds', uid: 0, gid: 0, pid: 1 });
    expect(p.uid).toBe('0');
  });

  it('UDS rejects negative uid (impossible from kernel; defensive)', () => {
    expect(() => derivePrincipal({ transport: 'uds', uid: -1, gid: 0, pid: 1 })).toThrow(
      ConnectError,
    );
  });

  it('UDS rejects non-integer uid (defensive against addon bugs)', () => {
    expect(() =>
      derivePrincipal({ transport: 'uds', uid: 1.5, gid: 0, pid: 1 } as PeerInfo),
    ).toThrow(/invalid uid/);
  });

  it('namedPipe SID → local-user:<sid> with the looked-up displayName', () => {
    const sid = 'S-1-5-21-1111-2222-3333-1001';
    const p = derivePrincipal({ transport: 'namedPipe', sid, displayName: 'JDOE' });
    expect(p).toEqual({ kind: 'local-user', uid: sid, displayName: 'JDOE' });
  });

  it('namedPipe rejects empty SID with Unauthenticated', () => {
    try {
      derivePrincipal({ transport: 'namedPipe', sid: '', displayName: '' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.Unauthenticated);
    }
  });

  it('loopbackTcp with the canonical test bearer token → local-user:test', () => {
    const p = derivePrincipal({
      transport: 'loopbackTcp',
      bearerToken: TEST_BEARER_TOKEN,
      remoteAddress: '127.0.0.1',
      remotePort: 12345,
    });
    expect(p).toEqual({ kind: 'local-user', uid: 'test', displayName: 'test' });
  });

  it('loopbackTcp with a wrong bearer token → Unauthenticated', () => {
    try {
      derivePrincipal({
        transport: 'loopbackTcp',
        bearerToken: 'not-the-token',
        remoteAddress: '127.0.0.1',
        remotePort: 1,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.Unauthenticated);
    }
  });

  it('loopbackTcp with no bearer token → Unauthenticated (no anonymous loopback path)', () => {
    expect(() =>
      derivePrincipal({
        transport: 'loopbackTcp',
        bearerToken: null,
        remoteAddress: '127.0.0.1',
        remotePort: 1,
      }),
    ).toThrow(ConnectError);
  });
});

// ---- peerCredAuthInterceptor: end-to-end behavior --------------------------

/** Connect's `Interceptor` is `(next: AnyFn) => AnyFn` where AnyFn handles
 * either a UnaryRequest or a StreamRequest. To satisfy the generic type
 * the mock `next` we feed the interceptor MUST accept the union; build a
 * tiny helper so each test stays readable. */
type AnyReq = UnaryRequest | StreamRequest;
type AnyResp = UnaryResponse | StreamResponse;
function makeNext(): ReturnType<typeof vi.fn<(r: AnyReq) => Promise<AnyResp>>> {
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

/** Minimal synthetic UnaryRequest skeleton — only the contextValues + the
 * shape needed by the interceptor are populated. The interceptor never
 * looks at `service` / `method` / `header` etc., so we leave them as
 * placeholder casts; the call shape is tested, not Connect's framing. */
function makeReq(peer: PeerInfo): UnaryRequest {
  const ctx = createContextValues();
  ctx.set(PEER_INFO_KEY, peer);
  return {
    stream: false,
    contextValues: ctx,
    header: new Headers(),
    // Fields below are required by the type but unused by the interceptor.
    service: {} as UnaryRequest['service'],
    method: {} as UnaryRequest['method'],
    requestMethod: 'POST',
    url: 'http://test/x',
    signal: new AbortController().signal,
    message: {} as never,
  };
}

describe('peerCredAuthInterceptor', () => {
  it('publishes a Principal under PRINCIPAL_KEY and continues the chain (UDS)', async () => {
    const req = makeReq({ transport: 'uds', uid: 1000, gid: 100, pid: 42 });
    const next = makeNext();

    await peerCredAuthInterceptor(next)(req);

    expect(next).toHaveBeenCalledTimes(1);
    const principal = req.contextValues.get(PRINCIPAL_KEY);
    expect(principal).toEqual({ kind: 'local-user', uid: '1000', displayName: '' });
  });

  it('publishes a Principal for a Windows named-pipe peer', async () => {
    const sid = 'S-1-5-21-1004336348-1177238915-682003330-1001';
    const req = makeReq({ transport: 'namedPipe', sid, displayName: 'jdoe' });
    const next = makeNext();

    await peerCredAuthInterceptor(next)(req);

    expect(req.contextValues.get(PRINCIPAL_KEY)).toEqual({
      kind: 'local-user',
      uid: sid,
      displayName: 'jdoe',
    });
  });

  it('accepts the test bearer token over loopback TCP and emits the test principal', async () => {
    const req = makeReq({
      transport: 'loopbackTcp',
      bearerToken: TEST_BEARER_TOKEN,
      remoteAddress: '127.0.0.1',
      remotePort: 33333,
    });
    const next = makeNext();

    await peerCredAuthInterceptor(next)(req);

    expect(req.contextValues.get(PRINCIPAL_KEY)).toEqual({
      kind: 'local-user',
      uid: 'test',
      displayName: 'test',
    });
  });

  it('rejects a loopback request without the bearer token (Unauthenticated, no handler called)', async () => {
    const req = makeReq({
      transport: 'loopbackTcp',
      bearerToken: null,
      remoteAddress: '127.0.0.1',
      remotePort: 1,
    });
    const next = makeNext();

    await expect(peerCredAuthInterceptor(next)(req)).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    expect(next).not.toHaveBeenCalled();
    // Critically: PRINCIPAL_KEY remains the null sentinel so a leaky
    // handler still observes the unauthenticated state explicitly.
    expect(req.contextValues.get(PRINCIPAL_KEY)).toBeNull();
  });

  it('rejects a loopback request with a wrong token', async () => {
    const req = makeReq({
      transport: 'loopbackTcp',
      bearerToken: 'sneaky',
      remoteAddress: '127.0.0.1',
      remotePort: 1,
    });
    await expect(peerCredAuthInterceptor(makeNext())(req)).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
  });

  it('rejects when the transport adapter forgot to set PEER_INFO_KEY (sentinel default)', async () => {
    // Build a request WITHOUT calling makeReq — leave PEER_INFO_KEY at
    // its NO_PEER_INFO default. Spec ch05 §2: there is no "no principal"
    // code path; the interceptor must reject before the handler runs.
    const ctx = createContextValues();
    const req: UnaryRequest = {
      stream: false,
      contextValues: ctx,
      header: new Headers(),
      service: {} as UnaryRequest['service'],
      method: {} as UnaryRequest['method'],
      requestMethod: 'POST',
      url: 'http://test/x',
      signal: new AbortController().signal,
      message: {} as never,
    };
    const next = makeNext();

    await expect(peerCredAuthInterceptor(next)(req)).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('translates a non-ConnectError throw into ConnectError(Unauthenticated)', async () => {
    // Force derivePrincipal to fail with a plain Error by feeding an
    // unknown transport via cast; the interceptor must wrap it into a
    // ConnectError. (Negative uid throws a ConnectError already; this
    // path covers the non-ConnectError wrap branch.)
    const req = makeReq({
      transport: 'mystery' as 'uds',
      uid: 1,
      gid: 1,
      pid: 1,
    } as PeerInfo);

    await expect(peerCredAuthInterceptor(makeNext())(req)).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
  });
});
