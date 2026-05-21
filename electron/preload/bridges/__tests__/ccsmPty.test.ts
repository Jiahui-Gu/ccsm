// Pins the `window.ccsmPty` preload bridge surface. This bridge fronts the
// in-process node-pty host (replaces ttyd) plus folds the CLI-availability
// probe and clipboard. `onData` / `onExit` use the same listener-set
// fan-out as ccsmSession so every TerminalPane mount doesn't leak a fresh
// ipcRenderer handler on the shared `pty:data` / `pty:exit` channels —
// that's the whole reason the bridge exists in this shape.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  exposeSpy,
  invokeSpy,
  onSpy,
  removeListenerSpy,
  clipboardReadSpy,
  clipboardWriteSpy,
} = vi.hoisted(() => ({
  exposeSpy: vi.fn(),
  invokeSpy: vi.fn(),
  onSpy: vi.fn(),
  removeListenerSpy: vi.fn(),
  clipboardReadSpy: vi.fn(() => 'clip-text'),
  clipboardWriteSpy: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeSpy },
  ipcRenderer: {
    invoke: invokeSpy,
    send: vi.fn(),
    on: onSpy,
    removeListener: removeListenerSpy,
  },
  clipboard: {
    readText: () => clipboardReadSpy(),
    writeText: (t: string) => clipboardWriteSpy(t),
  },
}));

import { installCcsmPtyBridge } from '../ccsmPty';

type AnyApi = Record<string, unknown>;

function lastApi(): AnyApi {
  const last = exposeSpy.mock.calls[exposeSpy.mock.calls.length - 1];
  expect(last[0]).toBe('ccsmPty');
  return last[1] as AnyApi;
}

describe('ccsmPty preload bridge', () => {
  beforeEach(() => {
    exposeSpy.mockClear();
    invokeSpy.mockReset();
    invokeSpy.mockResolvedValue(undefined);
    onSpy.mockReset();
    removeListenerSpy.mockReset();
    clipboardReadSpy.mockClear();
    clipboardWriteSpy.mockClear();
    installCcsmPtyBridge();
  });

  it('exposes a stable key set under "ccsmPty"', () => {
    const api = lastApi();
    expect(Object.keys(api).sort()).toEqual(
      [
        'attach',
        'checkClaudeAvailable',
        'clipboard',
        'detach',
        'get',
        'getBufferSnapshot',
        'input',
        'kill',
        'list',
        'onData',
        'onExit',
        'resize',
        'spawn',
      ].sort(),
    );
    expect(Object.keys(api.clipboard as AnyApi).sort()).toEqual(
      ['readText', 'writeText'].sort(),
    );
  });

  it('install registers fan-outs for "pty:data" and "pty:exit"', () => {
    const channels = onSpy.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(['pty:data', 'pty:exit'].sort());
  });

  it.each<[string, string, unknown[]]>([
    ['list', 'pty:list', []],
    ['spawn', 'pty:spawn', ['s1', '/cwd']],
    ['attach', 'pty:attach', ['s1']],
    ['detach', 'pty:detach', ['s1']],
    ['input', 'pty:input', ['s1', 'hello']],
    ['resize', 'pty:resize', ['s1', 80, 24]],
    ['kill', 'pty:kill', ['s1']],
    ['get', 'pty:get', ['s1']],
    ['getBufferSnapshot', 'pty:getBufferSnapshot', ['s1']],
  ])('forwards %s -> ipcRenderer.invoke("%s", ...)', async (m, chan, args) => {
    const api = lastApi();
    await (api[m] as (...a: unknown[]) => Promise<unknown>)(...args);
    expect(invokeSpy).toHaveBeenCalledWith(chan, ...args);
  });

  it('spawn with forkSourceSid forwards 3 args to pty:spawn', async () => {
    const api = lastApi();
    await (
      api.spawn as (sid: string, cwd: string, forkSourceSid?: string) => Promise<unknown>
    )('s1', '/cwd', 'source-sid');
    expect(invokeSpy).toHaveBeenCalledWith('pty:spawn', 's1', '/cwd', 'source-sid');
  });

  it('checkClaudeAvailable defaults its opts to {}', async () => {
    const api = lastApi();
    await (api.checkClaudeAvailable as (o?: unknown) => Promise<unknown>)();
    expect(invokeSpy).toHaveBeenCalledWith('pty:checkClaudeAvailable', {});
  });

  it('checkClaudeAvailable forwards explicit opts', async () => {
    const api = lastApi();
    await (
      api.checkClaudeAvailable as (o?: { force?: boolean }) => Promise<unknown>
    )({ force: true });
    expect(invokeSpy).toHaveBeenCalledWith('pty:checkClaudeAvailable', {
      force: true,
    });
  });

  it('clipboard.readText / writeText delegate to electron.clipboard', () => {
    const api = lastApi();
    const c = api.clipboard as { readText: () => string; writeText: (s: string) => void };
    expect(c.readText()).toBe('clip-text');
    expect(clipboardReadSpy).toHaveBeenCalledTimes(1);
    c.writeText('hi');
    expect(clipboardWriteSpy).toHaveBeenCalledWith('hi');
  });

  it('onData fan-out delivers payload, unsubscribe stops delivery', () => {
    const api = lastApi();
    const cb = vi.fn();
    const off = (api.onData as (cb: unknown) => () => void)(cb);
    const dispatch = onSpy.mock.calls.find((c) => c[0] === 'pty:data')![1] as (
      e: unknown,
      p: unknown,
    ) => void;
    const payload = { sid: 's1', chunk: 'abc', seq: 7 };
    dispatch({}, payload);
    expect(cb).toHaveBeenCalledWith(payload);
    off();
    dispatch({}, payload);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('onExit fan-out delivers payload, unsubscribe stops delivery', () => {
    const api = lastApi();
    const cb = vi.fn();
    const off = (api.onExit as (cb: unknown) => () => void)(cb);
    const dispatch = onSpy.mock.calls.find((c) => c[0] === 'pty:exit')![1] as (
      e: unknown,
      p: unknown,
    ) => void;
    const payload = { sessionId: 's1', code: 0, signal: null };
    dispatch({}, payload);
    expect(cb).toHaveBeenCalledWith(payload);
    off();
    dispatch({}, payload);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('throwing onData listener does not abort siblings', () => {
    const api = lastApi();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('x');
    });
    const good = vi.fn();
    (api.onData as (cb: unknown) => () => void)(bad);
    (api.onData as (cb: unknown) => () => void)(good);
    const dispatch = onSpy.mock.calls.find((c) => c[0] === 'pty:data')![1] as (
      e: unknown,
      p: unknown,
    ) => void;
    dispatch({}, { sid: 's', chunk: '', seq: 0 });
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
