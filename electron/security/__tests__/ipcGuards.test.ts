import { describe, it, expect } from 'vitest';
import { isSafePath } from '../ipcGuards';

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
