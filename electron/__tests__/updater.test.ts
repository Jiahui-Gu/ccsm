import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ----------------------------------------------------------------------------
// Wave 0c (#217): the renderer-facing IPC + broadcast surface was removed.
// `installUpdater()` now only wires the autoUpdater event listeners + kicks
// off the periodic check loop; `getUpdaterStatus()` exposes the latest
// in-process state for diagnostics.
//
// We mock both 'electron' and 'electron-updater' because the real modules
// can't run in Node (electron needs the binary; electron-updater probes the
// runtime environment on import).
// ----------------------------------------------------------------------------

type Listener = (payload: unknown) => void;

const autoUpdaterEmitter = new EventEmitter();
// Use a mutable object so the mock factories can close over a stable reference
// across `vi.resetModules()` re-imports.
const state = {
  appIsPackaged: true,
  appVersion: '0.1.2',
  appName: 'CCSM',
  checkForUpdatesImpl: (async () => ({ updateInfo: {} })) as () => Promise<unknown>
};

vi.mock('electron', () => {
  const app = {
    get isPackaged() {
      return state.appIsPackaged;
    },
    getVersion: () => state.appVersion,
    getName: () => state.appName
  };
  return { app };
});

vi.mock('electron-updater', () => {
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    logger: null as unknown,
    on: (event: string, listener: Listener) => {
      autoUpdaterEmitter.on(event, listener);
    },
    checkForUpdates: () => state.checkForUpdatesImpl()
  };
  return { autoUpdater };
});

function resetState() {
  autoUpdaterEmitter.removeAllListeners();
  state.appIsPackaged = true;
  state.appVersion = '0.1.2';
  state.appName = 'CCSM';
  state.checkForUpdatesImpl = async () => ({ updateInfo: {} });
}

async function freshModule() {
  resetState();
  const mod = await import('../updater');
  mod.__resetUpdaterForTests();
  mod.installUpdater();
  return mod;
}

describe('updater (Wave 0c — shell-only, no renderer surface)', () => {
  beforeEach(async () => {
    await freshModule();
  });

  it('configures autoUpdater for autoDownload + autoInstallOnAppQuit', async () => {
    const { autoUpdater } = await import('electron-updater');
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('leaves allowPrerelease=false for the prod variant (#891)', async () => {
    const { autoUpdater } = await import('electron-updater');
    // Default reset state has appName='CCSM' so installUpdater must NOT
    // flip allowPrerelease — prod users only see stable releases.
    expect(autoUpdater.allowPrerelease).toBe(false);
  });

  it('flips allowPrerelease=true for the dev variant (#891)', async () => {
    state.appName = 'CCSM Dev';
    const mod = await import('../updater');
    mod.__resetUpdaterForTests();
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.allowPrerelease = false;
    mod.installUpdater();
    expect(autoUpdater.allowPrerelease).toBe(true);
  });

  it('records status on update-available', async () => {
    autoUpdaterEmitter.emit('update-available', { version: '1.2.3', releaseDate: '2026-01-01' });
    const mod = await import('../updater');
    expect(mod.getUpdaterStatus()).toEqual({
      kind: 'available',
      version: '1.2.3',
      releaseDate: '2026-01-01'
    });
  });

  it('records status on update-downloaded', async () => {
    autoUpdaterEmitter.emit('update-downloaded', { version: '1.2.3' });
    const mod = await import('../updater');
    expect(mod.getUpdaterStatus()).toEqual({ kind: 'downloaded', version: '1.2.3' });
  });

  it('records status on error', async () => {
    autoUpdaterEmitter.emit('error', new Error('network down'));
    const mod = await import('../updater');
    expect(mod.getUpdaterStatus()).toEqual({ kind: 'error', message: 'network down' });
  });

  it('records status on download-progress', async () => {
    autoUpdaterEmitter.emit('download-progress', {
      percent: 42,
      transferred: 4200,
      total: 10000
    });
    const mod = await import('../updater');
    expect(mod.getUpdaterStatus()).toEqual({
      kind: 'downloading',
      percent: 42,
      transferred: 4200,
      total: 10000
    });
  });

  it('initial periodic check sets `not-available` in dev (unpackaged)', async () => {
    // Re-init in unpackaged mode and verify the safeCheck() shortcut fires.
    state.appIsPackaged = false;
    const mod = await import('../updater');
    mod.__resetUpdaterForTests();
    mod.installUpdater();
    // safeCheck() runs synchronously up to the first await — wait one tick.
    await Promise.resolve();
    expect(mod.getUpdaterStatus()).toEqual({ kind: 'not-available', version: '0.1.2' });
  });

  it('installUpdater() is idempotent — repeated calls do not double-register listeners', async () => {
    const before = autoUpdaterEmitter.listenerCount('update-available');
    const mod = await import('../updater');
    mod.installUpdater();
    mod.installUpdater();
    const after = autoUpdaterEmitter.listenerCount('update-available');
    expect(after).toBe(before);
  });
});
