// Pins the `window.ccsmNotify` preload bridge — small surface (one fan-out
// + one one-way send), but the IPC channel names are wire contracts with
// `electron/notify/sinks/flashSink.ts` and the decider's Rule 1 input
// mute. Renaming either side without the other silently breaks the
// AgentIcon flash halo or the 60s post-input toast suppression.

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

import { installCcsmNotifyBridge } from '../ccsmNotify';

type AnyApi = Record<string, unknown>;

function lastApi(): AnyApi {
  const last = exposeSpy.mock.calls[exposeSpy.mock.calls.length - 1];
  expect(last[0]).toBe('ccsmNotify');
  return last[1] as AnyApi;
}

describe('ccsmNotify preload bridge', () => {
  beforeEach(() => {
    exposeSpy.mockClear();
    sendSpy.mockReset();
    onSpy.mockReset();
    removeListenerSpy.mockReset();
    installCcsmNotifyBridge();
  });

  it('exposes a stable key set under "ccsmNotify"', () => {
    const api = lastApi();
    expect(Object.keys(api).sort()).toEqual(['markUserInput', 'onFlash'].sort());
  });

  it('install registers exactly one fan-out on "notify:flash"', () => {
    const calls = onSpy.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(['notify:flash']);
  });

  it('onFlash fan-out delivers payload, unsubscribe stops delivery', () => {
    const api = lastApi();
    const cb = vi.fn();
    const off = (api.onFlash as (cb: unknown) => () => void)(cb);
    const dispatch = onSpy.mock.calls.find((c) => c[0] === 'notify:flash')![1] as (
      e: unknown,
      p: unknown,
    ) => void;
    dispatch({}, { sid: 's1', on: true });
    expect(cb).toHaveBeenCalledWith({ sid: 's1', on: true });
    off();
    dispatch({}, { sid: 's1', on: false });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('throwing onFlash listener does not abort siblings', () => {
    const api = lastApi();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('x');
    });
    const good = vi.fn();
    (api.onFlash as (cb: unknown) => () => void)(bad);
    (api.onFlash as (cb: unknown) => () => void)(good);
    const dispatch = onSpy.mock.calls.find((c) => c[0] === 'notify:flash')![1] as (
      e: unknown,
      p: unknown,
    ) => void;
    dispatch({}, { sid: 's', on: true });
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('markUserInput sends one-way notify:userInput', () => {
    const api = lastApi();
    (api.markUserInput as (sid: string) => void)('s-42');
    expect(sendSpy).toHaveBeenCalledWith('notify:userInput', 's-42');
  });

  it('markUserInput("") is a no-op (does NOT send)', () => {
    const api = lastApi();
    (api.markUserInput as (sid: string) => void)('');
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
