// T6.7 — ConnectionProvider / useConnection: boot_id mismatch → cache nuke,
// version mismatch surfacing.
//
// @vitest-environment happy-dom
//
// Spec ref: ch03 §3.3 + ch08 §6.

import { create } from '@bufbuild/protobuf';
import { ConnectError, Code, type Transport } from '@connectrpc/connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { HelloResponseSchema } from '@ccsm/proto';
import {
  ConnectionProvider,
  useConnection,
  type ConnectionEvents,
} from '../../../src/renderer/connection/use-connection.js';
import type { DescriptorV1 } from '../../../src/main/protocol-app.js';

function makeDescriptor(bootId: string): DescriptorV1 {
  return {
    version: 1,
    transport: 'KIND_TCP_LOOPBACK_H2C',
    address: '127.0.0.1:1',
    tlsCertFingerprintSha256: null,
    supervisorAddress: 'unused',
    boot_id: bootId,
    daemon_pid: 1,
    listener_addr: '127.0.0.1:1',
    protocol_version: 1,
    bind_unix_ms: 0,
  };
}

function makeStubTransport(
  responder: () => unknown,
): Transport {
  return {
    async unary(method, _signal, _timeoutMs, _header, _input, _ctxValues) {
      const r = responder();
      if (r instanceof Error) throw r;
      return {
        service: method.parent,
        method,
        stream: false as const,
        header: new Headers(),
        message: r as never,
        trailer: new Headers(),
      };
    },
    async stream() {
      throw new Error('stream not used');
    },
  };
}

function wrapper(queryClient: QueryClient, props: {
  fetchDescriptor: () => Promise<DescriptorV1>;
  buildTransport: () => Transport;
  events?: ConnectionEvents;
}) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        ConnectionProvider,
        {
          fetchDescriptor: props.fetchDescriptor,
          buildTransport: props.buildTransport,
          events: props.events,
        },
        children,
      ),
    );
  };
}

describe('useConnection — first connect', () => {
  it('flips to "connected" with the descriptor boot_id on success', async () => {
    const helloResp = create(HelloResponseSchema, {
      daemonVersion: '0.3.0',
      protoVersion: 1,
      listenerId: 'A',
    });
    const queryClient = new QueryClient();
    const onConnected = vi.fn();
    const Wrapper = wrapper(queryClient, {
      fetchDescriptor: async () => makeDescriptor('boot-X'),
      buildTransport: () => makeStubTransport(() => helloResp),
      events: { onConnected },
    });
    const { result } = renderHook(() => useConnection(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.state.kind).toBe('connected');
    });
    if (result.current.state.kind !== 'connected') throw new Error('not connected');
    expect(result.current.state.bootId).toBe('boot-X');
    expect(result.current.state.daemonVersion).toBe('0.3.0');
    expect(result.current.state.listenerId).toBe('A');
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('flips to "version-mismatch" on FailedPrecondition (no infinite loop)',
    async () => {
      const queryClient = new QueryClient();
      const Wrapper = wrapper(queryClient, {
        fetchDescriptor: async () => makeDescriptor('boot-X'),
        buildTransport: () =>
          makeStubTransport(() =>
            new ConnectError('client too old', Code.FailedPrecondition),
          ),
      });
      const { result } = renderHook(() => useConnection(), { wrapper: Wrapper });

      await waitFor(() => {
        expect(result.current.state.kind).toBe('version-mismatch');
      });
      if (result.current.state.kind !== 'version-mismatch') {
        throw new Error('expected version-mismatch');
      }
      expect(result.current.state.clientMinVersion).toBeGreaterThan(0);
    });
});

describe('useConnection — boot_id mismatch on reconnect', () => {
  it('invalidates ["ccsm"] queries when boot_id changes across retryNow()',
    async () => {
      let bootSequence = ['boot-A', 'boot-B'];
      let bootIdx = 0;
      const helloResp = create(HelloResponseSchema, {
        daemonVersion: '0.3.0',
        protoVersion: 1,
        listenerId: 'A',
      });
      const queryClient = new QueryClient();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const onDaemonRestart = vi.fn();

      const Wrapper = wrapper(queryClient, {
        fetchDescriptor: async () => {
          const id = bootSequence[bootIdx];
          bootIdx = Math.min(bootIdx + 1, bootSequence.length - 1);
          return makeDescriptor(id);
        },
        buildTransport: () => makeStubTransport(() => helloResp),
        events: { onDaemonRestart },
      });

      const { result } = renderHook(() => useConnection(), { wrapper: Wrapper });

      // First connect — pins boot-A. No invalidation yet.
      await waitFor(() => {
        expect(result.current.state.kind).toBe('connected');
      });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['ccsm'] });
      expect(onDaemonRestart).not.toHaveBeenCalled();

      // Force a reconnect — descriptor now reports boot-B → daemon restarted.
      result.current.retryNow();

      await waitFor(() => {
        if (result.current.state.kind !== 'connected') return;
        expect(result.current.state.bootId).toBe('boot-B');
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ccsm'] });
      expect(onDaemonRestart).toHaveBeenCalledWith({
        previousBootId: 'boot-A',
        currentBootId: 'boot-B',
      });
    });

  it('does NOT invalidate when boot_id is unchanged across reconnect',
    async () => {
      const helloResp = create(HelloResponseSchema, {
        daemonVersion: '0.3.0',
        protoVersion: 1,
        listenerId: 'A',
      });
      const queryClient = new QueryClient();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const Wrapper = wrapper(queryClient, {
        fetchDescriptor: async () => makeDescriptor('boot-stable'),
        buildTransport: () => makeStubTransport(() => helloResp),
      });

      const { result } = renderHook(() => useConnection(), { wrapper: Wrapper });
      await waitFor(() => {
        expect(result.current.state.kind).toBe('connected');
      });
      result.current.retryNow();
      await waitFor(() => {
        if (result.current.state.kind !== 'connected') return;
        expect(result.current.state.bootId).toBe('boot-stable');
      });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['ccsm'] });
    });
});

describe('useConnection — provider guard', () => {
  it('throws a clear error when used without <ConnectionProvider>', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useConnection())).toThrow(/ConnectionProvider/);
    errSpy.mockRestore();
  });
});
