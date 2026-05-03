// T6.8 — useDaemonColdStartModal trigger-decider tests.
//
// @vitest-environment happy-dom
//
// Spec ref: chapter 08 §6.1.

import { create } from '@bufbuild/protobuf';
import { type Transport } from '@connectrpc/connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HelloResponseSchema } from '@ccsm/proto';

import {
  ConnectionProvider,
} from '../../../src/renderer/connection/use-connection.js';
import type { DescriptorV1 } from '../../../src/main/protocol-app.js';
import {
  COLD_START_BUDGET_MS,
  shouldShowColdStartModal,
  useDaemonColdStartModal,
} from '../../../src/renderer/components/use-daemon-cold-start-modal.js';

function descriptor(bootId: string): DescriptorV1 {
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

function transport(responder: () => unknown): Transport {
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

function buildWrapper(opts: {
  fetchDescriptor: () => Promise<DescriptorV1>;
  buildTransport: () => Transport;
}) {
  const queryClient = new QueryClient();
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        ConnectionProvider,
        {
          fetchDescriptor: opts.fetchDescriptor,
          buildTransport: opts.buildTransport,
        },
        children,
      ),
    );
  return Wrapper;
}

describe('shouldShowColdStartModal — pure decider', () => {
  it('stays closed when never connected and budget not yet elapsed', () => {
    expect(
      shouldShowColdStartModal({
        state: { kind: 'connecting', attempt: 0 },
        everConnected: false,
        elapsedMs: 7000,
      }),
    ).toBe(false);
  });

  it('opens once budget elapsed AND state is connecting', () => {
    expect(
      shouldShowColdStartModal({
        state: { kind: 'connecting', attempt: 3 },
        everConnected: false,
        elapsedMs: COLD_START_BUDGET_MS,
      }),
    ).toBe(true);
  });

  it('opens once budget elapsed AND state is reconnecting', () => {
    expect(
      shouldShowColdStartModal({
        state: {
          kind: 'reconnecting',
          attempt: 1,
          nextDelayMs: 200,
          previousBootId: null,
        },
        everConnected: false,
        elapsedMs: COLD_START_BUDGET_MS,
      }),
    ).toBe(true);
  });

  it('stays closed once connected (modal is dismissible only by Hello)', () => {
    expect(
      shouldShowColdStartModal({
        state: {
          kind: 'connected',
          bootId: 'b',
          daemonVersion: '0.3.0',
          protoVersion: 1,
          listenerId: 'A',
        },
        everConnected: true,
        elapsedMs: COLD_START_BUDGET_MS * 10,
      }),
    ).toBe(false);
  });

  it('stays closed for version-mismatch (different UX path)', () => {
    expect(
      shouldShowColdStartModal({
        state: {
          kind: 'version-mismatch',
          daemonProtoVersion: 0,
          clientMinVersion: 1,
        },
        everConnected: false,
        elapsedMs: COLD_START_BUDGET_MS,
      }),
    ).toBe(false);
  });

  it('stays closed if everConnected is true (steady-state reconnect, not cold-start)', () => {
    expect(
      shouldShowColdStartModal({
        state: {
          kind: 'reconnecting',
          attempt: 5,
          nextDelayMs: 1600,
          previousBootId: 'b',
        },
        everConnected: true,
        elapsedMs: COLD_START_BUDGET_MS * 10,
      }),
    ).toBe(false);
  });
});

describe('useDaemonColdStartModal — integration with T6.7 ConnectionProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after 8s when daemon never responds', async () => {
    // Transport that never resolves — emulates daemon-down. We can't await
    // forever; instead we time-bound the assertion to "open=true within
    // a few timer ticks past 8000ms".
    const Wrapper = buildWrapper({
      fetchDescriptor: () => new Promise(() => undefined), // never resolves
      buildTransport: () => transport(() => new Error('unused')),
    });

    const { result, unmount } = renderHook(() => useDaemonColdStartModal(), {
      wrapper: Wrapper,
    });

    expect(result.current.open).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLD_START_BUDGET_MS + 50);
    });

    expect(result.current.open).toBe(true);
    unmount();
  });

  it('does NOT open if Hello succeeds before the 8s budget elapses', async () => {
    const helloResp = create(HelloResponseSchema, {
      daemonVersion: '0.3.0',
      protoVersion: 1,
      listenerId: 'A',
    });

    const Wrapper = buildWrapper({
      fetchDescriptor: async () => descriptor('boot-X'),
      buildTransport: () => transport(() => helloResp),
    });

    const { result, unmount } = renderHook(() => useDaemonColdStartModal(), {
      wrapper: Wrapper,
    });

    // Drain microtasks — connect resolves on tick 1.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // Now blow past the budget. Modal must still be closed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLD_START_BUDGET_MS + 100);
    });

    expect(result.current.open).toBe(false);
    unmount();
  });

});

describe('useDaemonColdStartModal — retry proxies to ConnectionProvider.retryNow', () => {
  it('triggers a fresh connect attempt when onRetry is invoked', async () => {
    // Real timers for this test — `waitFor`'s polling collides with vitest
    // fake timers and the never-resolving paths above leave dangling
    // microtasks that crash the worker on shutdown.
    const fetchDescriptor = vi.fn(async () => descriptor('boot-X'));
    const helloResp = create(HelloResponseSchema, {
      daemonVersion: '0.3.0',
      protoVersion: 1,
      listenerId: 'A',
    });

    const Wrapper = buildWrapper({
      fetchDescriptor,
      buildTransport: () => transport(() => helloResp),
    });

    const { result, unmount } = renderHook(() => useDaemonColdStartModal(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(fetchDescriptor).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.onRetry();
    });

    await waitFor(() => {
      expect(fetchDescriptor).toHaveBeenCalledTimes(2);
    });

    // Tear down explicitly so the ConnectionProvider's retry loop is
    // aborted before vitest tries to exit the worker.
    unmount();
  });
});
