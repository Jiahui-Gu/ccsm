import { describe, it, expect, vi } from 'vitest';
import {
  Dispatcher,
  createSupervisorDispatcher,
  createDataDispatcher,
  type DispatchContext,
  type Handler,
} from '../dispatcher.js';
import { SUPERVISOR_RPCS } from '../envelope/supervisor-rpcs.js';

const ctx: DispatchContext = { traceId: '01HZZZTESTULIDXXXXXXXXX' };

describe('Dispatcher (spec §3.4.1.h control-socket router)', () => {
  describe('allowlist enforcement', () => {
    it('rejects non-supervisor methods with NOT_ALLOWED', async () => {
      const d = new Dispatcher();
      const r = await d.dispatch('session.list', {}, ctx);
      expect(r.ok).toBe(false);
      if (r.ok) return; // type narrowing
      expect(r.error.code).toBe('NOT_ALLOWED');
      expect(r.error.method).toBe('session.list');
      expect(r.error.message).toContain('SUPERVISOR_RPCS');
    });

    it.each([
      'ccsm.v1/session.subscribe',
      'daemon.foo',
      '',
      'daemon.HELLO', // case-sensitive — literal compare per §3.4.1.h
      ' daemon.hello',
      '/healthz/extra',
      '/',
    ])('rejects %j with NOT_ALLOWED on the supervisor dispatcher', async (m) => {
      const d = new Dispatcher();
      const r = await d.dispatch(m, {}, ctx);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('NOT_ALLOWED');
    });

    it('register() refuses non-supervisor methods', () => {
      const d = new Dispatcher();
      const noop: Handler = async () => undefined;
      expect(() => d.register('session.list', noop)).toThrow(/non-supervisor RPC/);
    });
  });

  describe('UNKNOWN_METHOD path', () => {
    it.each([...SUPERVISOR_RPCS])(
      'returns UNKNOWN_METHOD for allowlisted %s when no handler is registered',
      async (method) => {
        const d = new Dispatcher(); // bare — no stubs
        const r = await d.dispatch(method, {}, ctx);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('UNKNOWN_METHOD');
        expect(r.error.method).toBe(method);
      },
    );
  });

  describe('handler registration / replacement', () => {
    it('register → has → dispatch chain', async () => {
      const d = new Dispatcher();
      expect(d.has('daemon.hello')).toBe(false);
      const handler = vi.fn<Handler>(async () => ({ pong: true }));
      d.register('daemon.hello', handler);
      expect(d.has('daemon.hello')).toBe(true);
      const r = await d.dispatch('daemon.hello', { hi: 1 }, ctx);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toEqual({ pong: true });
      expect(handler).toHaveBeenCalledWith({ hi: 1 }, ctx);
    });

    it('register replaces an existing handler', async () => {
      const d = createSupervisorDispatcher();
      const replacement = vi.fn<Handler>(async () => 'replaced');
      d.register('/healthz', replacement);
      const r = await d.dispatch('/healthz', undefined, ctx);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe('replaced');
      expect(replacement).toHaveBeenCalledTimes(1);
    });

    it('does not swallow non-stub handler exceptions', async () => {
      const d = new Dispatcher();
      d.register('daemon.shutdown', async () => {
        throw new Error('boom');
      });
      await expect(d.dispatch('daemon.shutdown', {}, ctx)).rejects.toThrow('boom');
    });
  });

  describe('createSupervisorDispatcher() default stubs (T17–T21 placeholders)', () => {
    it('pre-registers exactly the five SUPERVISOR_RPCS', () => {
      const d = createSupervisorDispatcher();
      for (const m of SUPERVISOR_RPCS) {
        expect(d.has(m)).toBe(true);
      }
    });

    it.each([...SUPERVISOR_RPCS])(
      'stub for %s returns NOT_IMPLEMENTED echoing the method name',
      async (method) => {
        const d = createSupervisorDispatcher();
        const r = await d.dispatch(method, {}, ctx);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('NOT_IMPLEMENTED');
        expect(r.error.method).toBe(method);
        expect(r.error.message).toContain(method);
      },
    );

    it('still rejects non-supervisor methods even with stubs registered', async () => {
      const d = createSupervisorDispatcher();
      const r = await d.dispatch('session.list', {}, ctx);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('NOT_ALLOWED');
    });
  });

  describe('plane option (T23 — supervisor vs data plane)', () => {
    it('default plane is supervisor (back-compat with T16)', () => {
      const d = new Dispatcher();
      expect(d.plane).toBe('supervisor');
    });

    it('explicit supervisor plane behaves identically to default', async () => {
      const d = new Dispatcher({ plane: 'supervisor' });
      expect(d.plane).toBe('supervisor');
      const r = await d.dispatch('session.list', {}, ctx);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('NOT_ALLOWED');
    });

    describe('supervisor plane — allowlist enforced at boundary', () => {
      it.each([...SUPERVISOR_RPCS])(
        'routes allowlisted method %s to its registered handler',
        async (method) => {
          const d = new Dispatcher({ plane: 'supervisor' });
          const handler = vi.fn<Handler>(async () => ({ method, ok: true }));
          d.register(method, handler);
          const r = await d.dispatch(method, { ping: 1 }, ctx);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.value).toEqual({ method, ok: true });
          expect(handler).toHaveBeenCalledWith({ ping: 1 }, ctx);
        },
      );

      it('rejects unknown (non-allowlisted) method with NOT_ALLOWED before handler lookup', async () => {
        const d = new Dispatcher({ plane: 'supervisor' });
        // Even if some allowlisted handler is registered, an off-list method
        // is still rejected with NOT_ALLOWED — boundary check runs first.
        d.register('daemon.hello', async () => 'unused');
        const r = await d.dispatch('session.subscribe', {}, ctx);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('NOT_ALLOWED');
        expect(r.error.method).toBe('session.subscribe');
        // Defence-in-depth: message must NOT enumerate the allowlist (no
        // method names leaked back to a probing client).
        expect(r.error.message).not.toContain('daemon.hello');
        expect(r.error.message).not.toContain('/healthz');
      });
    });

    describe('data plane — allowlist NOT applied', () => {
      it('createDataDispatcher() exposes plane="data"', () => {
        const d = createDataDispatcher();
        expect(d.plane).toBe('data');
      });

      it('register() accepts arbitrary (non-supervisor) method names', () => {
        const d = createDataDispatcher();
        const noop: Handler = async () => undefined;
        expect(() => d.register('session.list', noop)).not.toThrow();
        expect(() => d.register('ccsm.v1/pty.subscribe', noop)).not.toThrow();
        expect(d.has('session.list')).toBe(true);
      });

      it('routes a registered non-supervisor method to its handler', async () => {
        const d = createDataDispatcher();
        const handler = vi.fn<Handler>(async () => ({ rows: [] }));
        d.register('session.list', handler);
        const r = await d.dispatch('session.list', { limit: 10 }, ctx);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value).toEqual({ rows: [] });
        expect(handler).toHaveBeenCalledWith({ limit: 10 }, ctx);
      });

      it('returns UNKNOWN_METHOD (not NOT_ALLOWED) for an unknown method on data plane', async () => {
        const d = createDataDispatcher();
        const r = await d.dispatch('session.subscribe', {}, ctx);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        // Crucial contract: data plane never emits NOT_ALLOWED — surface
        // declaration is the data-socket transport's job, not the dispatcher.
        expect(r.error.code).toBe('UNKNOWN_METHOD');
        expect(r.error.method).toBe('session.subscribe');
        expect(r.error.message).toContain('data-plane');
      });

      it('routes an allowlisted name when explicitly registered on data plane', async () => {
        // Data plane does not reserve SUPERVISOR_RPCS names — they are just
        // strings here. (In practice the two planes run on disjoint sockets
        // so collisions are inert; the dispatcher only routes whatever its
        // owner registered.)
        const d = createDataDispatcher();
        const handler = vi.fn<Handler>(async () => 'data-side');
        d.register('/healthz', handler);
        const r = await d.dispatch('/healthz', {}, ctx);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value).toBe('data-side');
      });
    });
  });
});
