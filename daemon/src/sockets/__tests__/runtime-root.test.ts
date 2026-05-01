import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, sep } from 'node:path';
import { resolveRuntimeRoot } from '../runtime-root.js';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ccsm-runtime-root-'));
});

afterEach(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('resolveRuntimeRoot — Linux', () => {
  it('uses XDG_RUNTIME_DIR/ccsm when set and writable', () => {
    const xdg = join(scratch, 'xdg');
    mkdirSync(xdg, { recursive: true, mode: 0o700 });
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: xdg, HOME: scratch },
    });
    expect(root).toBe(join(xdg, 'ccsm'));
    expect(existsSync(root)).toBe(true);
  });

  it('falls back to <dataRoot>/run when XDG_RUNTIME_DIR is unset', () => {
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: { HOME: scratch, XDG_DATA_HOME: join(scratch, 'data') },
    });
    expect(root).toBe(join(scratch, 'data', 'ccsm', 'run'));
    expect(existsSync(root)).toBe(true);
  });

  it('falls back to <dataRoot>/run when XDG_RUNTIME_DIR is empty string', () => {
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '', HOME: scratch, XDG_DATA_HOME: join(scratch, 'data') },
    });
    expect(root).toBe(join(scratch, 'data', 'ccsm', 'run'));
  });

  it('falls back to <dataRoot>/run when XDG_RUNTIME_DIR points at a non-existent dir', () => {
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: {
        XDG_RUNTIME_DIR: join(scratch, 'does-not-exist'),
        HOME: scratch,
        XDG_DATA_HOME: join(scratch, 'data'),
      },
    });
    expect(root).toBe(join(scratch, 'data', 'ccsm', 'run'));
  });

  it('uses ~/.local/share/ccsm/run when neither XDG var is set', () => {
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: { HOME: scratch },
      ensure: false,
    });
    // homedir() reads from process env on POSIX; not guaranteed to honor our
    // `env` arg. Assert the structural shape only.
    expect(root.endsWith(join('ccsm', 'run'))).toBe(true);
  });
});

describe('resolveRuntimeRoot — macOS', () => {
  it('returns <dataRoot>/run under ~/Library/Application Support/ccsm', () => {
    const root = resolveRuntimeRoot({
      platform: 'darwin',
      env: {},
      ensure: false,
    });
    const expectedSuffix = join('Library', 'Application Support', 'ccsm', 'run');
    expect(root.endsWith(expectedSuffix)).toBe(true);
    expect(root.startsWith(homedir())).toBe(true);
  });

  it('ignores XDG_RUNTIME_DIR on darwin (no XDG on macOS per spec)', () => {
    const xdg = join(scratch, 'xdg');
    mkdirSync(xdg, { recursive: true });
    const root = resolveRuntimeRoot({
      platform: 'darwin',
      env: { XDG_RUNTIME_DIR: xdg },
      ensure: false,
    });
    expect(root.includes(xdg)).toBe(false);
  });
});

describe('resolveRuntimeRoot — Windows', () => {
  it('returns %LOCALAPPDATA%\\ccsm\\run when LOCALAPPDATA is set', () => {
    const local = join(scratch, 'Local');
    const root = resolveRuntimeRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: local },
    });
    expect(root).toBe(join(local, 'ccsm', 'run'));
    expect(existsSync(root)).toBe(true);
  });

  it('falls back to ~/AppData/Local/ccsm/run when LOCALAPPDATA is unset', () => {
    const root = resolveRuntimeRoot({
      platform: 'win32',
      env: {},
      ensure: false,
    });
    const expectedSuffix = ['AppData', 'Local', 'ccsm', 'run'].join(sep);
    expect(root.endsWith(expectedSuffix)).toBe(true);
  });

  it('does not throw when ensure=true creates a deep new path', () => {
    const local = join(scratch, 'fresh', 'Local');
    const root = resolveRuntimeRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: local },
    });
    expect(existsSync(root)).toBe(true);
  });
});

describe('resolveRuntimeRoot — mkdir behavior', () => {
  it('creates the directory with mode 0o700 on POSIX', () => {
    const xdg = join(scratch, 'xdg2');
    mkdirSync(xdg, { recursive: true, mode: 0o700 });
    const root = resolveRuntimeRoot({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: xdg, HOME: scratch },
    });
    const st = statSync(root);
    expect(st.isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      // mode bits aren't meaningful on Windows
      expect(st.mode & 0o777).toBe(0o700);
    }
  });

  it('is idempotent on re-call (no throw, same path)', () => {
    const local = join(scratch, 'idem');
    const env = { LOCALAPPDATA: local };
    const a = resolveRuntimeRoot({ platform: 'win32', env });
    const b = resolveRuntimeRoot({ platform: 'win32', env });
    const c = resolveRuntimeRoot({ platform: 'win32', env });
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(existsSync(a)).toBe(true);
  });

  it('does not create the directory when ensure=false', () => {
    const local = join(scratch, 'noensure');
    const root = resolveRuntimeRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: local },
      ensure: false,
    });
    expect(existsSync(root)).toBe(false);
  });
});
