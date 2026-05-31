// Security gates around utilityIpc handlers (#804 risk #4).
//
// `app:userCwds:push` MUST drop UNC / relative / non-absolute strings
// BEFORE forwarding to `pushUserCwd`. The LRU here later flows into
// `pty:spawn`'s `cwd` arg via the StatusBar cwd popover; without this
// gate a single hostile push persists a UNC trap path (NTLM-leak primitive
// the moment the user reopens the popover).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';

const pushUserCwdMock = vi.fn((p: string) => [p, os.homedir()]);
const getUserCwdsMock = vi.fn(() => [os.homedir()]);

const openExternalMock = vi.fn(async (_url: string) => {});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: (url: string) => openExternalMock(url) },
}));
vi.mock('../../import-scanner', () => ({
  scanImportableSessions: async () => [],
}));
vi.mock('../../prefs/userCwds', () => ({
  getUserCwds: () => getUserCwdsMock(),
  pushUserCwd: (p: string) => pushUserCwdMock(p),
}));

import { registerUtilityIpc } from '../utilityIpc';
import { resolveCwd } from '../../security/ipcGuards';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (ch: string, fn: Handler) => handlers.set(ch, fn),
    on: (ch: string, fn: Handler) => handlers.set(ch, fn),
  } as unknown as Electron.IpcMain;
  return { ipcMain, handlers };
}

// Build an IpcMainInvokeEvent that passes the fromMainFrame guard.
function mainFrameEvent(): Electron.IpcMainInvokeEvent {
  const mainFrame = { id: 1 };
  return {
    sender: { mainFrame },
    senderFrame: mainFrame,
  } as unknown as Electron.IpcMainInvokeEvent;
}

describe('app:userCwds:push security gate (#804 risk #4)', () => {
  let push: Handler;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pushUserCwdMock.mockClear();
    getUserCwdsMock.mockClear();
    const { ipcMain, handlers } = fakeIpcMain();
    registerUtilityIpc({ ipcMain });
    push = handlers.get('app:userCwds:push')!;
    expect(push).toBeDefined();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('accepts a safe absolute path', () => {
    const safe = process.platform === 'win32' ? 'C:\\Users\\me\\proj' : '/home/me/proj';
    push(mainFrameEvent(), safe);
    expect(pushUserCwdMock).toHaveBeenCalledWith(safe);
  });

  it('rejects UNC path (backslash) without calling pushUserCwd', () => {
    push(mainFrameEvent(), '\\\\evil-host\\share\\bait');
    expect(pushUserCwdMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('rejected unsafe path'),
    );
  });

  it('rejects UNC path (forward slash)', () => {
    push(mainFrameEvent(), '//evil-host/share/bait');
    expect(pushUserCwdMock).not.toHaveBeenCalled();
  });

  it('rejects relative escape paths (../)', () => {
    push(mainFrameEvent(), '../../etc/passwd');
    expect(pushUserCwdMock).not.toHaveBeenCalled();
  });

  it('rejects non-string payloads', () => {
    push(mainFrameEvent(), 42);
    push(mainFrameEvent(), null);
    push(mainFrameEvent(), { path: '/x' });
    expect(pushUserCwdMock).not.toHaveBeenCalled();
  });

  it('rejects when sender is a sub-frame (fromMainFrame guard)', () => {
    const subFrame = { id: 2 };
    const e = {
      sender: { mainFrame: { id: 1 } },
      senderFrame: subFrame,
    } as unknown as Electron.IpcMainInvokeEvent;
    const safe = process.platform === 'win32' ? 'C:\\safe' : '/safe';
    push(e, safe);
    expect(pushUserCwdMock).not.toHaveBeenCalled();
  });

  // Regression: a tilde cwd (`~/projects/foo`) was silently rejected because
  // the handler ran isSafePath on the raw `~`-prefixed string (not absolute →
  // unsafe) instead of resolving it first like the sibling probePaths handler.
  // The RESOLVED absolute path must be persisted, never the literal `~/...`.
  it('expands a tilde path with resolveCwd and pushes the RESOLVED absolute path', () => {
    const expected = resolveCwd('~/projects/foo');
    // sanity: resolveCwd actually expanded the tilde to an absolute path
    expect(expected).not.toBe('~/projects/foo');
    push(mainFrameEvent(), '~/projects/foo');
    expect(pushUserCwdMock).toHaveBeenCalledTimes(1);
    expect(pushUserCwdMock).toHaveBeenCalledWith(expected);
    // never the literal tilde form
    expect(pushUserCwdMock).not.toHaveBeenCalledWith('~/projects/foo');
  });

  it('expands a bare "~" to the home directory before pushing', () => {
    push(mainFrameEvent(), '~');
    expect(pushUserCwdMock).toHaveBeenCalledTimes(1);
    expect(pushUserCwdMock).toHaveBeenCalledWith(os.homedir());
  });
});

// `ccsm:openExternal` opens an arbitrary URL in the OS browser — a privileged
// action. Beyond the http(s) scheme whitelist it must also confirm the IPC
// came from our top-level renderer frame (defense-in-depth).
describe('ccsm:openExternal security gate', () => {
  let openExternal: Handler;

  beforeEach(() => {
    openExternalMock.mockClear();
    const { ipcMain, handlers } = fakeIpcMain();
    registerUtilityIpc({ ipcMain });
    openExternal = handlers.get('ccsm:openExternal')!;
    expect(openExternal).toBeDefined();
  });

  it('opens an https URL when the sender is the main frame', async () => {
    const result = await openExternal(mainFrameEvent(), 'https://example.com');
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com');
    expect(result).toBe(true);
  });

  it('does not open when the sender is a sub-frame (fromMainFrame guard)', async () => {
    const subFrame = { id: 2 };
    const e = {
      sender: { mainFrame: { id: 1 } },
      senderFrame: subFrame,
    } as unknown as Electron.IpcMainInvokeEvent;
    const result = await openExternal(e, 'https://example.com');
    expect(openExternalMock).not.toHaveBeenCalled();
    expect(result).toBeFalsy();
  });
});
