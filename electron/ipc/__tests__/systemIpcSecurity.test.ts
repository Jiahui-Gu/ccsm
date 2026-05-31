// Security gate around the `ccsm:set-language` IPC handler.
//
// `set-language` mutates main-process app language and rebuilds the tray /
// app accelerator menus. It is state-mutating and privileged, so it must
// confirm the message came from our top-level renderer frame before acting.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('electron', () => ({}));
vi.mock('../../agent/read-default-model', () => ({
  readDefaultModelFromSettings: async () => null,
}));

// Mock the security guard. Default: accept; tests can flip to reject.
let allowGuard = true;
vi.mock('../../security/ipcGuards', () => ({
  fromMainFrame: (_e: unknown) => allowGuard,
}));

// systemIpc.ts loads i18n through a dynamic `require('../i18n')`; under vitest
// node can't resolve the bare `.ts`, so patch Module.prototype.require to hand
// back a stub (same approach as electron/shared/__tests__/log.test.ts).
const setMainLanguageMock = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module') as typeof import('node:module');
const ModuleProto = (Module as unknown as { prototype: { require: (id: string) => unknown } })
  .prototype;
const originalRequire = ModuleProto.require;
ModuleProto.require = function patchedRequire(this: NodeJS.Module, id: string) {
  if (id === '../i18n') {
    return {
      setMainLanguage: (l: string) => setMainLanguageMock(l),
      resolveSystemLanguage: (_l: string) => 'en',
    };
  }
  return originalRequire.call(this, id);
};

afterAll(() => {
  ModuleProto.require = originalRequire;
});

import { registerSystemIpc } from '../systemIpc';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (ch: string, fn: Handler) => handlers.set(ch, fn),
    on: (ch: string, fn: Handler) => handlers.set(ch, fn),
  } as unknown as Electron.IpcMain;
  return { ipcMain, handlers };
}

const fakeEvent = {} as Electron.IpcMainEvent;

describe('ccsm:set-language security gate', () => {
  let setLanguage: Handler;
  let applyAppMenuLocale: ReturnType<typeof vi.fn>;
  let applyTrayLocale: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    allowGuard = true;
    setMainLanguageMock.mockClear();
    applyAppMenuLocale = vi.fn();
    applyTrayLocale = vi.fn();
    const { ipcMain, handlers } = fakeIpcMain();
    registerSystemIpc({
      ipcMain,
      app: { getLocale: () => 'en-US', getVersion: () => '0.0.0' } as unknown as Electron.App,
      applyAppMenuLocale,
      applyTrayLocale,
    });
    // registerSystemIpc seeds the language once at boot — clear so the test
    // only observes calls triggered by the handler.
    setMainLanguageMock.mockClear();
    applyAppMenuLocale.mockClear();
    applyTrayLocale.mockClear();
    setLanguage = handlers.get('ccsm:set-language')!;
    expect(setLanguage).toBeDefined();
  });

  it('applies the language when the sender is the main frame', () => {
    setLanguage(fakeEvent, 'zh');
    expect(setMainLanguageMock).toHaveBeenCalledWith('zh');
    expect(applyTrayLocale).toHaveBeenCalled();
    expect(applyAppMenuLocale).toHaveBeenCalled();
  });

  it('does nothing when the sender is not the main frame', () => {
    allowGuard = false;
    setLanguage(fakeEvent, 'zh');
    expect(setMainLanguageMock).not.toHaveBeenCalled();
    expect(applyTrayLocale).not.toHaveBeenCalled();
    expect(applyAppMenuLocale).not.toHaveBeenCalled();
  });
});
