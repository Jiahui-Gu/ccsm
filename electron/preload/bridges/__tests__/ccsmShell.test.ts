// Pins the `window.ccsmShell` preload bridge — single one-shot for
// renderer-driven native-context-menu suppression (Task #41). The IPC
// channel name `shell:suppressContextMenuOnce` is a wire contract with
// `installContextMenuSuppressIpc` in electron/window/createWindow.ts;
// renaming one side silently breaks the terminal pane's right-click
// inline copy/paste UX (the native menu races on top).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { exposeSpy, sendSpy } = vi.hoisted(() => ({
  exposeSpy: vi.fn(),
  sendSpy: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeSpy },
  ipcRenderer: {
    invoke: vi.fn(),
    send: sendSpy,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import { installCcsmShellBridge } from '../ccsmShell';

type AnyApi = Record<string, unknown>;

function lastApi(): AnyApi {
  const last = exposeSpy.mock.calls[exposeSpy.mock.calls.length - 1];
  expect(last[0]).toBe('ccsmShell');
  return last[1] as AnyApi;
}

describe('ccsmShell preload bridge', () => {
  beforeEach(() => {
    exposeSpy.mockClear();
    sendSpy.mockReset();
    installCcsmShellBridge();
  });

  it('exposes a stable key set under "ccsmShell"', () => {
    const api = lastApi();
    expect(Object.keys(api).sort()).toEqual(['suppressContextMenuOnce']);
  });

  it('suppressContextMenuOnce sends one-way IPC on the canonical channel', () => {
    const api = lastApi();
    (api.suppressContextMenuOnce as () => void)();
    expect(sendSpy).toHaveBeenCalledWith('shell:suppressContextMenuOnce');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('repeated calls send one IPC each (no internal coalescing)', () => {
    const api = lastApi();
    (api.suppressContextMenuOnce as () => void)();
    (api.suppressContextMenuOnce as () => void)();
    (api.suppressContextMenuOnce as () => void)();
    // Main side handles coalescing via its deadline; bridge stays dumb.
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });
});
