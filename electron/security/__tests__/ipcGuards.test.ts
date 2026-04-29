import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { isSafePath, resolveCwd, fromMainFrame } from '../ipcGuards';

describe('isSafePath', () => {
  it('accepts an absolute POSIX path', () => {
    expect(isSafePath('/home/u/project')).toBe(true);
  });
  it('accepts an absolute Windows path', () => {
    // path.isAbsolute is platform-aware; on win32 a drive-letter path is
    // absolute, on POSIX it isn't. Guard the assertion accordingly.
    if (process.platform === 'win32') {
      expect(isSafePath('C:\\Users\\me\\project')).toBe(true);
    } else {
      expect(isSafePath('/home/u/project')).toBe(true);
    }
  });
  it('rejects relative paths', () => {
    expect(isSafePath('relative/path')).toBe(false);
    expect(isSafePath('./foo')).toBe(false);
    expect(isSafePath('../up')).toBe(false);
  });
  it('rejects UNC paths (backslash)', () => {
    expect(isSafePath('\\\\server\\share\\probe')).toBe(false);
  });
  it('rejects UNC paths (forward slash)', () => {
    expect(isSafePath('//server/share/probe')).toBe(false);
  });
  it('rejects non-string inputs', () => {
    expect(isSafePath(undefined)).toBe(false);
    expect(isSafePath(null)).toBe(false);
    expect(isSafePath(42)).toBe(false);
    expect(isSafePath({})).toBe(false);
    expect(isSafePath([])).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isSafePath('')).toBe(false);
  });
});

describe('resolveCwd', () => {
  it('returns home for the bare ~', () => {
    expect(resolveCwd('~')).toBe(os.homedir());
  });
  it('expands ~/ prefix', () => {
    expect(resolveCwd('~/projects/x')).toBe(path.join(os.homedir(), 'projects/x'));
  });
  it('expands ~\\ prefix', () => {
    expect(resolveCwd('~\\projects\\x')).toBe(path.join(os.homedir(), 'projects\\x'));
  });
  it('passes non-tilde paths through unchanged', () => {
    expect(resolveCwd('/abs/path')).toBe('/abs/path');
    expect(resolveCwd('relative/foo')).toBe('relative/foo');
  });
  it('does not expand tilde in the middle of a path', () => {
    expect(resolveCwd('/foo/~/bar')).toBe('/foo/~/bar');
  });
});

describe('fromMainFrame', () => {
  it('returns true when senderFrame === sender.mainFrame', () => {
    const mainFrame = { id: 1 };
    const e = {
      sender: { mainFrame },
      senderFrame: mainFrame,
    } as unknown as Electron.IpcMainInvokeEvent;
    expect(fromMainFrame(e)).toBe(true);
  });
  it('returns false when senderFrame is a different (sub) frame', () => {
    const mainFrame = { id: 1 };
    const subFrame = { id: 2 };
    const e = {
      sender: { mainFrame },
      senderFrame: subFrame,
    } as unknown as Electron.IpcMainInvokeEvent;
    expect(fromMainFrame(e)).toBe(false);
  });
});
