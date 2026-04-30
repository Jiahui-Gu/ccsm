import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));
vi.mock('../../import-scanner', () => ({
  scanImportableSessions: async () => [],
}));
vi.mock('../../prefs/userCwds', () => ({
  getUserCwds: () => [os.homedir()],
  pushUserCwd: (p: string) => [p, os.homedir()],
}));

import { probePaths } from '../utilityIpc';

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-utilityIpc-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('probePaths', () => {
  it('returns true for paths that exist', () => {
    const result = probePaths([tmpDir]);
    expect(result[tmpDir]).toBe(true);
  });

  it('returns false for paths that do not exist', () => {
    const ghost = path.join(tmpDir, 'does-not-exist');
    const result = probePaths([ghost]);
    expect(result[ghost]).toBe(false);
  });

  it('rejects UNC paths to prevent NTLM hash leak', () => {
    // The Windows-only safety filter is also a no-op on POSIX (resolveCwd
    // simply leaves the string alone, isSafePath rejects non-absolute or
    // UNC). On both platforms a UNC string maps to false.
    const unc = '\\\\evil\\share\\probe';
    const result = probePaths([unc]);
    expect(result[unc]).toBe(false);
  });

  it('handles non-string entries by silently dropping them', () => {
    const result = probePaths([tmpDir, 123, null, undefined, { x: 1 }]);
    expect(Object.keys(result)).toEqual([tmpDir]);
  });

  it('returns empty object for non-array input', () => {
    expect(probePaths(undefined)).toEqual({});
    expect(probePaths(null)).toEqual({});
    expect(probePaths('not-an-array')).toEqual({});
  });

  it('reverse-verify: a deleted path stops returning true after rmSync', () => {
    expect(probePaths([tmpDir])[tmpDir]).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(probePaths([tmpDir])[tmpDir]).toBe(false);
  });
});
