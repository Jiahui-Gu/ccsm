// T6.6 — Renderer boot wiring smoke test.
//
// @vitest-environment happy-dom
//
// Spec ref: ch08 §6.2 — verifies that wrapping arbitrary React content in
// `<RendererBoot>` exposes the typed Connect-RPC client bundle to the
// hook layer, so a child that calls `useListSessions(...)` resolves a real
// client and surfaces a response.
//
// What this proves (and what it does NOT):
//   - PROVES: `<RendererBoot>` mounts QueryClientProvider + ConnectionProvider
//     + ClientsProvider in the right order, so `useClients()` (and therefore
//     `useListSessions`) does not throw and the underlying transport is
//     reached. This is the wire-up evidence #215 needs before swapping
//     call sites from `window.ccsm*` to RPC hooks.
//   - DOES NOT: exercise the cold-start modal timing (T6.8 spec covers
//     that), nor reconnect / boot_id mismatch (T6.7 spec covers that),
//     nor the actual transport bridge (T6.2 spec + e2e ship-gate (b)).
//     Boot wiring's job is the *composition*; the underlying components
//     are already independently tested.

import { create } from '@bufbuild/protobuf';
import type { Transport } from '@connectrpc/connect';
import { renderHook, waitFor, render } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import {
  HelloResponseSchema,
  ListSessionsResponseSchema,
  SessionService,
} from '@ccsm/proto';
import { RendererBoot } from '../../src/renderer/boot.js';
import { useListSessions } from '../../src/rpc/queries.js';
import type { DescriptorV1 } from '../../src/main/protocol-app.js';

function makeDescriptor(): DescriptorV1 {
  return {
    version: 1,
    transport: 'KIND_TCP_LOOPBACK_H2C',
    address: 'http://127.0.0.1:1',
    tlsCertFingerprintSha256: null,
    supervisorAddress: 'unused',
    boot_id: 'boot-smoke',
    daemon_pid: 1,
    listener_addr: 'http://127.0.0.1:1',
    protocol_version: 1,
    bind_unix_ms: 0,
  };
}

/**
 * Stub Transport that returns the right response per service+method. The
 * boot path makes TWO Hello calls before children mount (one inside
 * ConnectionProvider's drive loop, one inside ColdStartGate's clients
 * rebuild) — both must succeed. After mount, `useListSessions` triggers a
 * ListSessions call.
 */
function makeStubTransport(): Transport {
  return {
    async unary(method, _signal, _timeoutMs, _header, _input, _ctxValues) {
      let message: unknown;
      if (method.parent.typeName === SessionService.typeName) {
        if (method.name === 'Hello') {
          message = create(HelloResponseSchema, {
            daemonVersion: '0.3.0',
            protoVersion: 1,
            listenerId: 'A',
          });
        } else if (method.name === 'ListSessions') {
          message = create(ListSessionsResponseSchema, { sessions: [] });
        } else {
          throw new Error(`unexpected SessionService method: ${method.name}`);
        }
      } else {
        throw new Error(
          `unexpected service in smoke test: ${method.parent.typeName}/${method.name}`,
        );
      }
      return {
        service: method.parent,
        method,
        stream: false as const,
        header: new Headers(),
        message: message as never,
        trailer: new Headers(),
      };
    },
    async stream() {
      throw new Error('stream not used in this smoke test');
    },
  };
}

describe('RendererBoot — smoke test', () => {
  it('mounts the provider chain so useListSessions resolves under <RendererBoot>', async () => {
    function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(
        RendererBoot,
        {
          fetchDescriptor: async () => makeDescriptor(),
          buildTransport: () => makeStubTransport(),
        },
        children,
      );
    }

    const { result } = renderHook(() => useListSessions({}), {
      wrapper: Wrapper,
    });

    // The hook is mounted only AFTER ConnectionProvider's first Hello
    // succeeds (children gate behind state.kind === 'connected'). Until
    // then `result.current` is undefined because the hook has not run.
    await waitFor(
      () => {
        expect(result.current).toBeDefined();
        expect(result.current?.isPending).toBe(false);
      },
      { timeout: 5000 },
    );

    expect(result.current?.error).toBeNull();
    expect(result.current?.data?.sessions).toEqual([]);
  });

  it('renders children without throwing under the real provider chain', async () => {
    // Companion smoke: a child that uses the hook directly (not via
    // renderHook) should mount, fire the RPC, and end up rendering the
    // result. This catches anything renderHook glosses over (e.g., a
    // forgotten provider that only matters for a composed tree).

    function Child(): React.ReactElement {
      const q = useListSessions({});
      if (q.isPending) return React.createElement('div', { 'data-testid': 'pending' }, 'pending');
      if (q.error !== null) return React.createElement('div', { 'data-testid': 'error' }, q.error.message);
      return React.createElement(
        'div',
        { 'data-testid': 'sessions' },
        `count:${q.data?.sessions.length ?? 0}`,
      );
    }

    const { findByTestId } = render(
      React.createElement(
        RendererBoot,
        {
          fetchDescriptor: async () => makeDescriptor(),
          buildTransport: () => makeStubTransport(),
        },
        React.createElement(Child),
      ),
    );

    const el = await findByTestId('sessions', undefined, { timeout: 5000 });
    expect(el.textContent).toBe('count:0');
  });
});
