/**
 * Load-smoke harness — Task #764 Section B.
 *
 * Per project memory `feedback_main_process_load_smoke_test.md`, every
 * electron/** runtime module must require-load cleanly under Node CJS.
 * Single-test failures show up at production launch (e.g. PR #501's ESM
 * regression that bricked the app boot). This harness exercises the
 * post-build CJS output for every electron module the audit identified
 * as a runtime/sink with zero direct test coverage.
 *
 * Mechanism: install a Module._resolveFilename hook that maps `electron`
 * (and a couple of native deps that fail to load outside Electron) to
 * the shape-only stub at `tests/fixtures/electronStub.cjs`. Then `require()`
 * each dist file. Any throw — ESM `import`/export syntax, missing helper,
 * top-level side effect crash — fails the test.
 *
 * Requires `npm run build` to have produced `dist/electron/*.js` first.
 * `tests/setup.ts` does NOT run build (too slow per test); the CI pipeline
 * runs build before vitest, and the test below skips with a clear message
 * if dist is absent so local devs aren't blocked.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Module from 'node:module';

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_ELECTRON = path.join(REPO_ROOT, 'dist', 'electron');
const ELECTRON_STUB = path.join(REPO_ROOT, 'tests', 'fixtures', 'electronStub.cjs');

// Modules to redirect at resolve-time. `electron` is unavailable outside
// the Electron runtime; `better-sqlite3` and `node-pty` ship native bindings
// that fail to load under plain Node on some dev machines (and we do not
// need their behavior for a load-smoke).
const STUB_MODULES = new Set(['electron']);

// `better-sqlite3` and `node-pty` may load fine if the prebuilt native is
// present; only stub them if a load attempt fails. We do that by leaving
// them alone and letting the require attempt surface a clear error if
// the prebuilt is missing.

function installElectronResolveHook(): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ModuleAny = Module as any;
  const orig = ModuleAny._resolveFilename;
  ModuleAny._resolveFilename = function (
    request: string,
    parent: unknown,
    ...rest: unknown[]
  ): string {
    if (STUB_MODULES.has(request)) {
      return ELECTRON_STUB;
    }
    return orig.call(this, request, parent, ...rest);
  };
  return () => {
    ModuleAny._resolveFilename = orig;
  };
}

// List of dist/electron paths to load-smoke. Sourced from the test-audit
// phase 1 Section 2b enumeration plus a couple of always-loaded modules
// that the audit covered indirectly. Keep grouped by area so failures
// point at the obvious owner.
//
// Wave-2-C: notify decider/tracker/classifier/badgeStore + sessionWatcher
// physically mv'd to daemon/. Their daemon-side load-smoke is exercised
// by `node dist/daemon/main.js` printing "[daemon] startup phase complete"
// (any module-load throw at boot fails that). Old electron paths removed
// here so the smoke list reflects what actually ships in dist/electron.
//
// Wave-2-A: sentry/init also physically mv'd into daemon/ (its beforeSend
// reads prefs/crashReporting → db, which all live in daemon now). Removed
// from the electron load-smoke; daemon's own smoke is the gate.
const RUNTIME_MODULES: ReadonlyArray<readonly [string, string]> = [
  // notify sink consumer (NEW W2-C — main-process EventSource consumer
  // that fires the OS Notification + flashFrame for each daemon Decision).
  ['notify/sinkConsumer', 'notify/sinkConsumer.js'],
  // notify pure pixel + label helpers — kept in electron because the
  // BadgeManager OS overlay sink lives here historically; W2-D may mv.
  ['notify/badgeLabel', 'notify/badgeLabel.js'],
  ['notify/badgePixels', 'notify/badgePixels.js'],

  // sessionWatcher COMPAT SHIM (W2-C — drops in W2-B once ptyHost mv's).
  ['sessionWatcher/index', 'sessionWatcher/index.js'],
  ['sessionWatcher/projectKey', 'sessionWatcher/projectKey.js'],

  // ptyHost runtime/sink layer
  ['ptyHost/dataFanout', 'ptyHost/dataFanout.js'],
  // entryFactory + ipcRegistrar + lifecycle + index pull native node-pty;
  // covered by harness-real-cli e2e. Excluded from load-smoke to avoid
  // hard dependence on local native build.

  // tray + window — partly exercised by surviving harness-ui cases but no
  // load-smoke gate.
  ['tray/createTray', 'tray/createTray.js'],
  ['window/createWindow', 'window/createWindow.js'],
];

describe('electron-load-smoke — runtime/sink modules require cleanly (Task #764)', () => {
  let restore: (() => void) | null = null;
  let restoreVersions: (() => void) | null = null;

  beforeAll(() => {
    restore = installElectronResolveHook();
    // `@sentry/electron/main` reads `process.versions.electron` at module
    // load and crashes if it's undefined. Inject a synthetic version for
    // the duration of the smoke run; restore after.
    if (!process.versions.electron) {
      Object.defineProperty(process.versions, 'electron', {
        value: '33.0.0',
        configurable: true,
        writable: true,
      });
      restoreVersions = () => {
        delete (process.versions as Record<string, string | undefined>).electron;
      };
    }
  });

  it('dist/electron exists (run `npm run build` first)', () => {
    if (!fs.existsSync(DIST_ELECTRON)) {
      throw new Error(
        `dist/electron not found at ${DIST_ELECTRON}. Run \`npm run build\` before \`vitest run\`.`,
      );
    }
    expect(fs.existsSync(DIST_ELECTRON)).toBe(true);
  });

  it.each(RUNTIME_MODULES)('loads %s', (_label, relPath) => {
    const absPath = path.join(DIST_ELECTRON, relPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Expected dist file missing: ${absPath}. Did the TS layout change?`);
    }
    // Drop any cached version so a stale cache from a prior failing test
    // does not mask a regression. eslint-disable b/c require is the point.
    delete require.cache[require.resolve(absPath)];
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    expect(() => require(absPath)).not.toThrow();
  });

  // Cleanup: restore the resolve hook so other tests in the run are
  // unaffected (vitest isolates by file but be defensive).
  it('cleanup (no-op)', () => {
    if (restore) restore();
    restore = null;
    if (restoreVersions) restoreVersions();
    restoreVersions = null;
    expect(true).toBe(true);
  });
});
