import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ----------------------------------------------------------------------------
// Mocks
//
// We mock both 'electron' and 'electron-updater' because the real modules
// can't run in Node (electron needs the binary; electron-updater probes the
// runtime environment on import). The mocks preserve enough behavior to
// verify our IPC wiring: handlers registered, status broadcasts emitted,
// periodic check scheduled.
// ----------------------------------------------------------------------------

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
type Listener = (payload: unknown) => void;

const ipcHandlers = new Map<string, IpcHandler>();
const webContentsSends: Array<{ channel: string; payload: unknown }> = [];
const autoUpdaterEmitter = new EventEmitter();
// Use a mutable object so the mock factories can close over a stable reference
// across `vi.resetModules()` re-imports. Reassigning primitives like
// `appIsPackaged = false` wouldn't take effect after reset, because the new
// mock factory snapshots its own binding — but a property on a persistent
// object works because the object identity survives.
const state = {
  appIsPackaged: true,
  appVersion: '0.1.2',
  appName: 'CCSM',
  checkForUpdatesImpl: (async () => ({ updateInfo: {} })) as () => Promise<unknown>,
  downloadUpdateImpl: (async () => undefined) as () => Promise<unknown>
};
const quitAndInstallCalls: Array<{ isSilent: boolean; isForceRunAfter: boolean }> = [];

vi.mock('electron', () => {
  const ipcMain = {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler);
    }
  };
  const BrowserWindow = {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) =>
            webContentsSends.push({ channel, payload })
        }
      }
    ]
  };
  const app = {
    get isPackaged() {
      return state.appIsPackaged;
    },
    getVersion: () => state.appVersion,
    getName: () => state.appName
  };
  return { ipcMain, BrowserWindow, app };
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
    checkForUpdates: () => state.checkForUpdatesImpl(),
    downloadUpdate: () => state.downloadUpdateImpl(),
    quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => {
      quitAndInstallCalls.push({ isSilent, isForceRunAfter });
    }
  };
  return { autoUpdater };
});

function resetState() {
  ipcHandlers.clear();
  webContentsSends.length = 0;
  autoUpdaterEmitter.removeAllListeners();
  quitAndInstallCalls.length = 0;
  state.appIsPackaged = true;
  state.appVersion = '0.1.2';
  state.appName = 'CCSM';
  state.checkForUpdatesImpl = async () => ({ updateInfo: {} });
  state.downloadUpdateImpl = async () => undefined;
}

async function freshModule() {
  resetState();
  const mod = await import('../updater');
  mod.__resetUpdaterForTests();
  // Auto-update gate (frag-6-7 §7.3, Task #137): production default is OFF
  // (env opt-in). The existing IPC-wiring suite asserts the autoDownload /
  // autoInstall path; force gate ON so that branch fires. Verify-OFF / gate-
  // OFF behavior is covered by the dedicated verify.test.ts suite.
  mod.__setAutoUpdateGateForTests(true);
  // Stub the verify chain so install tests don't try to read real
  // SLSA/minisign sidecars from disk.
  const verifySlsa = await import('../updater/verifySlsa');
  verifySlsa.__setVerifyImpl(async () => ({ ok: true }));
  const verifyMinisign = await import('../updater/verifyMinisign');
  verifyMinisign.__setMinisignRunner(async () => ({ code: 0, stderr: '' }));
  mod.installUpdaterIpc();
  return mod;
}

function sendsFor(channel: string) {
  return webContentsSends.filter((s) => s.channel === channel).map((s) => s.payload);
}

describe('updater: IPC wiring', () => {
  beforeEach(async () => {
    await freshModule();
  });

  it('registers all expected ipc handlers', () => {
    const expected = [
      'updates:status',
      'updates:check',
      'updates:download',
      'updates:install',
      'updates:getAutoCheck',
      'updates:setAutoCheck'
    ];
    for (const ch of expected) {
      expect(ipcHandlers.has(ch), `missing handler: ${ch}`).toBe(true);
    }
  });

  it('configures autoUpdater for autoDownload + autoInstallOnAppQuit', async () => {
    const { autoUpdater } = await import('electron-updater');
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('leaves allowPrerelease=false for the prod variant (#891)', async () => {
    const { autoUpdater } = await import('electron-updater');
    // Default reset state has appName='CCSM' so installUpdaterIpc must NOT
    // flip allowPrerelease — prod users only see stable releases.
    expect(autoUpdater.allowPrerelease).toBe(false);
  });

  it('flips allowPrerelease=true for the dev variant (#891)', async () => {
    // Override appName before re-importing so the dual-install branch fires.
    state.appName = 'CCSM Dev';
    const mod = await import('../updater');
    mod.__resetUpdaterForTests();
    // Reset the mock field too — module-scoped mock object survives across
    // freshModule() calls in beforeEach, so the prior installUpdaterIpc may
    // have left it at its default. Force a known starting point.
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.allowPrerelease = false;
    mod.installUpdaterIpc();
    expect(autoUpdater.allowPrerelease).toBe(true);
  });

  it('broadcasts status on update-available and fires update:available channel', () => {
    autoUpdaterEmitter.emit('update-available', { version: '1.2.3', releaseDate: '2026-01-01' });

    const statusSends = sendsFor('updates:status');
    expect(statusSends).toContainEqual({
      kind: 'available',
      version: '1.2.3',
      releaseDate: '2026-01-01'
    });

    const availableSends = sendsFor('update:available');
    expect(availableSends).toContainEqual({ version: '1.2.3', releaseDate: '2026-01-01' });
  });

  it('broadcasts status on update-downloaded and fires update:downloaded channel', () => {
    autoUpdaterEmitter.emit('update-downloaded', { version: '1.2.3', downloadedFile: '/tmp/x.AppImage' });

    expect(sendsFor('updates:status')).toContainEqual({ kind: 'downloaded', version: '1.2.3' });
    expect(sendsFor('update:downloaded')).toContainEqual({ version: '1.2.3' });
  });

  it('broadcasts status on error and fires update:error channel', () => {
    autoUpdaterEmitter.emit('error', new Error('network down'));

    expect(sendsFor('updates:status')).toContainEqual({ kind: 'error', message: 'network down' });
    expect(sendsFor('update:error')).toContainEqual({ message: 'network down' });
  });

  it('updates:check returns not-available in dev (unpackaged) without calling autoUpdater', async () => {
    // Switch to dev mode after the default freshModule() in beforeEach; the
    // app.isPackaged getter reads state at call time so this takes effect.
    state.appIsPackaged = false;

    let checkCalled = false;
    state.checkForUpdatesImpl = async () => {
      checkCalled = true;
      return { updateInfo: {} };
    };

    const handler = ipcHandlers.get('updates:check')!;
    const result = await handler({});
    expect(result).toEqual({ kind: 'not-available', version: '0.1.2' });
    expect(checkCalled).toBe(false);
  });

  it('updates:check surfaces autoUpdater errors through the status channel', async () => {
    state.checkForUpdatesImpl = async () => {
      throw new Error('boom');
    };
    const handler = ipcHandlers.get('updates:check')!;
    const result = (await handler({})) as { kind: string; message: string };
    expect(result.kind).toBe('error');
    expect(result.message).toBe('boom');
    expect(sendsFor('updates:status')).toContainEqual({ kind: 'error', message: 'boom' });
  });

  it('updates:install calls quitAndInstall with visible installer + relaunch', async () => {
    // Defense-in-depth gate (#TBD): updates:install refuses unless
    // lastStatus is `downloaded`. Drive the broadcast first so the
    // handler can proceed.
    autoUpdaterEmitter.emit('update-downloaded', { version: '0.1.3', downloadedFile: '/tmp/x.AppImage' });
    const handler = ipcHandlers.get('updates:install')!;
    const res = await handler({});
    expect(res).toEqual({ ok: true });
    // quitAndInstall is scheduled via setImmediate — flush it.
    await new Promise((r) => setImmediate(r));
    expect(quitAndInstallCalls).toEqual([{ isSilent: false, isForceRunAfter: true }]);
  });

  it('updates:install refuses when no download has completed', async () => {
    // No `update-downloaded` event broadcast → lastStatus stays `idle`.
    // The defense-in-depth gate must short-circuit before quitAndInstall.
    const handler = ipcHandlers.get('updates:install')!;
    const res = await handler({});
    expect(res).toEqual({ ok: false, reason: 'not-ready' });
    expect(quitAndInstallCalls).toEqual([]);
  });

  it('updates:install refuses when not packaged', async () => {
    state.appIsPackaged = false;
    const handler = ipcHandlers.get('updates:install')!;
    const res = await handler({});
    expect(res).toEqual({ ok: false, reason: 'not-packaged' });
  });

  it('updates:download proxies to autoUpdater.downloadUpdate()', async () => {
    let called = false;
    state.downloadUpdateImpl = async () => {
      called = true;
    };
    const handler = ipcHandlers.get('updates:download')!;
    const res = await handler({});
    expect(res).toEqual({ ok: true });
    expect(called).toBe(true);
  });

  it('updates:setAutoCheck toggles the preference', async () => {
    const setHandler = ipcHandlers.get('updates:setAutoCheck')!;
    const getHandler = ipcHandlers.get('updates:getAutoCheck')!;
    expect(await getHandler({})).toBe(true);
    expect(await setHandler({}, false)).toBe(false);
    expect(await getHandler({})).toBe(false);
    expect(await setHandler({}, true)).toBe(true);
  });

  it('updates:status returns the last broadcast status', async () => {
    autoUpdaterEmitter.emit('update-available', { version: '9.9.9' });
    const handler = ipcHandlers.get('updates:status')!;
    const res = await handler({});
    expect(res).toEqual({ kind: 'available', version: '9.9.9', releaseDate: undefined });
  });
});

// ----------------------------------------------------------------------------
// T62 — Upgrade-shutdown RPC (frag-11 §11.6.5)
//
// Before quitAndInstall, the install handler MUST send daemon.shutdownForUpgrade
// over the control socket and wait up to 5 s for the ack. On ack OR timeout
// (per spec step 3-4), proceed with the existing update flow. The transport is
// injected via setUpgradeShutdownRpc; tests pass fakes.
// ----------------------------------------------------------------------------

describe('updater: T62 upgrade-shutdown RPC', () => {
  beforeEach(async () => {
    await freshModule();
  });

  it('default (no rpc wired) resolves immediately and proceeds with quitAndInstall', async () => {
    autoUpdaterEmitter.emit('update-downloaded', { version: '0.1.3', downloadedFile: '/tmp/x.AppImage' });
    const handler = ipcHandlers.get('updates:install')!;
    const res = await handler({});
    expect(res).toEqual({ ok: true });
    await new Promise((r) => setImmediate(r));
    expect(quitAndInstallCalls).toHaveLength(1);
  });

  it('callShutdownForUpgrade returns acked when the rpc resolves', async () => {
    const mod = await import('../updater');
    const ack = { accepted: true as const, reason: 'upgrade' as const };
    mod.setUpgradeShutdownRpc(async () => ack);
    const outcome = await mod.callShutdownForUpgrade();
    expect(outcome).toEqual({ kind: 'acked', ack });
  });

  it('callShutdownForUpgrade returns timeout when the rpc never resolves (5 s)', async () => {
    vi.useFakeTimers();
    try {
      const mod = await import('../updater');
      mod.setUpgradeShutdownRpc(() => new Promise(() => undefined));
      const promise = mod.callShutdownForUpgrade();
      await vi.advanceTimersByTimeAsync(mod.UPGRADE_SHUTDOWN_ACK_TIMEOUT_MS);
      const outcome = await promise;
      expect(outcome).toEqual({ kind: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('callShutdownForUpgrade returns error when the rpc rejects', async () => {
    const mod = await import('../updater');
    mod.setUpgradeShutdownRpc(async () => {
      throw new Error('socket closed');
    });
    const outcome = await mod.callShutdownForUpgrade();
    expect(outcome).toEqual({ kind: 'error', message: 'socket closed' });
  });

  it('updates:install awaits the shutdown RPC before scheduling quitAndInstall', async () => {
    const mod = await import('../updater');
    const order: string[] = [];
    let releaseRpc: (() => void) | null = null;
    mod.setUpgradeShutdownRpc(
      () =>
        new Promise((resolve) => {
          releaseRpc = () => {
            order.push('rpc-resolved');
            resolve({ accepted: true, reason: 'upgrade' });
          };
        }),
    );

    autoUpdaterEmitter.emit('update-downloaded', { version: '0.1.4', downloadedFile: '/tmp/x.AppImage' });
    const handler = ipcHandlers.get('updates:install')!;
    const promise = handler({});

    // Give the handler a microtask tick — it should be parked on the RPC,
    // NOT yet have called quitAndInstall.
    await new Promise((r) => setImmediate(r));
    expect(quitAndInstallCalls).toEqual([]);

    releaseRpc!();
    const res = await promise;
    expect(res).toEqual({ ok: true });
    // setImmediate flush for the scheduled quitAndInstall.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['rpc-resolved']);
    expect(quitAndInstallCalls).toEqual([{ isSilent: false, isForceRunAfter: true }]);
  });

  it('updates:install proceeds with quitAndInstall after RPC timeout', async () => {
    vi.useFakeTimers();
    try {
      const mod = await import('../updater');
      mod.setUpgradeShutdownRpc(() => new Promise(() => undefined));
      autoUpdaterEmitter.emit('update-downloaded', { version: '0.1.5', downloadedFile: '/tmp/x.AppImage' });
      const handler = ipcHandlers.get('updates:install')!;
      const promise = handler({});
      await vi.advanceTimersByTimeAsync(mod.UPGRADE_SHUTDOWN_ACK_TIMEOUT_MS);
      const res = await promise;
      expect(res).toEqual({ ok: true });
      // Drain the scheduled setImmediate while still on fake timers — switching
      // to real timers first would drop the queued callback.
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await new Promise((r) => setImmediate(r));
      expect(quitAndInstallCalls).toEqual([{ isSilent: false, isForceRunAfter: true }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates:install proceeds with quitAndInstall even when RPC errors', async () => {
    const mod = await import('../updater');
    mod.setUpgradeShutdownRpc(async () => {
      throw new Error('control socket EPIPE');
    });
    autoUpdaterEmitter.emit('update-downloaded', { version: '0.1.6', downloadedFile: '/tmp/x.AppImage' });
    const handler = ipcHandlers.get('updates:install')!;
    const res = await handler({});
    expect(res).toEqual({ ok: true });
    await new Promise((r) => setImmediate(r));
    expect(quitAndInstallCalls).toEqual([{ isSilent: false, isForceRunAfter: true }]);
  });
});
