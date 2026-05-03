// T6.3 — minimal vitest covering one client + one hook.
//
// @vitest-environment happy-dom
//
// Why happy-dom (per-spec, not the shared config): the renderHook + React
// effects path needs a DOM. Other specs in this package are pure-Node
// (descriptor parsers, e2e drivers) so the per-package vitest.config.ts
// stays `environment: 'node'` and we opt-in here only.
//
// Spec ref: ch08 §5 step 2a/2b + §6.2.
//
// Why minimal: the dev-protocol "minimal vitest for one client + one hook"
// brief — broader coverage lands at T6.6 boot wiring (full RPC integration)
// and at the e2e gates (ship-gate (b) sigkill-reattach, T8.5 pty-soak).
// This spec exercises the contract:
//   1. `createClients(transport)` produces objects whose method calls are
//      forwarded to the supplied Transport (the Connect descriptor wiring
//      is correct).
//   2. `useListSessions()` reads from `<ClientsProvider>` context, calls the
//      session client, and surfaces the response under React Query's
//      `data` / `isPending` / `error` shape (the hook surface is wired).
//
// Both checks use a synthetic Transport (no real wire, no @ccsm/proto codegen
// runtime requirement beyond the descriptor). This keeps the test cheap and
// pure-Node — no electron, no daemon, no jsdom.

import { create } from '@bufbuild/protobuf';
import { type Transport } from '@connectrpc/connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  ListSessionsResponseSchema,
  SessionService,
} from '@ccsm/proto';
import { createClients } from '../../src/rpc/clients.js';
import { ClientsProvider, useListSessions } from '../../src/rpc/queries.js';

/**
 * Build a Transport stub whose `unary` returns the supplied response message
 * for every method, recording each call. Connect-ES v2 routes both service
 * and method info through the single `method: DescMethodUnary` arg —
 * `method.parent.typeName` carries the service identity.
 */
function makeStubTransport(response: unknown): {
  transport: Transport;
  calls: Array<{ service: string; method: string; input: unknown }>;
} {
  const calls: Array<{ service: string; method: string; input: unknown }> = [];
  const transport: Transport = {
    async unary(method, _signal, _timeoutMs, _header, input, _ctxValues) {
      calls.push({
        service: method.parent.typeName,
        method: method.name,
        input,
      });
      return {
        service: method.parent,
        method,
        stream: false as const,
        header: new Headers(),
        message: response as never,
        trailer: new Headers(),
      };
    },
    async stream() {
      throw new Error('stream not used in this test');
    },
  };
  return { transport, calls };
}

describe('createClients', () => {
  it('produces typed clients that route through the supplied Transport', async () => {
    const response = create(ListSessionsResponseSchema, { sessions: [] });
    const { transport, calls } = makeStubTransport(response);
    const clients = createClients(transport);

    // The bundle is shaped per CcsmClients — every service field is present.
    expect(typeof clients.session.listSessions).toBe('function');
    expect(typeof clients.pty.sendInput).toBe('function');
    expect(typeof clients.crash.getCrashLog).toBe('function');
    expect(typeof clients.settings.getSettings).toBe('function');
    expect(typeof clients.notify.markUserInput).toBe('function');
    expect(typeof clients.draft.getDraft).toBe('function');
    expect(typeof clients.supervisor.healthCheck).toBe('function');

    // Calling a client method dispatches into the Transport with the right
    // service+method descriptors — the wiring contract this file owns.
    const result = await clients.session.listSessions({});
    expect(result.sessions).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].service).toBe(SessionService.typeName);
    expect(calls[0].method).toBe('ListSessions');
  });
});

describe('useListSessions', () => {
  it('reads clients from <ClientsProvider> and surfaces the response', async () => {
    const response = create(ListSessionsResponseSchema, { sessions: [] });
    const { transport, calls } = makeStubTransport(response);
    const clients = createClients(transport);

    // Fresh QueryClient per test; disable retries so a hypothetical failure
    // surfaces immediately instead of looping.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          ClientsProvider,
          { clients },
          children,
        ),
      );
    }

    const { result } = renderHook(() => useListSessions({}), {
      wrapper: Wrapper,
    });

    // Initial render — fetch in-flight, no data yet.
    expect(result.current.isPending).toBe(true);

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    // Wired correctly: data flows from the stub through the hook surface.
    expect(result.current.error).toBeNull();
    expect(result.current.data?.sessions).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('ListSessions');
  });

  it('throws a clear error when used without <ClientsProvider>', () => {
    // useClients() (called by useListSessions) should throw with a guidance
    // message rather than silently returning undefined — a missing provider
    // is a programming error and we want it to scream.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children,
      );
    }
    // React 18 logs the thrown error; silence it for test output cleanliness.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      renderHook(() => useListSessions({}), { wrapper: Wrapper }),
    ).toThrow(/ClientsProvider/);
    errSpy.mockRestore();
  });
});
