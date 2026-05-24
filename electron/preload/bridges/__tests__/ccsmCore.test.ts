// Pins the `window.ccsm` preload bridge surface. Each entry in the IPC
// surface is a renderer-visible API that callers (src/stores/persist.ts,
// src/stores/drafts.ts, the StatusBar cwd popover, the in-app updater
// dialog, the CloseActionDialog, etc.) bind to early at boot. Silent
// removal or rename of any key would brick those callers with no compiler
// signal — the preload runs in its own isolated module graph that's only
// linked at runtime via `contextBridge.exposeInMainWorld`. These tests
// freeze the shape and the IPC channel mapping so a future refactor must
// touch this file too. Channel names are a wire contract with the main
// process (`electron/ipc/*Ipc.ts` handlers); rename one without updating
// the matching handler and the renderer call hangs forever waiting for
// `invoke` to resolve.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DB_CHANNELS, UPDATE_CHANNELS, UPDATES_CHANNELS, WINDOW_CHANNELS } from '../../../shared/ipcChannels';

const { exposeSpy, invokeSpy, sendSpy, onSpy, removeListenerSpy } = vi.hoisted(() => ({
  exposeSpy: vi.fn(),
  invokeSpy: vi.fn(),
  sendSpy: vi.fn(),
  onSpy: vi.fn(),
  removeListenerSpy: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeSpy },
  ipcRenderer: {
    invoke: invokeSpy,
    send: sendSpy,
    on: onSpy,
    removeListener: removeListenerSpy,
  },
}));

import { installCcsmCoreBridge } from '../ccsmCore';

type AnyApi = Record<string, unknown>;

function getApi(): AnyApi {
  expect(exposeSpy).toHaveBeenCalled();
  const last = exposeSpy.mock.calls[exposeSpy.mock.calls.length - 1];
  expect(last[0]).toBe('ccsm');
  return last[1] as AnyApi;
}

describe('ccsmCore preload bridge', () => {
  beforeEach(() => {
    exposeSpy.mockClear();
    invokeSpy.mockReset();
    invokeSpy.mockResolvedValue(undefined);
    sendSpy.mockReset();
    onSpy.mockReset();
    removeListenerSpy.mockReset();
    installCcsmCoreBridge();
  });

  it('exposes a stable top-level key set under "ccsm"', () => {
    const api = getApi();
    expect(Object.keys(api).sort()).toEqual(
      [
        'defaultModel',
        'featureFlags',
        'getVersion',
        'i18n',
        'loadState',
        'onUpdateDownloaded',
        'onUpdateStatus',
        'openExternal',
        'pathsExist',
        'pickCwd',
        'recentCwds',
        'saveState',
        'scanImportable',
        'updatesCheck',
        'updatesDownload',
        'updatesGetAutoCheck',
        'updatesInstall',
        'updatesSetAutoCheck',
        'updatesStatus',
        'userCwds',
        'userHome',
        'window',
      ].sort(),
    );
  });

  it('exposes featureFlags as a static boolean snapshot from process.env', () => {
    // The module already imported once at file top; the values it captured
    // reflect process.env at THAT point, not at test-run time. We can't
    // re-import after mutating env without a vi.resetModules() dance, so
    // assert the structural shape and types — not the values, which depend
    // on the CI process's env (default: both falsy).
    const api = getApi();
    const ff = api.featureFlags as { warmXterm: unknown; warmXtermCap: unknown };
    expect(Object.keys(ff).sort()).toEqual(['warmXterm', 'warmXtermCap']);
    expect(typeof ff.warmXterm).toBe('boolean');
    expect(ff.warmXtermCap === null || typeof ff.warmXtermCap === 'number').toBe(true);
  });

  it('nests i18n / userCwds / window with their own stable keys', () => {
    const api = getApi();
    expect(Object.keys(api.i18n as AnyApi).sort()).toEqual(
      ['getSystemLocale', 'setLanguage'].sort(),
    );
    expect(Object.keys(api.userCwds as AnyApi).sort()).toEqual(
      ['get', 'push'].sort(),
    );
    expect(Object.keys(api.window as AnyApi).sort()).toEqual(
      [
        'close',
        'isMaximized',
        'minimize',
        'onAfterShow',
        'onAskCloseAction',
        'onBeforeHide',
        'onMaximizedChanged',
        'platform',
        'resolveCloseAction',
        'toggleMaximize',
      ].sort(),
    );
  });

  it.each<[string, string, unknown[]]>([
    ['loadState', DB_CHANNELS.load, ['some.key']],
    ['getVersion', 'app:getVersion', []],
    ['scanImportable', 'import:scan', []],
    ['recentCwds', 'import:recentCwds', []],
    ['userHome', 'app:userHome', []],
    ['pickCwd', 'cwd:pick', [undefined]],
    ['defaultModel', 'settings:defaultModel', []],
    ['pathsExist', 'paths:exist', [['/a', '/b']]],
    ['openExternal', 'ccsm:openExternal', ['https://example.com']],
    ['updatesStatus', UPDATES_CHANNELS.status, []],
    ['updatesCheck', UPDATES_CHANNELS.check, []],
    ['updatesDownload', UPDATES_CHANNELS.download, []],
    ['updatesInstall', UPDATES_CHANNELS.install, []],
    ['updatesGetAutoCheck', UPDATES_CHANNELS.getAutoCheck, []],
    ['updatesSetAutoCheck', UPDATES_CHANNELS.setAutoCheck, [true]],
  ])('forwards %s -> ipcRenderer.invoke("%s", ...)', async (m, chan, args) => {
    const api = getApi();
    const fn = api[m] as (...a: unknown[]) => Promise<unknown>;
    await fn(...args);
    if (m === 'pickCwd') {
      // Bridge wraps the optional defaultPath in an object literal.
      expect(invokeSpy).toHaveBeenCalledWith(chan, { defaultPath: args[0] });
    } else {
      expect(invokeSpy).toHaveBeenCalledWith(chan, ...args);
    }
  });

  it('saveState unwraps {ok:true} silently', async () => {
    invokeSpy.mockResolvedValueOnce({ ok: true });
    const api = getApi();
    await expect(
      (api.saveState as (k: string, v: string) => Promise<void>)('k', 'v'),
    ).resolves.toBeUndefined();
    expect(invokeSpy).toHaveBeenCalledWith(DB_CHANNELS.save, 'k', 'v');
  });

  it('saveState rethrows on {ok:false} so .catch handlers fire', async () => {
    invokeSpy.mockResolvedValueOnce({ ok: false, error: 'disk-full' });
    const api = getApi();
    await expect(
      (api.saveState as (k: string, v: string) => Promise<void>)('k', 'v'),
    ).rejects.toThrow('disk-full');
  });

  it('i18n.getSystemLocale invokes ccsm:get-system-locale', async () => {
    const api = getApi();
    await (api.i18n as { getSystemLocale: () => Promise<unknown> }).getSystemLocale();
    expect(invokeSpy).toHaveBeenCalledWith('ccsm:get-system-locale');
  });

  it('i18n.setLanguage sends one-way ccsm:set-language', () => {
    const api = getApi();
    (api.i18n as { setLanguage: (l: 'en' | 'zh') => void }).setLanguage('zh');
    expect(sendSpy).toHaveBeenCalledWith('ccsm:set-language', 'zh');
  });

  it('userCwds.get / push forward to app:userCwds:* channels', async () => {
    const api = getApi();
    const u = api.userCwds as {
      get: () => Promise<unknown>;
      push: (p: string) => Promise<unknown>;
    };
    await u.get();
    expect(invokeSpy).toHaveBeenCalledWith('app:userCwds:get');
    await u.push('/tmp/x');
    expect(invokeSpy).toHaveBeenCalledWith('app:userCwds:push', '/tmp/x');
  });

  it.each<[string, string, unknown[]]>([
    ['minimize', WINDOW_CHANNELS.minimize, []],
    ['toggleMaximize', WINDOW_CHANNELS.toggleMaximize, []],
    ['close', WINDOW_CHANNELS.close, []],
    ['isMaximized', WINDOW_CHANNELS.isMaximized, []],
  ])('window.%s invokes "%s"', async (m, chan, args) => {
    const api = getApi();
    const w = api.window as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await w[m](...args);
    expect(invokeSpy).toHaveBeenCalledWith(chan, ...args);
  });

  it('window.resolveCloseAction sends one-way window:resolveCloseAction', () => {
    const api = getApi();
    const payload = {
      requestId: 'req-1',
      choice: 'tray' as const,
      dontAskAgain: false,
    };
    (
      api.window as { resolveCloseAction: (p: typeof payload) => void }
    ).resolveCloseAction(payload);
    expect(sendSpy).toHaveBeenCalledWith(WINDOW_CHANNELS.resolveCloseAction, payload);
  });

  it('window.platform mirrors process.platform', () => {
    const api = getApi();
    expect((api.window as { platform: string }).platform).toBe(process.platform);
  });

  // ---- Listener registration & unsubscribe round-trip --------------------
  // Each `on*` call must (a) register an ipcRenderer listener on the right
  // channel and (b) hand back an unsubscribe that calls removeListener with
  // the EXACT SAME wrap function reference. Mismatching identities would
  // make the unsubscribe a silent no-op and leak a handler on every dialog
  // open / window-state change.
  it.each<[string, string]>([
    ['onUpdateStatus', UPDATES_CHANNELS.status],
    ['onUpdateDownloaded', UPDATE_CHANNELS.downloaded],
  ])('%s registers and cleanly unsubscribes on "%s"', (m, chan) => {
    const api = getApi();
    const cb = vi.fn();
    const off = (api[m] as (cb: unknown) => () => void)(cb);
    expect(onSpy).toHaveBeenCalled();
    const matching = onSpy.mock.calls.find((c) => c[0] === chan);
    expect(matching).toBeDefined();
    const wrap = matching![1];
    off();
    expect(removeListenerSpy).toHaveBeenCalledWith(chan, wrap);
  });

  it.each<[string, string]>([
    ['onMaximizedChanged', WINDOW_CHANNELS.maximizedChanged],
    ['onBeforeHide', WINDOW_CHANNELS.beforeHide],
    ['onAfterShow', WINDOW_CHANNELS.afterShow],
    ['onAskCloseAction', WINDOW_CHANNELS.askCloseAction],
  ])('window.%s registers and unsubscribes on "%s"', (m, chan) => {
    const api = getApi();
    const w = api.window as Record<string, (cb: unknown) => () => void>;
    const cb = vi.fn();
    const off = w[m](cb);
    const matching = onSpy.mock.calls.find((c) => c[0] === chan);
    expect(matching).toBeDefined();
    const wrap = matching![1];
    off();
    expect(removeListenerSpy).toHaveBeenCalledWith(chan, wrap);
  });

  it('onUpdateStatus wrap forwards payload through to user handler', () => {
    const api = getApi();
    const cb = vi.fn();
    (api.onUpdateStatus as (cb: unknown) => () => void)(cb);
    const wrap = onSpy.mock.calls.find((c) => c[0] === UPDATES_CHANNELS.status)![1] as (
      e: unknown,
      p: unknown,
    ) => void;
    wrap({}, { kind: 'idle' });
    expect(cb).toHaveBeenCalledWith({ kind: 'idle' });
  });

  it('window.onAskCloseAction wrap forwards labels payload', () => {
    const api = getApi();
    const cb = vi.fn();
    (
      api.window as {
        onAskCloseAction: (cb: unknown) => () => void;
      }
    ).onAskCloseAction(cb);
    const wrap = onSpy.mock.calls.find(
      (c) => c[0] === WINDOW_CHANNELS.askCloseAction,
    )![1] as (e: unknown, p: unknown) => void;
    const payload = {
      requestId: 'req-2',
      labels: {
        message: 'm',
        detail: 'd',
        tray: 't',
        quit: 'q',
        cancel: 'c',
        dontAskAgain: 'a',
      },
    };
    wrap({}, payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });
});
