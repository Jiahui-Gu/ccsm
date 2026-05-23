import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const openExternalMock = vi.fn(async (_url: string) => undefined);
const scanImportableSessionsMock = vi.hoisted(() =>
  vi.fn(async () => [] as unknown[]),
);

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: (url: string) => openExternalMock(url) },
}));
vi.mock('../../import-scanner', () => ({
  scanImportableSessions: scanImportableSessionsMock,
}));
vi.mock('../../prefs/userCwds', () => ({
  getUserCwds: () => [os.homedir()],
  pushUserCwd: (p: string) => [p, os.homedir()],
}));

import {
  probePaths,
  isAllowedExternalUrl,
  registerUtilityIpc,
} from '../utilityIpc';

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

describe('isAllowedExternalUrl (scheme whitelist for ccsm:openExternal)', () => {
  it('accepts https URLs', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true);
    expect(isAllowedExternalUrl('https://example.com/path?q=1#frag')).toBe(true);
  });

  it('accepts http URLs (intranet / dev links printed by tools)', () => {
    expect(isAllowedExternalUrl('http://example.com')).toBe(true);
    expect(isAllowedExternalUrl('http://localhost:3000/x')).toBe(true);
  });

  it('is case-insensitive on the scheme', () => {
    expect(isAllowedExternalUrl('HTTPS://example.com')).toBe(true);
    expect(isAllowedExternalUrl('Http://example.com')).toBe(true);
  });

  it('rejects file:// URLs (local file disclosure)', () => {
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('file://C:/Windows/System32/drivers/etc/hosts')).toBe(false);
  });

  it('rejects javascript: URLs (XSS / RCE via shell)', () => {
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('JaVaScRiPt:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects vbscript: URLs', () => {
    expect(isAllowedExternalUrl('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects other custom protocols (mailto, ms-settings, ssh, etc.)', () => {
    expect(isAllowedExternalUrl('mailto:a@b.com')).toBe(false);
    expect(isAllowedExternalUrl('ms-settings:network')).toBe(false);
    expect(isAllowedExternalUrl('ssh://user@host')).toBe(false);
    expect(isAllowedExternalUrl('ftp://example.com')).toBe(false);
  });

  it('rejects scheme-relative and protocol-confused inputs', () => {
    expect(isAllowedExternalUrl('//example.com')).toBe(false);
    expect(isAllowedExternalUrl('example.com')).toBe(false);
    expect(isAllowedExternalUrl(' https://example.com')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isAllowedExternalUrl(undefined)).toBe(false);
    expect(isAllowedExternalUrl(null)).toBe(false);
    expect(isAllowedExternalUrl(42)).toBe(false);
    expect(isAllowedExternalUrl({ url: 'https://x' })).toBe(false);
    expect(isAllowedExternalUrl(['https://x'])).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isAllowedExternalUrl('')).toBe(false);
  });
});

describe('ccsm:openExternal IPC handler', () => {
  type Handler = (e: unknown, ...args: unknown[]) => unknown;
  let handler: Handler;

  beforeEach(() => {
    openExternalMock.mockClear();
    const handlers = new Map<string, Handler>();
    const ipcMain = {
      handle: (ch: string, fn: Handler) => handlers.set(ch, fn),
      on: (ch: string, fn: Handler) => handlers.set(ch, fn),
    } as unknown as Electron.IpcMain;
    registerUtilityIpc({ ipcMain });
    handler = handlers.get('ccsm:openExternal')!;
    expect(handler).toBeDefined();
  });

  it('forwards http(s) URLs to shell.openExternal and returns true', async () => {
    const r1 = await handler({}, 'https://example.com');
    const r2 = await handler({}, 'http://localhost:8080/x');
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(openExternalMock).toHaveBeenCalledTimes(2);
    expect(openExternalMock).toHaveBeenNthCalledWith(1, 'https://example.com');
    expect(openExternalMock).toHaveBeenNthCalledWith(2, 'http://localhost:8080/x');
  });

  it('rejects file:// without calling shell.openExternal', async () => {
    const r = await handler({}, 'file:///etc/passwd');
    expect(r).toBe(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('rejects javascript: without calling shell.openExternal', async () => {
    const r = await handler({}, 'javascript:alert(1)');
    expect(r).toBe(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('rejects data: without calling shell.openExternal', async () => {
    const r = await handler({}, 'data:text/html,x');
    expect(r).toBe(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('rejects non-string inputs without calling shell.openExternal', async () => {
    expect(await handler({}, 42)).toBe(false);
    expect(await handler({}, null)).toBe(false);
    expect(await handler({}, undefined)).toBe(false);
    expect(await handler({}, { url: 'https://x' })).toBe(false);
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('returns false (does not throw) when shell.openExternal rejects', async () => {
    openExternalMock.mockRejectedValueOnce(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await handler({}, 'https://example.com');
    expect(r).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('import:scan IPC handler — fresh scan, no stale cache (regression)', () => {
  // Bug: ImportDialog showed stale list on second open if new on-disk
  // sessions appeared since the first open. Root cause: the handler used
  // stale-while-revalidate, returning the cached array immediately and
  // kicking an async refresh whose result the current caller never saw.
  // Fix: always await a fresh scan (concurrent IPCs still share the
  // in-flight promise via the importablePending mutex).
  type Handler = (e: unknown, ...args: unknown[]) => unknown;
  let handler: Handler;

  function makeSession(id: string, mtime: number) {
    return {
      sessionId: id,
      cwd: `/tmp/cwd-${id}`,
      title: `Session ${id}`,
      mtime,
      projectDir: `/tmp/proj-${id}`,
      model: null,
    };
  }

  beforeEach(async () => {
    scanImportableSessionsMock.mockReset();
    // Force a fresh module instance so module-scoped cache state from
    // earlier tests doesn't bleed in.
    vi.resetModules();
    const mod = await import('../utilityIpc');
    const handlers = new Map<string, Handler>();
    const ipcMain = {
      handle: (ch: string, fn: Handler) => handlers.set(ch, fn),
      on: (ch: string, fn: Handler) => handlers.set(ch, fn),
    } as unknown as Electron.IpcMain;
    mod.registerUtilityIpc({ ipcMain });
    handler = handlers.get('import:scan')!;
    expect(handler).toBeDefined();
  });

  it('returns the fresh on-disk list, not the previously-cached one', async () => {
    const first = makeSession('a', 1);
    const second = makeSession('b', 2);

    // First open: only one session exists on disk.
    scanImportableSessionsMock.mockResolvedValueOnce([first]);
    const r1 = (await handler({})) as Array<{ sessionId: string }>;
    expect(r1.map((s) => s.sessionId)).toEqual(['a']);

    // Between opens, a second session is recorded on disk.
    scanImportableSessionsMock.mockResolvedValueOnce([first, second]);
    const r2 = (await handler({})) as Array<{ sessionId: string }>;

    // Old (stale-while-revalidate) behaviour would have returned `[a]`
    // here and only refreshed in the background. Fresh-scan behaviour
    // must include both sessions.
    expect(r2.map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(scanImportableSessionsMock).toHaveBeenCalledTimes(2);
  });

  it('shares a single in-flight scan across concurrent callers (single-flight mutex)', async () => {
    let resolveScan: ((rows: unknown[]) => void) | undefined;
    scanImportableSessionsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve as (rows: unknown[]) => void;
        }),
    );

    const p1 = handler({}) as Promise<unknown[]>;
    const p2 = handler({}) as Promise<unknown[]>;
    const p3 = handler({}) as Promise<unknown[]>;

    // All three callers should be waiting on the same in-flight scan.
    expect(scanImportableSessionsMock).toHaveBeenCalledTimes(1);

    const rows = [makeSession('x', 1)];
    resolveScan!(rows);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual(rows);
    expect(r2).toEqual(rows);
    expect(r3).toEqual(rows);
    expect(scanImportableSessionsMock).toHaveBeenCalledTimes(1);
  });
});
