import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { UPDATE_CHANNELS, UPDATES_CHANNELS } from '../shared/ipcChannels';

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

// Stub the structured logger so test runs under plain Node don't try to
// initialize electron-log (which requires the electron binary). We capture
// `log.event` calls so the new observability probes can be asserted.
const logEventCalls: Array<{ name: string; fields: Record<string, unknown> | undefined }> = [];
vi.mock('../shared/log', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    event: (name: string, fields?: Record<string, unknown>) => {
      logEventCalls.push({ name, fields });
    },
  },
}));

function resetState() {
  ipcHandlers.clear();
  webContentsSends.length = 0;
  autoUpdaterEmitter.removeAllListeners();
  quitAndInstallCalls.length = 0;
  logEventCalls.length = 0;
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
      UPDATES_CHANNELS.status,
      UPDATES_CHANNELS.check,
      UPDATES_CHANNELS.download,
      UPDATES_CHANNELS.install,
      UPDATES_CHANNELS.getAutoCheck,
      UPDATES_CHANNELS.setAutoCheck
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

    const statusSends = sendsFor(UPDATES_CHANNELS.status);
    expect(statusSends).toContainEqual({
      kind: 'available',
      version: '1.2.3',
      releaseDate: '2026-01-01'
    });

    const availableSends = sendsFor(UPDATE_CHANNELS.available);
    expect(availableSends).toContainEqual({ version: '1.2.3', releaseDate: '2026-01-01' });
  });

  it('broadcasts status on update-downloaded and fires update:downloaded channel', () => {
    autoUpdaterEmitter.emit('update-downloaded', { version: '1.2.3' });

    expect(sendsFor(UPDATES_CHANNELS.status)).toContainEqual({ kind: 'downloaded', version: '1.2.3' });
    expect(sendsFor(UPDATE_CHANNELS.downloaded)).toContainEqual({ version: '1.2.3' });
  });

  it('broadcasts status on error and fires update:error channel', () => {
    autoUpdaterEmitter.emit('error', new Error('network down'));

    expect(sendsFor(UPDATES_CHANNELS.status)).toContainEqual({ kind: 'error', message: 'network down' });
    expect(sendsFor(UPDATE_CHANNELS.error)).toContainEqual({ message: 'network down' });
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

    const handler = ipcHandlers.get(UPDATES_CHANNELS.check)!;
    const result = await handler({});
    expect(result).toEqual({ kind: 'not-available', version: '0.1.2' });
    expect(checkCalled).toBe(false);
  });

  it('updates:check surfaces autoUpdater errors through the status channel', async () => {
    state.checkForUpdatesImpl = async () => {
      throw new Error('boom');
    };
    const handler = ipcHandlers.get(UPDATES_CHANNELS.check)!;
    const result = (await handler({})) as { kind: string; message: string };
    expect(result.kind).toBe('error');
    expect(result.message).toBe('boom');
    expect(sendsFor(UPDATES_CHANNELS.status)).toContainEqual({ kind: 'error', message: 'boom' });
  });

  it('updates:install calls quitAndInstall silently + relaunch', async () => {
    // Defense-in-depth gate (#TBD): updates:install refuses unless
    // lastStatus is `downloaded`. Drive the broadcast first so the
    // handler can proceed.
    autoUpdaterEmitter.emit('update-downloaded', { version: '0.1.3' });
    const handler = ipcHandlers.get(UPDATES_CHANNELS.install)!;
    const res = handler({});
    expect(res).toEqual({ ok: true });
    // quitAndInstall is scheduled via setImmediate — flush it.
    await new Promise((r) => setImmediate(r));
    // isSilent=true pairs with NSIS oneClick=true to give a VSCode-style
    // restart-and-done UX — no installer wizard, no progress popup.
    expect(quitAndInstallCalls).toEqual([{ isSilent: true, isForceRunAfter: true }]);
  });

  it('updates:install refuses when no download has completed', () => {
    // No `update-downloaded` event broadcast → lastStatus stays `idle`.
    // The defense-in-depth gate must short-circuit before quitAndInstall.
    const handler = ipcHandlers.get(UPDATES_CHANNELS.install)!;
    const res = handler({});
    expect(res).toEqual({ ok: false, reason: 'not-ready' });
    expect(quitAndInstallCalls).toEqual([]);
  });

  it('updates:install refuses when not packaged', async () => {
    state.appIsPackaged = false;
    const handler = ipcHandlers.get(UPDATES_CHANNELS.install)!;
    const res = handler({});
    expect(res).toEqual({ ok: false, reason: 'not-packaged' });
  });

  it('updates:download proxies to autoUpdater.downloadUpdate()', async () => {
    let called = false;
    state.downloadUpdateImpl = async () => {
      called = true;
    };
    const handler = ipcHandlers.get(UPDATES_CHANNELS.download)!;
    const res = await handler({});
    expect(res).toEqual({ ok: true });
    expect(called).toBe(true);
  });

  it('updates:setAutoCheck toggles the preference', async () => {
    const setHandler = ipcHandlers.get(UPDATES_CHANNELS.setAutoCheck)!;
    const getHandler = ipcHandlers.get(UPDATES_CHANNELS.getAutoCheck)!;
    expect(await getHandler({})).toBe(true);
    expect(await setHandler({}, false)).toBe(false);
    expect(await getHandler({})).toBe(false);
    expect(await setHandler({}, true)).toBe(true);
  });

  it('updates:status returns the last broadcast status', async () => {
    autoUpdaterEmitter.emit('update-available', { version: '9.9.9' });
    const handler = ipcHandlers.get(UPDATES_CHANNELS.status)!;
    const res = await handler({});
    expect(res).toEqual({ kind: 'available', version: '9.9.9', releaseDate: undefined });
  });

  it('exports CHECK_INTERVAL_MS as exactly 1 hour (matches hourly release cadence)', async () => {
    const mod = await import('../updater');
    // Match `.github/workflows/hourly-tag-release.yml` cron `0 * * * *`. Going
    // lower hammers GitHub Releases; going higher (the prior 4h value) leaves
    // long-running sessions stuck on stale builds. If this constant changes,
    // double-check the release workflow's cadence still matches.
    expect(mod.CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it('emits updater.check.start + updater.check.result probes on startup', async () => {
    // freshModule() in beforeEach already triggered installUpdaterIpc which
    // calls safeCheck('startup'). Drain microtasks so the async probe lands.
    await new Promise((r) => setImmediate(r));
    const names = logEventCalls.map((c) => c.name);
    expect(names).toContain('updater.check.start');
    expect(names).toContain('updater.check.result');
    expect(names).toContain('updater.poll.scheduled');
    const start = logEventCalls.find((c) => c.name === 'updater.check.start')!;
    expect(start.fields).toMatchObject({ reason: 'startup', currentVersion: '0.1.2' });
    const scheduled = logEventCalls.find((c) => c.name === 'updater.poll.scheduled')!;
    expect(scheduled.fields).toEqual({ intervalMs: 60 * 60 * 1000 });
  });

  it('emits updater.error probe when autoUpdater check rejects', async () => {
    state.checkForUpdatesImpl = async () => {
      const e = new Error('boom') as Error & { code?: string };
      e.code = 'ERR_UPDATER_INVALID_UPDATE_INFO';
      throw e;
    };
    const handler = ipcHandlers.get(UPDATES_CHANNELS.check)!;
    await handler({});
    const errProbe = logEventCalls.find((c) => c.name === 'updater.error');
    expect(errProbe).toBeTruthy();
    expect(errProbe!.fields).toMatchObject({
      reason: 'manual',
      code: 'ERR_UPDATER_INVALID_UPDATE_INFO',
      currentVersion: '0.1.2',
    });
  });

  it('emits releaseDate on updater.check.result when electron-updater reports it', async () => {
    state.checkForUpdatesImpl = async () => ({
      updateInfo: { version: '9.9.9', releaseDate: '2026-05-24T00:00:00Z' },
    });
    const handler = ipcHandlers.get(UPDATES_CHANNELS.check)!;
    await handler({});
    const result = [...logEventCalls]
      .reverse()
      .find((c) => c.name === 'updater.check.result');
    expect(result).toBeTruthy();
    expect(result!.fields).toMatchObject({
      reason: 'manual',
      currentVersion: '0.1.2',
      latestVersion: '9.9.9',
      releaseDate: '2026-05-24T00:00:00Z',
      available: true,
    });
  });
});

// Separate describe with fake timers so the wider IPC-wiring suite above
// doesn't pay the timer-mocking cost. Verifies the recurring poll actually
// fires at CHECK_INTERVAL_MS — guards against future regressions where the
// interval value diverges from the call-site or the timer never gets armed.
describe('updater: periodic poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires a fresh updater.check.start { reason: "poll" } every CHECK_INTERVAL_MS', async () => {
    await freshModule();
    const mod = await import('../updater');

    // Drain microtasks for the startup `safeCheck('startup')` without
    // ticking the interval timer (which would loop forever — setInterval
    // re-arms itself so `runAllTimersAsync` aborts with an infinite-loop
    // guard). Two microtask flushes cover the await in `safeCheck`.
    await Promise.resolve();
    await Promise.resolve();

    const startupStarts = logEventCalls.filter(
      (c) => c.name === 'updater.check.start',
    );
    expect(startupStarts).toHaveLength(1);
    expect(startupStarts[0]!.fields).toMatchObject({ reason: 'startup' });

    // Advance exactly one interval — the setInterval callback fires
    // `safeCheck('poll')`.
    await vi.advanceTimersByTimeAsync(mod.CHECK_INTERVAL_MS);
    let pollStarts = logEventCalls.filter(
      (c) => c.name === 'updater.check.start' && c.fields?.reason === 'poll',
    );
    expect(pollStarts).toHaveLength(1);

    // Second interval — proves it's a recurring setInterval, not a
    // one-shot setTimeout. This is the regression we care about: a
    // future refactor that accidentally swaps setInterval for setTimeout
    // would pass the single-tick assertion but fail here.
    await vi.advanceTimersByTimeAsync(mod.CHECK_INTERVAL_MS);
    pollStarts = logEventCalls.filter(
      (c) => c.name === 'updater.check.start' && c.fields?.reason === 'poll',
    );
    expect(pollStarts).toHaveLength(2);
  });
});
