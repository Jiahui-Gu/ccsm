// Tests for `electron/shared/log.ts` initLog file-sink gating.
//
// log.ts decides whether to wire the electron-log file transport based on
//   1. `app.isPackaged === false` (dev runtime — `npm run dev`), OR
//   2. `CCSM_LOG_ENABLE_FILE === '1'` (explicit opt-in).
// Anything else (packaged build, no env opt-in, no electron at all) silences
// the file transport (`elog.transports.file.level = false`) — production
// users don't accumulate diagnostic JSONL on disk.
//
// The module short-circuits when `process.versions.electron === undefined`,
// so we have to fake that AND intercept the dynamic `require('electron-log/
// main')` + `require('electron')` calls that happen inside `getElog()` /
// `getApp()`. Mirrors the pattern in `electron/lifecycle/__tests__/
// appLifecycle.test.ts` for `require('../i18n')`.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Fake `electron-log/main` instance with just the transports surface our
// code touches. Re-built fresh per test so leaked state from a prior call
// doesn't bleed (`_initialized` guard inside log.ts is reset by re-importing
// via vi.resetModules).
function makeFakeElog(): {
  initialize: () => void;
  transports: {
    console: { level: string | false; format?: unknown };
    file: { level: string | false; format?: unknown; maxSize?: number; archiveLogFn?: unknown; resolvePathFn?: unknown; getFile?: () => { path: string }; fileName?: string };
  };
  create: () => ReturnType<typeof makeFakeElog>;
  debug: () => void;
  info: () => void;
  warn: () => void;
  error: () => void;
} {
  return {
    initialize: () => {},
    transports: {
      console: { level: 'info' as string | false },
      file: {
        level: 'info' as string | false,
        resolvePathFn: () => '/tmp/main.log',
      },
    },
    create: () => makeFakeElog(),
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// State knobs the require-patch reads.
let currentElog: ReturnType<typeof makeFakeElog>;
let isPackaged = false;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module') as typeof import('node:module');
const ModuleProto = (Module as unknown as { prototype: { require: (id: string) => unknown } })
  .prototype;
const originalRequire = ModuleProto.require;
ModuleProto.require = function patchedRequire(this: NodeJS.Module, id: string) {
  if (id === 'electron-log/main') {
    return { default: currentElog };
  }
  if (id === 'electron') {
    return {
      app: {
        getVersion: () => '0.0.0-test',
        getPath: (name: string) => `/tmp/${name}`,
        isPackaged,
      },
    };
  }
  // log.ts also lazily requires '../db' (loadPersistedLevel / persistLevel).
  // Stub it as no-op so we don't drag the real sqlite handle in.
  if (id === '../db') {
    return { loadState: () => null, saveState: () => {} };
  }
  return originalRequire.call(this, id);
};

afterAll(() => {
  ModuleProto.require = originalRequire;
});

// `isElectronRuntime()` checks `process.versions.electron`. Override and
// restore around the suite so plain-Node vitest sees a fake Electron.
const originalElectronVersion = process.versions.electron;
beforeEach(() => {
  // Re-fake every test so we observe the post-initLog mutations cleanly.
  currentElog = makeFakeElog();
  // process.versions is read-only on its prototype; assign via defineProperty.
  Object.defineProperty(process.versions, 'electron', {
    value: '30.0.0-fake',
    configurable: true,
    writable: true,
  });
  delete process.env.CCSM_LOG_ENABLE_FILE;
  delete process.env.CCSM_LOG_DISABLE_FILE; // ensure stale value can't sneak in
});

afterAll(() => {
  if (originalElectronVersion === undefined) {
    delete (process.versions as { electron?: string }).electron;
  } else {
    Object.defineProperty(process.versions, 'electron', {
      value: originalElectronVersion,
      configurable: true,
      writable: true,
    });
  }
});

/** Re-import log.ts with a fresh module registry so `_initialized` is reset
 *  between tests. vitest's `vi.resetModules()` clears the ESM cache; the
 *  dynamic `require()`s inside log.ts re-resolve through our patched
 *  Module.prototype.require. */
async function freshLog(): Promise<typeof import('../log')> {
  vi.resetModules();
  return import('../log');
}

describe('initLog file-sink gate', () => {
  it('dev runtime (app.isPackaged === false): file transport enabled', async () => {
    isPackaged = false;
    const { initLog, getLogFileEnabled } = await freshLog();
    initLog();
    expect(currentElog.transports.file.level).not.toBe(false);
    expect(getLogFileEnabled()).toBe(true);
  });

  it('packaged + no opt-in: file transport silenced', async () => {
    isPackaged = true;
    const { initLog, getLogFileEnabled } = await freshLog();
    initLog();
    expect(currentElog.transports.file.level).toBe(false);
    expect(getLogFileEnabled()).toBe(false);
  });

  it('packaged + CCSM_LOG_ENABLE_FILE=1: file transport enabled', async () => {
    isPackaged = true;
    process.env.CCSM_LOG_ENABLE_FILE = '1';
    const { initLog, getLogFileEnabled } = await freshLog();
    initLog();
    expect(currentElog.transports.file.level).not.toBe(false);
    expect(getLogFileEnabled()).toBe(true);
  });

  it('packaged + CCSM_LOG_ENABLE_FILE=anything-else: file transport silenced (only "1" opts in)', async () => {
    isPackaged = true;
    process.env.CCSM_LOG_ENABLE_FILE = 'true'; // not the exact opt-in token
    const { initLog, getLogFileEnabled } = await freshLog();
    initLog();
    expect(currentElog.transports.file.level).toBe(false);
    expect(getLogFileEnabled()).toBe(false);
  });

  it('legacy CCSM_LOG_DISABLE_FILE is REMOVED — setting it does nothing in dev', async () => {
    isPackaged = false;
    process.env.CCSM_LOG_DISABLE_FILE = '1';
    const { initLog, getLogFileEnabled } = await freshLog();
    initLog();
    // Dev gate still wins; the old opt-out var is dead.
    expect(currentElog.transports.file.level).not.toBe(false);
    expect(getLogFileEnabled()).toBe(true);
  });
});
