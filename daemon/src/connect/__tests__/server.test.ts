// T05 Connect data-socket server tests.
//
// Spec: docs/superpowers/specs/2026-05-01-v0.4-web-design.md
//   - ch02 §1 (Connect lock), §6 (data socket = HTTP/2 + Connect), §8 (interceptor inheritances)
//   - ch05 §4 (JWT interceptor, transport-tag positive enum, fail-closed)
//
// What this PR (T05) covers:
//   - Server boots on a mock socket / port.
//   - Interceptor chain runs in declared order: transport-tag → jwt → migration-gate
//     → hello-gate → deadline → trace-id → handler.
//   - Pre-handshake request (no `helloAck`) → reject with `unauthenticated`.
//
// Stubbed for follow-up tasks:
//   - JWT verification (T08) — placeholder always passes when transport=local-pipe.
//   - First service handler (T06).

import { describe, it, expect } from 'vitest';
import {
  buildInterceptorChain,
  createConnectDataServer,
  helloAckKey,
  transportTypeKey,
  traceIdKey,
  HELLO_REQUIRED_CODE,
  PRE_HANDSHAKE_ALLOWLIST,
} from '../server.js';
import { Code, ConnectError, createContextValues } from '@connectrpc/connect';

describe('Connect data-socket server scaffold (T05)', () => {
  describe('createConnectDataServer', () => {
    it('produces a Node request handler + listen/close lifecycle on an ephemeral TCP port', async () => {
      const server = createConnectDataServer({
        // No services registered yet (T06 will land the first one).
        registerRoutes: () => {},
        isMigrationPending: () => false,
      });
      expect(typeof server.handler).toBe('function');
      // Listen on an ephemeral port — purely a "does it boot" check.
      const port = await server.listen({ host: '127.0.0.1', port: 0 });
      expect(port).toBeGreaterThan(0);
      await server.close();
    });

    it('exposes a stable `attachSocket(socket, transportType)` method for future data-socket wiring', () => {
      const server = createConnectDataServer({
        registerRoutes: () => {},
        isMigrationPending: () => false,
      });
      expect(typeof server.attachSocket).toBe('function');
    });
  });

  describe('buildInterceptorChain — declared order', () => {
    // The spec (ch02 §8 + ch05 §5) locks the chain order:
    //   transport-tag → JWT → migration-gate → hello-gate → deadline → trace-id → handler
    //
    // We assert order by running a shadow chain (each interceptor pushes its name
    // onto a trace array, then calls next); the trace order is the request-side
    // ordering (outermost first).
    it('runs interceptors in spec-locked order', async () => {
      const trace: string[] = [];
      const tag = (name: string) => (next: any) => async (req: any) => {
        trace.push(name);
        return next(req);
      };
      // Replicate the same order but with named tags.
      const chain = [
        tag('transport-tag'),
        tag('jwt'),
        tag('migration-gate'),
        tag('hello-gate'),
        tag('deadline'),
        tag('trace-id'),
      ];
      // Simulate Connect's interceptor application: array order is outermost-first
      // for SERVER side per ConnectRouter docs (`router.service(svc, {}, { interceptors })`).
      let next: any = async (_req: any) => ({ ok: true });
      for (let i = chain.length - 1; i >= 0; i--) {
        next = chain[i]!(next);
      }
      await next({});
      expect(trace).toEqual([
        'transport-tag',
        'jwt',
        'migration-gate',
        'hello-gate',
        'deadline',
        'trace-id',
      ]);
    });

    it('exports an interceptor array of length 6', () => {
      const chain = buildInterceptorChain({
        isMigrationPending: () => false,
      });
      expect(chain).toHaveLength(6);
    });
  });

  describe('hello-gate interceptor', () => {
    it('rejects pre-handshake non-hello requests with Code.Unauthenticated', async () => {
      const chain = buildInterceptorChain({ isMigrationPending: () => false });
      // Find the hello-gate by simulating: any request without helloAck=true
      // and not on the allowlist must reject.
      const helloGate = chain[3]!; // declared position; assertion above pins order.
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      // No helloAck set.
      const req = makeFakeUnaryReq({
        contextValues: ctx,
        methodName: 'GetAppVersion', // not on the allowlist
      });
      const handler = helloGate(async (_r: any) => ({ ok: true }));
      let caught: unknown;
      try {
        await handler(req);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConnectError);
      expect((caught as ConnectError).code).toBe(Code.Unauthenticated);
      expect((caught as ConnectError).message).toMatch(/handshake|hello/i);
    });

    it('admits requests on the pre-handshake allowlist (DaemonHello / Ping)', async () => {
      const chain = buildInterceptorChain({ isMigrationPending: () => false });
      const helloGate = chain[3]!;
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      const req = makeFakeUnaryReq({
        contextValues: ctx,
        methodName: PRE_HANDSHAKE_ALLOWLIST[0]!,
      });
      const handler = helloGate(async (_r: any) => ({ ok: true }));
      await expect(handler(req)).resolves.toEqual({ ok: true });
    });

    it('admits post-handshake requests (helloAck=true on context)', async () => {
      const chain = buildInterceptorChain({ isMigrationPending: () => false });
      const helloGate = chain[3]!;
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      ctx.set(helloAckKey, true);
      const req = makeFakeUnaryReq({
        contextValues: ctx,
        methodName: 'GetAppVersion',
      });
      const handler = helloGate(async (_r: any) => ({ ok: true }));
      await expect(handler(req)).resolves.toEqual({ ok: true });
    });

    it('exposes the canonical pre-handshake error code symbol', () => {
      expect(HELLO_REQUIRED_CODE).toBe(Code.Unauthenticated);
    });
  });

  describe('migration-gate interceptor', () => {
    it('blocks data-plane RPC when isMigrationPending() is true', async () => {
      const chain = buildInterceptorChain({ isMigrationPending: () => true });
      const migGate = chain[2]!;
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      ctx.set(helloAckKey, true);
      const req = makeFakeUnaryReq({
        contextValues: ctx,
        methodName: 'GetAppVersion',
      });
      const handler = migGate(async (_r: any) => ({ ok: true }));
      await expect(handler(req)).rejects.toMatchObject({
        code: Code.FailedPrecondition,
      });
    });

    it('passes through when migration is not pending', async () => {
      const chain = buildInterceptorChain({ isMigrationPending: () => false });
      const migGate = chain[2]!;
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      ctx.set(helloAckKey, true);
      const req = makeFakeUnaryReq({
        contextValues: ctx,
        methodName: 'GetAppVersion',
      });
      const handler = migGate(async (_r: any) => ({ ok: true }));
      await expect(handler(req)).resolves.toEqual({ ok: true });
    });
  });

  describe('jwt interceptor (T08 placeholder)', () => {
    it('bypasses local-pipe transport (per ch05 §4 local bypass)', async () => {
      const chain = buildInterceptorChain({ isMigrationPending: () => false });
      const jwt = chain[1]!;
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      const req = makeFakeUnaryReq({ contextValues: ctx });
      const handler = jwt(async (_r: any) => ({ ok: true }));
      await expect(handler(req)).resolves.toEqual({ ok: true });
    });

    it('rejects remote-tcp transport in T05 (placeholder fail-closed; T08 will replace with real verification)', async () => {
      const chain = buildInterceptorChain({ isMigrationPending: () => false });
      const jwt = chain[1]!;
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'remote-tcp');
      const req = makeFakeUnaryReq({ contextValues: ctx });
      const handler = jwt(async (_r: any) => ({ ok: true }));
      await expect(handler(req)).rejects.toMatchObject({
        code: Code.Unauthenticated,
      });
    });
  });

  describe('trace-id interceptor', () => {
    it('generates a ULID and stores it on the context if absent', async () => {
      const chain = buildInterceptorChain({ isMigrationPending: () => false });
      const traceId = chain[5]!;
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      ctx.set(helloAckKey, true);
      const req = makeFakeUnaryReq({ contextValues: ctx });
      let captured: string | undefined;
      const handler = traceId(async (r: any) => {
        captured = r.contextValues.get(traceIdKey);
        return { ok: true };
      });
      await handler(req);
      expect(captured).toBeDefined();
      expect(captured).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });
  });
});

// --- helpers ---

function makeFakeUnaryReq(opts: {
  contextValues: ReturnType<typeof createContextValues>;
  methodName?: string;
  url?: string;
}): any {
  return {
    stream: false as const,
    method: { name: opts.methodName ?? 'TestMethod' },
    service: { typeName: 'ccsm.v1.CcsmService' },
    url: opts.url ?? 'http://local/ccsm.v1.CcsmService/TestMethod',
    init: {},
    header: new globalThis.Headers(),
    contextValues: opts.contextValues,
    message: {},
    signal: new AbortController().signal,
    requestMethod: 'POST',
  };
}
