// Tests for the Connect-Node daemon client (Task #103).
//
// We focus on the parts that don't require a real HTTP/2 server:
//   - Listener A path resolution (mirrors daemon listenerA.ts).
//   - Backoff schedule (jitter math + clamp).
//   - enqueueCall queues vs. issues based on connected flag.
//   - close() rejects the queue.
//
// End-to-end Connect over a real socket is exercised by the integration
// suite (T11+ wave); here we keep tests fast and deterministic.

import { describe, expect, it } from 'vitest';
import {
  RECONNECT_BASE_DELAYS_MS,
  RECONNECT_MAX_DELAY_MS,
  createConnectClient,
  jitterDelay,
  nextBackoffMs,
  resolveListenerAPath,
} from '../connectClient';
import { createReconnectQueue } from '../reconnectQueue';
import { createDaemonSurfaceRegistry } from '../surfaceRegistry';
import { createTimeoutMap } from '../bridgeTimeout';

describe('resolveListenerAPath', () => {
  it('Linux: <runtimeDir>/ccsm-daemon-data.sock', () => {
    expect(
      resolveListenerAPath({ platform: 'linux', runtimeDir: '/run/ccsm' }),
    ).toBe('/run/ccsm/ccsm-daemon-data.sock');
  });
  it('Win32: \\\\.\\pipe\\ccsm-daemon-data-<sid>', () => {
    expect(
      resolveListenerAPath({ platform: 'win32', sid: 'S-1-5-21-X' }),
    ).toBe('\\\\.\\pipe\\ccsm-daemon-data-S-1-5-21-X');
  });
  it('throws on POSIX without runtimeDir', () => {
    expect(() => resolveListenerAPath({ platform: 'linux' })).toThrow(/runtimeDir/);
  });
  it('throws on Win32 without sid', () => {
    expect(() => resolveListenerAPath({ platform: 'win32' })).toThrow(/sid/);
  });
});

describe('backoff schedule', () => {
  it('matches frag-3.7 §3.7.4 base delays', () => {
    expect(RECONNECT_BASE_DELAYS_MS).toEqual([200, 400, 800, 1600, 3200, 5000]);
    expect(RECONNECT_MAX_DELAY_MS).toBe(5000);
  });

  it('jitterDelay: rand=0.5 → exact base', () => {
    expect(jitterDelay(1000, 0.5)).toBe(1000);
  });
  it('jitterDelay: rand=0 → -25% of base', () => {
    expect(jitterDelay(1000, 0)).toBe(750);
  });
  it('jitterDelay: rand approaching 1 → +25% of base', () => {
    expect(jitterDelay(1000, 0.999999)).toBeGreaterThanOrEqual(1249);
    expect(jitterDelay(1000, 0.999999)).toBeLessThanOrEqual(1250);
  });
  it('jitterDelay never returns below 1', () => {
    expect(jitterDelay(0, 0)).toBe(1);
  });
  it('nextBackoffMs clamps past last entry', () => {
    expect(nextBackoffMs(1, 0.5)).toBe(200);
    expect(nextBackoffMs(6, 0.5)).toBe(5000);
    expect(nextBackoffMs(99, 0.5)).toBe(5000);
  });
});

describe('createConnectClient', () => {
  function buildClient(): ReturnType<typeof createConnectClient> {
    return createConnectClient({
      socketPath: '/tmp/never-connects.sock',
      defaultTimeoutMs: 100,
      // Empty schedule = reconnect disabled, keeps test deterministic.
      reconnectBaseDelaysMs: [],
      surfaceRegistry: createDaemonSurfaceRegistry(),
      reconnectQueue: createReconnectQueue({ maxQueued: 5 }),
      timeoutMap: createTimeoutMap(),
      // netConnect should never actually fire in these tests because we
      // don't make any RPC that opens an HTTP/2 session — buildCallOptions
      // and enqueueCall logic both work without touching net.
      netConnect: () => {
        throw new Error('test should not open a real socket');
      },
    });
  }

  it('initial status is "connecting"', () => {
    const c = buildClient();
    const s = c.status();
    expect(s.state).toBe('connecting');
    expect(s.queuedCalls).toBe(0);
    expect(s.inFlightCalls).toBe(0);
  });

  it('enqueueCall queues when not connected; close → reject queued', async () => {
    const c = buildClient();
    let ran = false;
    const p = c.enqueueCall<string>({
      method: 'TestM',
      run: async () => {
        ran = true;
        return 'X';
      },
    });
    expect(c.status().queuedCalls).toBe(1);
    await c.close();
    await expect(p).rejects.toThrow(/daemon-client-closed/);
    expect(ran).toBe(false);
  });

  it('disconnect/reconnect listeners can be subscribed and unsubscribed', () => {
    const c = buildClient();
    let count = 0;
    const unsub = c.onDisconnected(() => {
      count += 1;
    });
    unsub();
    // No way to fire from outside without a real socket; subscribe-only sanity.
    expect(count).toBe(0);
  });

  it('buildCallOptions wires headers + signal + callId', () => {
    const c = buildClient();
    const opts = c.buildCallOptions({
      method: 'GetBootNonce',
      traceId: '01TRACE',
    });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.headers).toBeInstanceOf(Headers);
    expect((opts.headers as Headers).get('x-ccsm-deadline-ms')).toBe('100');
    expect((opts.headers as Headers).get('x-ccsm-trace-id')).toBe('01TRACE');
    expect(typeof opts.__callId).toBe('string');
    expect(opts.__callId.length).toBeGreaterThan(0);
    c.endCall(opts.__callId);
  });

  it('per-method timeout overrides default', () => {
    const c = createConnectClient({
      socketPath: '/tmp/x.sock',
      defaultTimeoutMs: 100,
      perMethodTimeoutMs: { GetPtyBufferSnapshot: 30000 },
      reconnectBaseDelaysMs: [],
      surfaceRegistry: createDaemonSurfaceRegistry(),
      reconnectQueue: createReconnectQueue({ maxQueued: 5 }),
      netConnect: () => {
        throw new Error('no socket');
      },
    });
    const opts = c.buildCallOptions({ method: 'GetPtyBufferSnapshot' });
    expect((opts.headers as Headers).get('x-ccsm-deadline-ms')).toBe('30000');
    c.endCall(opts.__callId);
  });

  it('per-call perMethodTimeoutMs override beats per-method map', () => {
    const c = createConnectClient({
      socketPath: '/tmp/x.sock',
      defaultTimeoutMs: 100,
      perMethodTimeoutMs: { Foo: 1000 },
      reconnectBaseDelaysMs: [],
      surfaceRegistry: createDaemonSurfaceRegistry(),
      reconnectQueue: createReconnectQueue({ maxQueued: 5 }),
      netConnect: () => {
        throw new Error('no socket');
      },
    });
    const opts = c.buildCallOptions({
      method: 'Foo',
      perMethodTimeoutMs: 5000,
    });
    expect((opts.headers as Headers).get('x-ccsm-deadline-ms')).toBe('5000');
    c.endCall(opts.__callId);
  });
});
