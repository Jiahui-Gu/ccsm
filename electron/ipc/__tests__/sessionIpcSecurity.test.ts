// Security gates for sessionTitles IPC handlers (#804 risk #5).
//
// `sessionTitles:get` / `:rename` / `:enqueuePending` accept a `dir`
// argument that is forwarded straight into the Anthropic SDK, which fs.joins
// it under ~/.claude/projects/<key>/.... Without the safety gate a hostile
// renderer can pass a UNC path (`\\evil\share`) — once the SDK realpath()s
// or stat()s it, Windows triggers an SMB handshake that leaks the user's
// NTLM hash. The gate here scrubs the dir to `undefined` (which makes the
// SDK fall back to scanning every project dir, the legacy safe path) when
// the input fails `isSafePath`.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionTitleMock = vi.fn(async () => ({ summary: null, mtime: null }));
const renameSessionTitleMock = vi.fn(async () => ({ ok: true }));
const enqueuePendingRenameMock = vi.fn();

vi.mock('../../sessionTitles', () => ({
  getSessionTitle: (...a: unknown[]) => getSessionTitleMock(...(a as [])),
  renameSessionTitle: (...a: unknown[]) => renameSessionTitleMock(...(a as [])),
  listProjectSummaries: vi.fn(async () => []),
  enqueuePendingRename: (...a: unknown[]) => enqueuePendingRenameMock(...(a as [])),
  flushPendingRename: vi.fn(async () => undefined),
}));

import { registerSessionIpc } from '../sessionIpc';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (ch: string, fn: Handler) => handlers.set(ch, fn),
    on: (ch: string, fn: Handler) => handlers.set(ch, fn),
  } as unknown as Electron.IpcMain;
  return { ipcMain, handlers };
}

const SAFE_DIR = process.platform === 'win32' ? 'C:\\Users\\me\\proj' : '/home/me/proj';

describe('sessionTitles dir security gate (#804 risk #5)', () => {
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    getSessionTitleMock.mockClear();
    renameSessionTitleMock.mockClear();
    enqueuePendingRenameMock.mockClear();
    const built = fakeIpcMain();
    handlers = built.handlers;
    registerSessionIpc({
      ipcMain: built.ipcMain,
      setActiveSid: () => {},
      onActiveSidChanged: () => {},
      setSessionName: () => {},
      markUserInput: () => {},
    });
  });

  it('forwards a safe absolute dir verbatim to getSessionTitle', async () => {
    const fn = handlers.get('sessionTitles:get')!;
    await fn({}, 'sid-1', SAFE_DIR);
    expect(getSessionTitleMock).toHaveBeenCalledWith('sid-1', SAFE_DIR);
  });

  it('scrubs UNC dir (backslash) to undefined on get', async () => {
    const fn = handlers.get('sessionTitles:get')!;
    await fn({}, 'sid-1', '\\\\evil\\share\\bait');
    expect(getSessionTitleMock).toHaveBeenCalledWith('sid-1', undefined);
  });

  it('scrubs UNC dir (forward slash) to undefined on rename', async () => {
    const fn = handlers.get('sessionTitles:rename')!;
    await fn({}, 'sid-1', 'new-title', '//evil/share/bait');
    expect(renameSessionTitleMock).toHaveBeenCalledWith('sid-1', 'new-title', undefined);
  });

  it('scrubs relative dir to undefined on enqueuePending', async () => {
    const fn = handlers.get('sessionTitles:enqueuePending')!;
    await fn({}, 'sid-1', 'title', '../../etc');
    expect(enqueuePendingRenameMock).toHaveBeenCalledWith('sid-1', 'title', undefined);
  });

  it('scrubs non-string dir to undefined', async () => {
    const fn = handlers.get('sessionTitles:get')!;
    await fn({}, 'sid-1', 42 as unknown as string);
    expect(getSessionTitleMock).toHaveBeenCalledWith('sid-1', undefined);
  });

  it('forwards undefined dir as undefined (legacy callers)', async () => {
    const fn = handlers.get('sessionTitles:get')!;
    await fn({}, 'sid-1');
    expect(getSessionTitleMock).toHaveBeenCalledWith('sid-1', undefined);
  });
});
