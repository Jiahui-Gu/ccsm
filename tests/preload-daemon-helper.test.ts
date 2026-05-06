// Task #629 — A1 unit tests for the lazy daemon-port cache + daemonFetch
// helper added to electron/preload/bridges/_daemon.ts.
//
// The bridge module imports `ipcRenderer` from `electron`; under jsdom we
// stub it with a vi.fn() invoke so the tests can drive port resolution
// deterministically. fetch is stubbed per-case via vi.spyOn(globalThis).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn<(channel: string) => Promise<number | null>>();

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (channel: string) => invoke(channel),
  },
}));

// Import after vi.mock so the bridge picks up the stubbed electron.
import {
  __resetDaemonPortCacheForTest,
  daemonFetch,
  DaemonHttpError,
  DaemonUnavailableError,
  getCachedDaemonPort,
} from '../electron/preload/bridges/_daemon';

beforeEach(() => {
  invoke.mockReset();
  __resetDaemonPortCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getCachedDaemonPort', () => {
  it('caches the resolved port across calls (single IPC invoke)', async () => {
    invoke.mockResolvedValue(54321);

    const a = await getCachedDaemonPort();
    const b = await getCachedDaemonPort();
    const c = await getCachedDaemonPort();

    expect(a).toBe(54321);
    expect(b).toBe(54321);
    expect(c).toBe(54321);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('daemon:getPort');
  });

  it('coalesces concurrent first calls into a single IPC invoke', async () => {
    let resolveInvoke!: (value: number | null) => void;
    invoke.mockReturnValueOnce(
      new Promise<number | null>((resolve) => {
        resolveInvoke = resolve;
      }),
    );

    const p1 = getCachedDaemonPort();
    const p2 = getCachedDaemonPort();
    const p3 = getCachedDaemonPort();

    resolveInvoke(7777);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect([r1, r2, r3]).toEqual([7777, 7777, 7777]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not cache null resolutions (retries next call)', async () => {
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(8888);

    const first = await getCachedDaemonPort();
    const second = await getCachedDaemonPort();

    expect(first).toBeNull();
    expect(second).toBe(8888);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('returns null when the IPC invoke rejects', async () => {
    invoke.mockRejectedValueOnce(new Error('handler missing'));

    const result = await getCachedDaemonPort();

    expect(result).toBeNull();
    // Cache cleared on null — next call retries.
    invoke.mockResolvedValueOnce(1234);
    expect(await getCachedDaemonPort()).toBe(1234);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('daemonFetch', () => {
  it('GETs the cached port and parses JSON', async () => {
    invoke.mockResolvedValue(40000);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, n: 3 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const result = await daemonFetch<{ ok: boolean; n: number }>('/api/state');

    expect(result).toEqual({ ok: true, n: 3 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:40000/api/state');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('POSTs JSON body with content-type when opts.json supplied', async () => {
    invoke.mockResolvedValue(40001);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await daemonFetch('/api/event', { json: { args: [1, 'two'] } });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:40001/api/event');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify({ args: [1, 'two'] }));
  });

  it('throws DaemonUnavailableError when port lookup yields null', async () => {
    invoke.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(daemonFetch('/api/state')).rejects.toBeInstanceOf(
      DaemonUnavailableError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws DaemonHttpError on non-2xx response', async () => {
    invoke.mockResolvedValue(40002);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 500, statusText: 'Internal Error' }),
    );

    await expect(daemonFetch('/api/state')).rejects.toMatchObject({
      name: 'DaemonHttpError',
      status: 500,
    });
  });

  it('returns undefined for 204 No Content responses', async () => {
    invoke.mockResolvedValue(40003);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const result = await daemonFetch('/api/event', { json: { args: [] } });
    expect(result).toBeUndefined();
  });

  it('propagates fetch rejections (e.g. abort / network)', async () => {
    invoke.mockResolvedValue(40004);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('network down'),
    );

    await expect(daemonFetch('/api/state')).rejects.toThrow('network down');
  });

  it('round-trips honoring an explicit method override', async () => {
    invoke.mockResolvedValue(40005);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await daemonFetch('/api/state', { method: 'DELETE' });

    expect(fetchSpy.mock.calls[0][1]?.method).toBe('DELETE');
  });
});
