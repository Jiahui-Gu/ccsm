// T6.7 — Hello + version-mismatch + boot_id surfacing UT.
//
// Spec ref: ch03 §3.3 (boot_id verification) + ch08 §6 (version mismatch
// error contract).

import { create } from '@bufbuild/protobuf';
import { ConnectError, Code, type Transport } from '@connectrpc/connect';
import { describe, expect, it, vi } from 'vitest';

import { HelloResponseSchema, SessionService } from '@ccsm/proto';
import {
  performHello,
  HelloVersionMismatchError,
  DescriptorFetchError,
  RENDERER_PROTO_MIN_VERSION,
} from '../../../src/renderer/connection/hello.js';
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
  responder: (method: string) => unknown,
): { transport: Transport; calls: string[] } {
  const calls: string[] = [];
  const transport: Transport = {
    async unary(method, _signal, _timeoutMs, _header, _input, _ctxValues) {
      calls.push(method.name);
      const response = responder(method.name);
      if (response instanceof Error) throw response;
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
      throw new Error('stream not used');
    },
  };
  return { transport, calls };
}

describe('performHello', () => {
  it('resolves with descriptor boot_id + daemon version on success', async () => {
    const helloResp = create(HelloResponseSchema, {
      daemonVersion: '0.3.0',
      protoVersion: RENDERER_PROTO_MIN_VERSION,
      listenerId: 'A',
    });
    const { transport, calls } = makeStubTransport(() => helloResp);

    const result = await performHello({
      fetchDescriptor: async () => makeDescriptor('boot-A'),
      buildTransport: () => transport,
    });

    expect(result.bootId).toBe('boot-A');
    expect(result.daemonVersion).toBe('0.3.0');
    expect(result.protoVersion).toBe(RENDERER_PROTO_MIN_VERSION);
    expect(result.listenerId).toBe('A');
    expect(calls).toEqual(['Hello']);
  });

  it('treats Connect FailedPrecondition as a version mismatch (non-retryable)',
    async () => {
      const { transport } = makeStubTransport(() => {
        return new ConnectError(
          'client too old',
          Code.FailedPrecondition,
        );
      });

      await expect(
        performHello({
          fetchDescriptor: async () => makeDescriptor('boot-A'),
          buildTransport: () => transport,
        }),
      ).rejects.toBeInstanceOf(HelloVersionMismatchError);
    });

  it('treats daemon protoVersion < client floor as version mismatch', async () => {
    const helloResp = create(HelloResponseSchema, {
      daemonVersion: '0.2.0',
      protoVersion: 0, // below floor of 1
      listenerId: 'A',
    });
    const { transport } = makeStubTransport(() => helloResp);

    await expect(
      performHello({
        fetchDescriptor: async () => makeDescriptor('boot-A'),
        buildTransport: () => transport,
        protoMinVersion: 1,
      }),
    ).rejects.toBeInstanceOf(HelloVersionMismatchError);
  });

  it('propagates Unavailable as a regular Connect error (caller retries)',
    async () => {
      const { transport } = makeStubTransport(() => {
        return new ConnectError('daemon down', Code.Unavailable);
      });

      const promise = performHello({
        fetchDescriptor: async () => makeDescriptor('boot-A'),
        buildTransport: () => transport,
      });
      await expect(promise).rejects.toBeInstanceOf(ConnectError);
      await expect(promise).rejects.not.toBeInstanceOf(HelloVersionMismatchError);
    });

  it('wraps descriptor fetch failures as DescriptorFetchError', async () => {
    const { transport } = makeStubTransport(() => null);
    await expect(
      performHello({
        fetchDescriptor: async () => {
          throw new Error('fetch failed');
        },
        buildTransport: () => transport,
      }),
    ).rejects.toBeInstanceOf(DescriptorFetchError);
  });

  it('re-fetches descriptor on every call (no in-memory caching)', async () => {
    // Spec ch03 §3.3 step 5: every reconnect re-reads the file. This test
    // proves performHello does not memoize the fetcher.
    const helloResp = create(HelloResponseSchema, {
      daemonVersion: '0.3.0',
      protoVersion: RENDERER_PROTO_MIN_VERSION,
      listenerId: 'A',
    });
    const { transport } = makeStubTransport(() => helloResp);
    const fetchDescriptor = vi
      .fn<() => Promise<DescriptorV1>>()
      .mockResolvedValueOnce(makeDescriptor('boot-A'))
      .mockResolvedValueOnce(makeDescriptor('boot-B'));

    const r1 = await performHello({ fetchDescriptor, buildTransport: () => transport });
    const r2 = await performHello({ fetchDescriptor, buildTransport: () => transport });

    expect(r1.bootId).toBe('boot-A');
    expect(r2.bootId).toBe('boot-B');
    expect(fetchDescriptor).toHaveBeenCalledTimes(2);
  });

  // Sanity: assert the proto wire surface this module relies on hasn't drifted.
  it('uses SessionService.Hello (asserts wire shape, not transport impl)', () => {
    expect(SessionService.method.hello).toBeDefined();
    expect(SessionService.method.hello.name).toBe('Hello');
  });
});
