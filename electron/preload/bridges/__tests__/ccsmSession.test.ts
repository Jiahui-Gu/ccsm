// Pins the `window.ccsmSession` preload bridge surface. This bridge owns
// 4 listener-set fan-outs (state / activate / title / cwdRedirected) — the
// install function registers ONE ipcRenderer.on per channel and dispatches
// to the renderer-side Set, so multiple subscribers (Sidebar, notify integration,
// store hydration) don't each leak a handler on the shared channel. We
// verify (a) exposed shape, (b) one-way setters forward to the right channel,
// and (c) each fan-out actually delivers the payload to a registered cb
// AND that the returned unsubscribe drops it from the Set so subsequent
// pushes don't re-fire.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { exposeSpy, sendSpy, onSpy, removeListenerSpy } = vi.hoisted(() => ({
  exposeSpy: vi.fn(),
  sendSpy: vi.fn(),
  onSpy: vi.fn(),
  removeListenerSpy: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeSpy },
  ipcRenderer: {
    invoke: vi.fn(),
    send: sendSpy,
    on: onSpy,
    removeListener: removeListenerSpy,
  },
}));

import { installCcsmSessionBridge } from '../ccsmSession';

type AnyApi = Record<string, unknown>;

function lastApi(): AnyApi {
  const last = exposeSpy.mock.calls[exposeSpy.mock.calls.length - 1];
  expect(last[0]).toBe('ccsmSession');
  return last[1] as AnyApi;
}

function findRegisteredHandler(chan: string): (e: unknown, payload: unknown) => void {
  const match = onSpy.mock.calls.find((c) => c[0] === chan);
  expect(match, `no ipcRenderer.on registration for ${chan}`).toBeDefined();
  return match![1] as (e: unknown, payload: unknown) => void;
}

describe('ccsmSession preload bridge', () => {
  beforeEach(() => {
    exposeSpy.mockClear();
    sendSpy.mockReset();
    onSpy.mockReset();
    removeListenerSpy.mockReset();
    installCcsmSessionBridge();
  });

  it('exposes a stable key set under "ccsmSession"', () => {
    const api = lastApi();
    expect(Object.keys(api).sort()).toEqual(
      [
        'onActivate',
        'onCwdRedirected',
        'onState',
        'onTitle',
        'setActive',
        'setName',
      ].sort(),
    );
  });

  it('install registers exactly the 4 fan-out channels on ipcRenderer', () => {
    const channels = onSpy.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(
      [
        'session:state',
        'session:title',
        'session:cwdRedirected',
        'session:activate',
      ].sort(),
    );
  });

  it.each<[string, string, unknown]>([
    ['onState', 'session:state', { sid: 's1', state: 'running' }],
    ['onActivate', 'session:activate', { sid: 's1' }],
    ['onTitle', 'session:title', { sid: 's1', title: 'hi' }],
    [
      'onCwdRedirected',
      'session:cwdRedirected',
      { sid: 's1', newCwd: '/new/cwd' },
    ],
  ])('%s subscribes to %s fan-out and unsubscribe stops delivery', (m, chan, payload) => {
    const api = lastApi();
    const cb = vi.fn();
    const off = (api[m] as (cb: unknown) => () => void)(cb);

    const dispatch = findRegisteredHandler(chan);
    dispatch({}, payload);
    expect(cb).toHaveBeenCalledWith(payload);
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    dispatch({}, payload);
    // After unsubscribe, no further deliveries.
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers all receive the same payload (fan-out)', () => {
    const api = lastApi();
    const cbA = vi.fn();
    const cbB = vi.fn();
    (api.onState as (cb: unknown) => () => void)(cbA);
    (api.onState as (cb: unknown) => () => void)(cbB);
    const dispatch = findRegisteredHandler('session:state');
    dispatch({}, { sid: 's2', state: 'idle' });
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not abort delivery to siblings', () => {
    const api = lastApi();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    (api.onState as (cb: unknown) => () => void)(bad);
    (api.onState as (cb: unknown) => () => void)(good);
    findRegisteredHandler('session:state')({}, { sid: 's', state: 'idle' });
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('setActive sends "session:setActive" with sid (or empty string for null)', () => {
    const api = lastApi();
    const fn = api.setActive as (s: string | null) => void;
    fn('s-123');
    expect(sendSpy).toHaveBeenCalledWith('session:setActive', 's-123');
    fn(null);
    expect(sendSpy).toHaveBeenCalledWith('session:setActive', '');
  });

  it('setName sends "session:setName" with normalized null name', () => {
    const api = lastApi();
    const fn = api.setName as (sid: string, n: string | null) => void;
    fn('s-1', 'Friendly');
    expect(sendSpy).toHaveBeenCalledWith('session:setName', {
      sid: 's-1',
      name: 'Friendly',
    });
    fn('s-1', null);
    expect(sendSpy).toHaveBeenCalledWith('session:setName', {
      sid: 's-1',
      name: '',
    });
  });

  it('setName with empty sid is a no-op (does NOT send)', () => {
    const api = lastApi();
    (api.setName as (sid: string, n: string | null) => void)('', 'x');
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
