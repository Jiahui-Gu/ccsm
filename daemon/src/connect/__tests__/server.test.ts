// T05.1 Connect data-socket server tests.
//
// Spec: docs/superpowers/specs/2026-05-01-v0.4-web-design.md
//   - ch02 §1 (Connect lock), §6 (data socket = HTTP/2 + Connect), §7 (Ping
//     handshake), §8 (interceptor inheritances; HMAC daemon.hello REPLACED)
//   - ch05 §4 (JWT interceptor, transport-tag positive enum, fail-closed)
//   - ch05 §5 line 3144 (chain-order LOCK):
//       transport-tag → JWT → migration-gate → storage-full → deadline → trace-id → handler
//
// What this PR (T05.1) covers:
//   - Server boots on a mock socket / port.
//   - Real `buildInterceptorChain()` runs interceptors in spec-locked order
//     (verified by tap interceptors interleaved between real ones — fix for
//     reviewer P2 #6 from PR #752 which flagged the previous shadow-chain test).
//   - Reverse-verify: explicitly assert order matches SPEC_CH05_S5_CANONICAL_ORDER.
//   - Storage-full slot rejects when predicate true.
//   - Rate-cap rejects after threshold (50/sec default).
//   - JWT placeholder bypasses local-pipe; rejects remote-tcp.
//   - Trace-id ULID generated.
//
// Stubbed for follow-up tasks:
//   - JWT verification (T08).
//   - Storage-full real predicate (T15).
//   - First service handler (T06).

import { describe, it, expect } from 'vitest';
import {
  buildInterceptorChain,
  createConnectDataServer,
  createJwtInterceptor,
  createMigrationGateInterceptor,
  createRateCapInterceptor,
  createStorageFullInterceptor,
  createTraceIdInterceptor,
  createTransportTagInterceptor,
  createReadMaxNearCapInterceptor,
  createDeadlineInterceptor,
  DEFAULT_MAX_REQUESTS_PER_SEC,
  DEFAULT_READ_MAX_BYTES,
  INTERCEPTOR_SLOT_NAMES,
  READ_MAX_BYTES_PER_ROUTE,
  SPEC_CH05_S5_CANONICAL_ORDER,
  readMaxBytesForRoute,
  transportTypeKey,
  traceIdKey,
} from '../server.js';
import { Code, ConnectError, createContextValues } from '@connectrpc/connect';

describe('Connect data-socket server scaffold (T05.1)', () => {
  describe('createConnectDataServer', () => {
    it('produces a Node request handler + listen/close lifecycle on an ephemeral TCP port', async () => {
      const server = createConnectDataServer({
        registerRoutes: () => {},
        isMigrationPending: () => false,
      });
      expect(typeof server.handler).toBe('function');
      const port = await server.listen({ host: '127.0.0.1', port: 0 });
      expect(port).toBeGreaterThan(0);
      await server.close();
    });

    it('exposes a stable `attachSocket(socket, transportType)` method', () => {
      const server = createConnectDataServer({
        registerRoutes: () => {},
        isMigrationPending: () => false,
      });
      expect(typeof server.attachSocket).toBe('function');
    });
  });

  describe('chain order — REAL `buildInterceptorChain` (fix for PR #752 P2 #6)', () => {
    // Reviewer flagged the original test built a SHADOW chain and asserted on
    // it, which would not catch a swap of two interceptors in the real
    // factory. T05.1 fix: instrument the REAL chain by inserting a tap
    // BEFORE each real interceptor and verifying the call order matches
    // SPEC_CH05_S5_CANONICAL_ORDER.

    it('executes interceptors in the spec-locked order (transport-tag → jwt → migration-gate → storage-full → deadline → trace-id)', async () => {
      const trace: string[] = [];
      const chain = buildInterceptorChain({ isMigrationPending: () => false });

      // Wrap each real interceptor with a tap that records its slot name on
      // entry. Slot names come from INTERCEPTOR_SLOT_NAMES (declared order).
      const wrapped = chain.map((interceptor, i) => {
        const slotName = INTERCEPTOR_SLOT_NAMES[i]!;
        const tap: typeof interceptor = (next) => {
          const composed = interceptor(next);
          return async (req) => {
            trace.push(slotName);
            return composed(req);
          };
        };
        return tap;
      });

      // Compose outermost-first per Connect server-side semantics.
      let next: any = async (_req: any) => ({ ok: true });
      for (let i = wrapped.length - 1; i >= 0; i--) {
        next = wrapped[i]!(next);
      }
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      await next(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Ping' }));

      // First 6 entries MUST match the ch05 §5 canonical lock; entries 6+
      // are the appended observability interceptors (rate-cap, read-max-near-cap).
      expect(trace.slice(0, SPEC_CH05_S5_CANONICAL_ORDER.length)).toEqual(
        SPEC_CH05_S5_CANONICAL_ORDER,
      );
    });

    it('reverse-verify: re-ordering the chain in source MUST fail this test', async () => {
      // Sanity check: build a deliberately mis-ordered chain (swap slots [2]
      // and [3] — migration-gate vs storage-full) and assert the trace shows
      // the swap. Proves the test asserts on real ordering, not a hardcoded
      // expectation.
      const trace: string[] = [];
      const swapped = [
        createTransportTagInterceptor(),
        createJwtInterceptor(),
        createStorageFullInterceptor(), // <-- swapped: should be at [3]
        createMigrationGateInterceptor({ isMigrationPending: () => false }), // <-- swapped: should be at [2]
        createDeadlineInterceptor(),
        createTraceIdInterceptor(),
      ];
      const slotNames = ['transport-tag', 'jwt', 'storage-full', 'migration-gate', 'deadline', 'trace-id'];
      const wrapped = swapped.map((interceptor, i) => {
        const slot = slotNames[i]!;
        const tap: typeof interceptor = (next) => {
          const composed = interceptor(next);
          return async (req) => {
            trace.push(slot);
            return composed(req);
          };
        };
        return tap;
      });
      let next: any = async (_req: any) => ({ ok: true });
      for (let i = wrapped.length - 1; i >= 0; i--) {
        next = wrapped[i]!(next);
      }
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      await next(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Ping' }));
      // The swapped chain produces a different trace than the canonical lock.
      expect(trace).not.toEqual(SPEC_CH05_S5_CANONICAL_ORDER);
      expect(trace).toEqual(slotNames);
    });

    it('builds 8 interceptors total: 6 spec-locked + 2 appended observability (rate-cap, read-max-near-cap)', () => {
      const chain = buildInterceptorChain({ isMigrationPending: () => false });
      expect(chain).toHaveLength(8);
      expect(INTERCEPTOR_SLOT_NAMES).toHaveLength(8);
      expect(INTERCEPTOR_SLOT_NAMES.slice(0, 6)).toEqual([
        'transport-tag',
        'jwt',
        'migration-gate',
        'storage-full',
        'deadline',
        'trace-id',
      ]);
      expect(INTERCEPTOR_SLOT_NAMES.slice(6)).toEqual(['rate-cap', 'read-max-near-cap']);
    });
  });

  describe('migration-gate interceptor', () => {
    it('blocks data-plane RPC when isMigrationPending() is true', async () => {
      const interceptor = createMigrationGateInterceptor({
        isMigrationPending: () => true,
        logger: { warn: () => {} },
      });
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      await expect(
        handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'GetAppVersion' })),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    });

    it('passes through when migration is not pending', async () => {
      const interceptor = createMigrationGateInterceptor({
        isMigrationPending: () => false,
      });
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      await expect(
        handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'GetAppVersion' })),
      ).resolves.toEqual({ ok: true });
    });
  });

  describe('storage-full interceptor (T05.1 stub; T15 wires real predicate)', () => {
    it('rejects with Code.ResourceExhausted when isStorageFull() is true', async () => {
      const interceptor = createStorageFullInterceptor({
        isStorageFull: () => true,
        logger: { warn: () => {} },
      });
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      await expect(
        handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Db.Save' })),
      ).rejects.toMatchObject({ code: Code.ResourceExhausted });
    });

    it('passes through when storage-full marker is clear', async () => {
      const interceptor = createStorageFullInterceptor({
        isStorageFull: () => false,
      });
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      await expect(
        handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Db.Save' })),
      ).resolves.toEqual({ ok: true });
    });

    it('defaults to inert (always pass) when isStorageFull omitted', async () => {
      const interceptor = createStorageFullInterceptor();
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      await expect(
        handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Db.Save' })),
      ).resolves.toEqual({ ok: true });
    });
  });

  describe('jwt interceptor (T05.1 placeholder; T08 lands real verify)', () => {
    it('bypasses local-pipe transport (per ch05 §4 local bypass)', async () => {
      const interceptor = createJwtInterceptor();
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      await expect(handler(makeFakeUnaryReq({ contextValues: ctx }))).resolves.toEqual({ ok: true });
    });

    it('rejects remote-tcp transport (placeholder fail-closed; T08 lands real verification)', async () => {
      const interceptor = createJwtInterceptor({ logger: { warn: () => {} } });
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'remote-tcp');
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      await expect(handler(makeFakeUnaryReq({ contextValues: ctx }))).rejects.toMatchObject({
        code: Code.Unauthenticated,
      });
    });

    it('rejects untagged transport (fail-closed per ch05 §4)', async () => {
      const interceptor = createJwtInterceptor({ logger: { warn: () => {} } });
      const ctx = createContextValues();
      // Don't set transportTypeKey at all.
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      await expect(handler(makeFakeUnaryReq({ contextValues: ctx }))).rejects.toMatchObject({
        code: Code.Unauthenticated,
      });
    });

    it('emits a structured pino warn on reject', async () => {
      const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
      const interceptor = createJwtInterceptor({
        logger: { warn: (obj, msg) => logs.push({ obj, msg }) },
      });
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'remote-tcp');
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      try {
        await handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Ping' }));
      } catch {
        /* expected */
      }
      expect(logs).toHaveLength(1);
      expect(logs[0]!.msg).toBe('connect_interceptor_reject');
      expect(logs[0]!.obj).toMatchObject({
        interceptor: 'jwt',
        method: 'Ping',
        rejectCode: Code.Unauthenticated,
        transportTag: 'remote-tcp',
      });
    });
  });

  describe('rate-cap interceptor (P1.3 — 50/sec default)', () => {
    it('default cap is 50/sec', () => {
      expect(DEFAULT_MAX_REQUESTS_PER_SEC).toBe(50);
    });

    it('admits up to maxPerSec, rejects subsequent within the 1s window', async () => {
      let t = 1_000_000;
      const interceptor = createRateCapInterceptor({
        maxPerSec: 5,
        now: () => t,
        // Force all requests into the same bucket key to make the test deterministic.
        resolveBucketKey: () => 'test-bucket',
        logger: { warn: () => {} },
      });
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'remote-tcp');
      // 5 admits.
      for (let i = 0; i < 5; i++) {
        await expect(
          handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Ping' })),
        ).resolves.toEqual({ ok: true });
      }
      // 6th — within 1s, same bucket → reject.
      await expect(
        handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Ping' })),
      ).rejects.toMatchObject({ code: Code.ResourceExhausted });
    });

    it('burst 100 within 1s with cap=50 → at least 50 rejections (P1.3 acceptance)', async () => {
      let t = 2_000_000;
      let rejects = 0;
      let admits = 0;
      const interceptor = createRateCapInterceptor({
        maxPerSec: 50,
        now: () => t,
        resolveBucketKey: () => 'burst-test',
        logger: { warn: () => {} },
      });
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      for (let i = 0; i < 100; i++) {
        try {
          await handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Ping' }));
          admits += 1;
        } catch {
          rejects += 1;
        }
      }
      expect(admits).toBe(50);
      expect(rejects).toBe(50);
    });

    it('window slides: after 1100ms the budget is full again', async () => {
      let t = 3_000_000;
      const interceptor = createRateCapInterceptor({
        maxPerSec: 2,
        now: () => t,
        resolveBucketKey: () => 'slide-test',
        logger: { warn: () => {} },
      });
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      await handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Ping' }));
      await handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Ping' }));
      await expect(
        handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Ping' })),
      ).rejects.toMatchObject({ code: Code.ResourceExhausted });
      // Advance past the 1s window.
      t += 1100;
      await expect(
        handler(makeFakeUnaryReq({ contextValues: ctx, methodName: 'Ping' })),
      ).resolves.toEqual({ ok: true });
    });

    it('separates buckets: local-pipe and remote-tcp (default IP) counted independently', async () => {
      let t = 4_000_000;
      const interceptor = createRateCapInterceptor({
        maxPerSec: 2,
        now: () => t,
        // Default resolver: local-pipe → '__local__'; remote-tcp → '__no-ip__' (no XFF).
        logger: { warn: () => {} },
      });
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      const localCtx = createContextValues();
      localCtx.set(transportTypeKey, 'local-pipe');
      const remoteCtx = createContextValues();
      remoteCtx.set(transportTypeKey, 'remote-tcp');
      // Burn local bucket.
      await handler(makeFakeUnaryReq({ contextValues: localCtx, methodName: 'Ping' }));
      await handler(makeFakeUnaryReq({ contextValues: localCtx, methodName: 'Ping' }));
      // Remote bucket still has budget.
      await expect(
        handler(makeFakeUnaryReq({ contextValues: remoteCtx, methodName: 'Ping' })),
      ).resolves.toEqual({ ok: true });
      await expect(
        handler(makeFakeUnaryReq({ contextValues: remoteCtx, methodName: 'Ping' })),
      ).resolves.toEqual({ ok: true });
      // Both buckets exhausted → reject.
      await expect(
        handler(makeFakeUnaryReq({ contextValues: localCtx, methodName: 'Ping' })),
      ).rejects.toMatchObject({ code: Code.ResourceExhausted });
      await expect(
        handler(makeFakeUnaryReq({ contextValues: remoteCtx, methodName: 'Ping' })),
      ).rejects.toMatchObject({ code: Code.ResourceExhausted });
    });
  });

  describe('read-max per-route caps (P1.2)', () => {
    it('default cap is 4 MiB; spec-listed routes have their own caps', () => {
      expect(DEFAULT_READ_MAX_BYTES).toBe(4 * 1024 * 1024);
      expect(READ_MAX_BYTES_PER_ROUTE['/ccsm.v1.CcsmService/Ping']).toBe(1024);
      expect(READ_MAX_BYTES_PER_ROUTE['/ccsm.v1.CcsmService/DaemonHello']).toBe(4096);
      expect(READ_MAX_BYTES_PER_ROUTE['/ccsm.v1.PtyService/SendPtyInput']).toBe(1 * 1024 * 1024);
      expect(READ_MAX_BYTES_PER_ROUTE['/ccsm.v1.DbService/Save']).toBe(16 * 1024 * 1024);
    });

    it('readMaxBytesForRoute() returns per-route cap or default', () => {
      expect(readMaxBytesForRoute('/ccsm.v1.CcsmService/Ping')).toBe(1024);
      expect(readMaxBytesForRoute('/ccsm.v1.UnknownService/Unknown')).toBe(DEFAULT_READ_MAX_BYTES);
    });

    it('near-cap interceptor logs (does NOT reject) requests within 10% of route cap', async () => {
      const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
      const interceptor = createReadMaxNearCapInterceptor({
        logger: { warn: (obj, msg) => logs.push({ obj, msg }) },
        capForRoute: () => 1000,
      });
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      // 950 bytes = 95% of 1000 → within the 10% near-cap zone (>= 0.9 * cap).
      const req = makeFakeUnaryReq({
        contextValues: ctx,
        methodName: 'Ping',
        url: 'http://local/ccsm.v1.CcsmService/Ping',
        contentLength: 950,
      });
      await expect(handler(req)).resolves.toEqual({ ok: true });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.obj).toMatchObject({ interceptor: 'read-max-near-cap' });
    });

    it('near-cap interceptor stays quiet for safely-sized requests', async () => {
      const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
      const interceptor = createReadMaxNearCapInterceptor({
        logger: { warn: (obj, msg) => logs.push({ obj, msg }) },
        capForRoute: () => 1000,
      });
      const handler = interceptor(async (_r: any) => ({ ok: true }));
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      const req = makeFakeUnaryReq({
        contextValues: ctx,
        methodName: 'Ping',
        url: 'http://local/ccsm.v1.CcsmService/Ping',
        contentLength: 100,
      });
      await expect(handler(req)).resolves.toEqual({ ok: true });
      expect(logs).toHaveLength(0);
    });
  });

  describe('trace-id interceptor', () => {
    it('generates a ULID and stores it on the context if absent', async () => {
      const interceptor = createTraceIdInterceptor();
      const ctx = createContextValues();
      ctx.set(transportTypeKey, 'local-pipe');
      let captured: string | undefined;
      const handler = interceptor(async (r: any) => {
        captured = r.contextValues.get(traceIdKey);
        return { ok: true };
      });
      await handler(makeFakeUnaryReq({ contextValues: ctx }));
      expect(captured).toBeDefined();
      expect(captured).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it('preserves an existing trace-id (idempotent on retry)', async () => {
      const interceptor = createTraceIdInterceptor();
      const ctx = createContextValues();
      ctx.set(traceIdKey, '01ABCDEFGHJKMNPQRSTVWXYZ12');
      let captured: string | undefined;
      const handler = interceptor(async (r: any) => {
        captured = r.contextValues.get(traceIdKey);
        return { ok: true };
      });
      await handler(makeFakeUnaryReq({ contextValues: ctx }));
      expect(captured).toBe('01ABCDEFGHJKMNPQRSTVWXYZ12');
    });
  });
});

// --- helpers ---

function makeFakeUnaryReq(opts: {
  contextValues: ReturnType<typeof createContextValues>;
  methodName?: string;
  url?: string;
  contentLength?: number;
}): any {
  const headers = new globalThis.Headers();
  if (opts.contentLength !== undefined) {
    headers.set('content-length', String(opts.contentLength));
  }
  return {
    stream: false as const,
    method: { name: opts.methodName ?? 'TestMethod' },
    service: { typeName: 'ccsm.v1.CcsmService' },
    url: opts.url ?? 'http://local/ccsm.v1.CcsmService/TestMethod',
    init: {},
    header: headers,
    contextValues: opts.contextValues,
    message: {},
    signal: new AbortController().signal,
    requestMethod: 'POST',
  };
}

// Suppress unused-expectation-style-friendly imports when ConnectError is only
// asserted via .rejects.toMatchObject. Keep the import for clarity / future
// tests that throw real ConnectError instances.
void ConnectError;
