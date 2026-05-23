// Regression test for the `window-all-closed` quit path in
// electron/lifecycle/appLifecycle.ts.
//
// Background: the handler ran `closeDb()` then `app.quit()` as plain
// sequential statements. A throw from closeDb() (SQLite busy, lock
// contention, schema-corruption) silently skipped app.quit(), leaving
// Electron alive with no windows — a process leak.
//
// Mirrors the audit pattern from dispose-notify-pipeline.test.ts:
//   1) Source-level: the literal window-all-closed handler body in
//      appLifecycle.ts must wrap each disposer in its own try/catch.
//   2) Behavior-level: drive registerLifecycleHandlers with a fake App,
//      inject a throwing closeDb, and assert app.quit STILL gets called.
//
// Mutation check: removing the try/catch around closeDb() makes the
// behavior test fail (closeDb throws, app.quit is never invoked).

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Avoid loading the real electron binary; we only need BrowserWindow.getAllWindows
// to be callable from the before-quit handler.
vi.mock('electron', () => ({
  app: {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}));

const LIFECYCLE_TS = path.resolve(__dirname, '..', 'lifecycle', 'appLifecycle.ts');

function readLiveSource(): string {
  const source = fs.readFileSync(LIFECYCLE_TS, 'utf8');
  return source
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

/** Extract the body of the `app.on('window-all-closed', () => { ... })` block. */
function extractWindowAllClosedBlock(live: string): string {
  const startMarker = "app.on('window-all-closed', () => {";
  const startIdx = live.indexOf(startMarker);
  expect(startIdx).toBeGreaterThan(-1);
  let depth = 0;
  let i = startIdx + startMarker.length - 1; // position at the opening '{'
  for (; i < live.length; i++) {
    const ch = live[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return live.slice(startIdx, i + 1);
    }
  }
  throw new Error('unterminated window-all-closed block in appLifecycle.ts');
}

describe('window-all-closed cleanup chain (source wiring)', () => {
  const live = readLiveSource();
  const block = extractWindowAllClosedBlock(live);

  it('wraps closeDb() in its own try/catch', () => {
    const closeIdx = block.indexOf('closeDb()');
    expect(closeIdx).toBeGreaterThan(-1);
    const tryBefore = block.lastIndexOf('try {', closeIdx);
    expect(tryBefore).toBeGreaterThan(-1);
    const nextDisposerIdx = block.indexOf('app.quit()', closeIdx);
    const catchBetween = block.indexOf('catch', closeIdx);
    expect(catchBetween).toBeGreaterThan(closeIdx);
    expect(catchBetween).toBeLessThan(nextDisposerIdx);
  });

  it('wraps app.quit() in its own try/catch', () => {
    const quitIdx = block.indexOf('app.quit()');
    expect(quitIdx).toBeGreaterThan(-1);
    const tryBefore = block.lastIndexOf('try {', quitIdx);
    expect(tryBefore).toBeGreaterThan(-1);
    const between = block.slice(tryBefore, quitIdx);
    expect(between).not.toMatch(/closeDb\(\)/);
    const catchAfter = block.indexOf('catch', quitIdx);
    expect(catchAfter).toBeGreaterThan(quitIdx);
  });

  it('preserves disposer order: closeDb → app.quit', () => {
    const closeIdx = block.indexOf('closeDb()');
    const quitIdx = block.indexOf('app.quit()');
    expect(closeIdx).toBeGreaterThan(-1);
    expect(quitIdx).toBeGreaterThan(closeIdx);
  });

  it('logs each disposer failure via console.warn with the [appLifecycle] tag', () => {
    expect(block).toMatch(/console\.warn\(\s*'\[appLifecycle\] disposer/);
  });
});

type Handler = (...args: unknown[]) => void;

function makeFakeApp(): {
  on: (event: string, cb: Handler) => void;
  emit: (event: string, ...args: unknown[]) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    on(event, cb) {
      handlers.set(event, cb);
    },
    emit(event, ...args) {
      const cb = handlers.get(event);
      if (cb) cb(...args);
    },
  };
}

describe('window-all-closed cleanup chain (behavior contract)', () => {
  it('still calls app.quit when closeDb throws', async () => {
    const fakeApp = makeFakeApp();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const closeDb = vi.fn(() => {
      throw new Error('sqlite busy');
    });
    const appQuit = vi.fn();
    // Build an App-shaped object: on() + quit().
    const appLike = {
      on: fakeApp.on.bind(fakeApp),
      quit: appQuit,
    };

    const { registerLifecycleHandlers } = await import('../lifecycle/appLifecycle');
    registerLifecycleHandlers({
      // Cast through unknown — we only exercise on() and quit().
      app: appLike as unknown as import('electron').App,
      getIsQuitting: () => true,
      setIsQuitting: () => {},
      killAllPtySessions: async () => {},
      closeDb,
      createWindow: () => {},
      getWindowCount: () => 0,
    });

    fakeApp.emit('window-all-closed');

    expect(closeDb).toHaveBeenCalledTimes(1);
    // The critical invariant: quit MUST still run even when closeDb threw.
    expect(appQuit).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[appLifecycle] disposer closeDb threw'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('runs both disposers on the happy path', async () => {
    const fakeApp = makeFakeApp();
    const closeDb = vi.fn();
    const appQuit = vi.fn();
    const appLike = { on: fakeApp.on.bind(fakeApp), quit: appQuit };

    const { registerLifecycleHandlers } = await import('../lifecycle/appLifecycle');
    registerLifecycleHandlers({
      app: appLike as unknown as import('electron').App,
      getIsQuitting: () => true,
      setIsQuitting: () => {},
      killAllPtySessions: async () => {},
      closeDb,
      createWindow: () => {},
      getWindowCount: () => 0,
    });

    fakeApp.emit('window-all-closed');
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(appQuit).toHaveBeenCalledTimes(1);
  });

  it('skips disposers entirely when not in a real-quit pass', async () => {
    const fakeApp = makeFakeApp();
    const closeDb = vi.fn();
    const appQuit = vi.fn();
    const appLike = { on: fakeApp.on.bind(fakeApp), quit: appQuit };

    const { registerLifecycleHandlers } = await import('../lifecycle/appLifecycle');
    registerLifecycleHandlers({
      app: appLike as unknown as import('electron').App,
      // Hide-to-tray: not quitting.
      getIsQuitting: () => false,
      setIsQuitting: () => {},
      killAllPtySessions: async () => {},
      closeDb,
      createWindow: () => {},
      getWindowCount: () => 0,
    });

    fakeApp.emit('window-all-closed');
    expect(closeDb).not.toHaveBeenCalled();
    expect(appQuit).not.toHaveBeenCalled();
  });

  it('does not rethrow when app.quit throws', async () => {
    const fakeApp = makeFakeApp();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const closeDb = vi.fn();
    const appQuit = vi.fn(() => {
      throw new Error('quit blew up');
    });
    const appLike = { on: fakeApp.on.bind(fakeApp), quit: appQuit };

    const { registerLifecycleHandlers } = await import('../lifecycle/appLifecycle');
    registerLifecycleHandlers({
      app: appLike as unknown as import('electron').App,
      getIsQuitting: () => true,
      setIsQuitting: () => {},
      killAllPtySessions: async () => {},
      closeDb,
      createWindow: () => {},
      getWindowCount: () => 0,
    });

    expect(() => fakeApp.emit('window-all-closed')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[appLifecycle] disposer app.quit threw'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});
