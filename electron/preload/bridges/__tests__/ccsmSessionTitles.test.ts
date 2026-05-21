// Pins the `window.ccsmSessionTitles` preload bridge. Pure invoke
// pass-through to the main-process sessionTitles module — the substrate
// (per-sid serialization, 2s TTL, ENOENT classification, pending-rename
// queue) all lives on main. The renderer surface is small but every
// channel is a wire contract with `electron/sessionTitles/index.ts`
// handlers; rename one without the other and the renderer rename action
// hangs forever.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { exposeSpy, invokeSpy } = vi.hoisted(() => ({
  exposeSpy: vi.fn(),
  invokeSpy: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeSpy },
  ipcRenderer: {
    invoke: invokeSpy,
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import { installCcsmSessionTitlesBridge } from '../ccsmSessionTitles';

type AnyApi = Record<string, unknown>;

function lastApi(): AnyApi {
  const last = exposeSpy.mock.calls[exposeSpy.mock.calls.length - 1];
  expect(last[0]).toBe('ccsmSessionTitles');
  return last[1] as AnyApi;
}

describe('ccsmSessionTitles preload bridge', () => {
  beforeEach(() => {
    exposeSpy.mockClear();
    invokeSpy.mockReset();
    invokeSpy.mockResolvedValue(undefined);
    installCcsmSessionTitlesBridge();
  });

  it('exposes a stable key set under "ccsmSessionTitles"', () => {
    const api = lastApi();
    expect(Object.keys(api).sort()).toEqual(
      [
        'enqueuePending',
        'flushPending',
        'get',
        'listForProject',
        'rename',
      ].sort(),
    );
  });

  it.each<[string, string, unknown[]]>([
    ['get', 'sessionTitles:get', ['sid-1', '/some/dir']],
    ['get', 'sessionTitles:get', ['sid-1', undefined]],
    ['rename', 'sessionTitles:rename', ['sid-1', 'New Title', '/d']],
    ['rename', 'sessionTitles:rename', ['sid-1', 'New Title', undefined]],
    ['listForProject', 'sessionTitles:listForProject', ['proj-key']],
    [
      'enqueuePending',
      'sessionTitles:enqueuePending',
      ['sid-1', 'Title', '/d'],
    ],
    ['flushPending', 'sessionTitles:flushPending', ['sid-1']],
  ])('forwards %s -> ipcRenderer.invoke("%s", ...)', async (m, chan, args) => {
    const api = lastApi();
    await (api[m] as (...a: unknown[]) => Promise<unknown>)(...args);
    expect(invokeSpy).toHaveBeenLastCalledWith(chan, ...args);
  });
});
