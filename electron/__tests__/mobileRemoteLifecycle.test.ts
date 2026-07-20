import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const order: string[] = [];
  const createWindow = vi.fn(() => {
    order.push('window');
    return {};
  });
  const registerPty = vi.fn(() => order.push('pty'));
  const registerMobileIpc = vi.fn(() => order.push('mobile-ipc'));
  const startLoopback = vi.fn();
  const lifecycle = vi.fn();
  const windows: Array<{ webContents: { send: ReturnType<typeof vi.fn> } }> = [];
  const app = {
    isPackaged: false,
    getName: vi.fn(() => 'CCSM'),
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
  };
  return {
    order,
    createWindow,
    registerPty,
    registerMobileIpc,
    startLoopback,
    lifecycle,
    windows,
    app,
  };
});

vi.mock('electron', () => ({
  app: h.app,
  BrowserWindow: { getAllWindows: () => h.windows },
  ipcMain: {},
}));
vi.mock('../db', () => ({ initDb: vi.fn(), closeDb: vi.fn() }));
vi.mock('../branding/icon', () => ({ buildTrayIcon: vi.fn() }));
vi.mock('../sentry/init', () => ({ initSentry: vi.fn() }));
vi.mock('../shared/log', () => ({
  initLog: vi.fn(),
  log: { error: vi.fn() },
  normalizeError: vi.fn(),
  syncPersistedLevelFromDb: vi.fn(() => false),
}));
vi.mock('../window/createWindow', () => ({ createWindow: h.createWindow }));
vi.mock('../window/contextMenu', () => ({ installContextMenuSuppressIpc: vi.fn() }));
vi.mock('../tray/createTray', () => ({
  createTray: vi.fn(() => ({ tray: null, applyLocale: vi.fn() })),
}));
vi.mock('../updater', () => ({ installUpdaterIpc: vi.fn() }));
vi.mock('../ptyHost', () => ({
  registerPtyHostIpc: h.registerPty,
  killAllPtySessions: vi.fn(),
}));
vi.mock('../sessionWatcher', () => ({ configureSessionWatcher: vi.fn() }));
vi.mock('../notify/badge', () => ({ BadgeManager: class {} }));
vi.mock('../notify/bootstrap/installPipeline', () => ({
  installNotifyPipelineWithProducers: vi.fn(() => ({
    pipeline: { setActiveSid: vi.fn(), markUserInput: vi.fn() },
    dispose: vi.fn(),
  })),
}));
vi.mock('../sessionTitles', () => ({
  getSessionTitle: vi.fn(),
  flushPendingRename: vi.fn(),
}));
vi.mock('../prefs/notifyEnabled', () => ({
  loadNotifyEnabled: vi.fn(() => true),
  subscribeNotifyEnabledInvalidation: vi.fn(),
}));
vi.mock('../prefs/crashReporting', () => ({ subscribeCrashReportingInvalidation: vi.fn() }));
vi.mock('../prefs/scrollback', () => ({ subscribeScrollbackInvalidation: vi.fn() }));
vi.mock('../prefs/voiceTier', () => ({ subscribeVoiceTierInvalidation: vi.fn() }));
vi.mock('../prefs/voiceLanguage', () => ({ subscribeVoiceLanguageInvalidation: vi.fn() }));
vi.mock('../badgeController', () => ({
  BadgeController: class {
    onFocusChange = vi.fn();
  },
}));
vi.mock('../ipc/dbIpc', () => ({ registerDbIpc: vi.fn() }));
vi.mock('../ipc/systemIpc', () => ({ registerSystemIpc: vi.fn() }));
vi.mock('../ipc/sessionIpc', () => ({ registerSessionIpc: vi.fn() }));
vi.mock('../ipc/windowIpc', () => ({ registerWindowIpc: vi.fn() }));
vi.mock('../ipc/voiceIpc', () => ({ registerVoiceIpc: vi.fn() }));
vi.mock('../ipc/mobileRemoteIpc', () => ({ registerMobileRemoteIpc: h.registerMobileIpc }));
vi.mock('../voice/warmup', () => ({ warmUpTranscriber: vi.fn() }));
vi.mock('../remote/mobileRemoteServer', () => ({ startMobileRemoteServer: h.startLoopback }));
vi.mock('../ipc/utilityIpc', () => ({
  registerUtilityIpc: vi.fn(),
  primeImportableCache: vi.fn(),
}));
vi.mock('../lifecycle/appLifecycle', () => ({
  applyAppMenuLocale: vi.fn(),
  registerLifecycleHandlers: h.lifecycle,
}));
vi.mock('../lifecycle/singleInstance', () => ({ acquireSingleInstanceLock: vi.fn() }));
vi.mock('../testHooks', () => ({
  installEarlyTestHooks: vi.fn(),
  installLateTestHooks: vi.fn(),
}));

describe('mobile remote main lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    h.order.length = 0;
    h.windows.length = 0;
    delete process.env.CCSM_MOBILE_REMOTE;
    vi.spyOn(process, 'on').mockImplementation(() => process);
  });

  it('does not block window startup when the post-ready controller import rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('../remote/mobileRemoteController', () => {
      h.order.push('controller-import');
      throw new Error('relay module unavailable');
    });

    await import('../main');
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        '[mobile-remote] public controller failed after app ready',
        expect.any(Error),
      );
    });

    expect(h.createWindow).toHaveBeenCalledTimes(1);
    expect(h.order.indexOf('controller-import')).toBeGreaterThan(h.order.indexOf('window'));
    expect(h.order.indexOf('controller-import')).toBeGreaterThan(h.order.indexOf('mobile-ipc'));
    expect(h.order.indexOf('controller-import')).toBeGreaterThan(h.order.indexOf('pty'));
    expect(h.startLoopback).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('publishes the controller status immediately after startup', async () => {
    const send = vi.fn();
    h.windows.push({ webContents: { send } });
    vi.doMock('../remote/mobileRemoteController', () => ({
      createMobileRemoteController: vi.fn(async () => ({
        getStatus: vi.fn(() => ({
          kind: 'unavailable',
          reason: 'secure-storage-unavailable',
        })),
        getPairingUrl: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        rotate: vi.fn(),
        subscribe: vi.fn(() => vi.fn()),
        close: vi.fn(),
      })),
    }));

    await import('../main');

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith('mobileRemote:status', {
        kind: 'unavailable',
        reason: 'secure-storage-unavailable',
      });
    });
  });

  it('closes loopback and public controllers independently during shutdown', async () => {
    const loopbackClose = vi.fn(() => {
      throw new Error('loopback close failed');
    });
    const publicClose = vi.fn();
    let publishStatus: ((status: { kind: 'paused' }) => void) | null = null;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.startLoopback.mockReturnValue({ close: loopbackClose });
    process.env.CCSM_MOBILE_REMOTE = '1';
    vi.doMock('../remote/mobileRemoteController', () => ({
      createMobileRemoteController: vi.fn(async () => ({
        getStatus: vi.fn(),
        getPairingUrl: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        rotate: vi.fn(),
        subscribe: vi.fn((handler) => {
          publishStatus = handler;
          return vi.fn();
        }),
        close: publicClose,
      })),
    }));

    await import('../main');
    await vi.waitFor(() => {
      expect(h.registerMobileIpc.mock.calls[0][0].getController()).not.toBeNull();
    });
    const send = vi.fn();
    h.windows.push({ webContents: { send } });
    expect(publishStatus).not.toBeNull();
    (publishStatus as (status: { kind: 'paused' }) => void)({ kind: 'paused' });
    expect(send).toHaveBeenCalledWith('mobileRemote:status', { kind: 'paused' });
    const deps = h.lifecycle.mock.calls[0][0];
    deps.disposeNotifyPipeline();

    expect(loopbackClose).toHaveBeenCalledTimes(1);
    expect(publicClose).toHaveBeenCalledTimes(1);
    delete process.env.CCSM_MOBILE_REMOTE;
    warnSpy.mockRestore();
  });
});
