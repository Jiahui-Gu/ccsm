// Unit tests for electron/abi-self-heal.ts (Task #641 Layer 3).
//
// Strategy: drive every branch of `runAbiSelfHeal` via injected `deps`
// — no real child processes, no real require, no real fs touch.

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  runAbiSelfHeal,
  isAbiMismatchError,
  selfHealMarkerPath,
  type SelfHealDeps,
} from '../electron/abi-self-heal';

/** In-memory fs mock shaped to the subset runAbiSelfHeal touches. */
function makeFsMock(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    existsSync: (p: string) => store.has(p),
    mkdirSync: (_p: string, _opts?: unknown) => {
      /* no-op — we only care about the eventual writeFileSync */
    },
    readFileSync: (p: string, _enc: string) => {
      const v = store.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFileSync: (p: string, data: string) => {
      store.set(p, String(data));
    },
    unlinkSync: (p: string) => {
      store.delete(p);
    },
  };
}

/** Build a baseline deps object; tests override fields per scenario. */
function makeDeps(overrides: Partial<SelfHealDeps> = {}): SelfHealDeps {
  const userDataDir = path.join(os.tmpdir(), 'abi-self-heal-test');
  const appRoot = path.join(os.tmpdir(), 'abi-self-heal-test-app');
  const fsMock = makeFsMock({
    // By default: pretend electron-rebuild bin EXISTS so the rebuild step
    // is reachable. Tests can override this.
    [path.join(appRoot, 'node_modules', '.bin', 'electron-rebuild')]: 'fake-bin',
    [path.join(appRoot, 'node_modules', '.bin', 'electron-rebuild.cmd')]: 'fake-bin',
  });
  return {
    userDataDir,
    appRoot,
    isPackaged: false,
    platform: 'linux',
    probeBetterSqlite3: () => null,
    runRebuild: () => ({ status: 0, stderrTail: '' }),
    fs: fsMock,
    log: () => { /* silent */ },
    ...overrides,
  };
}

describe('isAbiMismatchError', () => {
  it('matches the canonical NODE_MODULE_VERSION string', () => {
    const err = new Error(
      `The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 145.`,
    );
    expect(isAbiMismatchError(err)).toBe(true);
  });

  it('matches the alternate phrasing in stack traces', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n  at ... requires NODE_MODULE_VERSION 145';
    expect(isAbiMismatchError(err)).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isAbiMismatchError(new Error('SQLITE_CANTOPEN: unable to open db'))).toBe(false);
    expect(isAbiMismatchError(new Error('Cannot find module better-sqlite3'))).toBe(false);
    expect(isAbiMismatchError(null)).toBe(false);
  });
});

describe('runAbiSelfHeal', () => {
  let deps: SelfHealDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('returns ok when probe succeeds', () => {
    const result = runAbiSelfHeal(deps);
    expect(result.kind).toBe('ok');
  });

  it('clears a stale marker when probe succeeds', () => {
    const fsMock = makeFsMock({
      [path.join(deps.appRoot, 'node_modules', '.bin', 'electron-rebuild')]: 'x',
      [selfHealMarkerPath(deps.userDataDir)]: '{"error":"stale"}',
    });
    deps = makeDeps({ fs: fsMock });
    const result = runAbiSelfHeal(deps);
    expect(result.kind).toBe('ok');
    expect(fsMock.store.has(selfHealMarkerPath(deps.userDataDir))).toBe(false);
  });

  it('passes through non-ABI probe failures (leaves to #639 banner)', () => {
    const probeErr = new Error('SQLITE_CANTOPEN: unable to open database file');
    deps = makeDeps({ probeBetterSqlite3: () => probeErr });
    const result = runAbiSelfHeal(deps);
    expect(result.kind).toBe('rebuild-failed');
    if (result.kind === 'rebuild-failed') {
      expect(result.error).toContain('SQLITE_CANTOPEN');
    }
  });

  it('runs the rebuild on ABI mismatch and returns healed', () => {
    const probeErr = new Error(
      'NODE_MODULE_VERSION 127 ... requires NODE_MODULE_VERSION 145',
    );
    let rebuildCalls = 0;
    deps = makeDeps({
      probeBetterSqlite3: () => probeErr,
      runRebuild: () => {
        rebuildCalls += 1;
        return { status: 0, stderrTail: '' };
      },
    });
    const result = runAbiSelfHeal(deps);
    expect(rebuildCalls).toBe(1);
    expect(result.kind).toBe('healed');
    if (result.kind === 'healed') {
      expect(result.restartHint).toBe('app.relaunch');
    }
  });

  it('writes the one-shot marker BEFORE running rebuild (crash-safe)', () => {
    const probeErr = new Error('NODE_MODULE_VERSION 127 requires NODE_MODULE_VERSION 145');
    const fsMock = makeFsMock({
      [path.join(deps.appRoot, 'node_modules', '.bin', 'electron-rebuild')]: 'x',
    });
    let markerAtRebuildTime = false;
    deps = makeDeps({
      fs: fsMock,
      probeBetterSqlite3: () => probeErr,
      runRebuild: () => {
        markerAtRebuildTime = fsMock.store.has(selfHealMarkerPath(deps.userDataDir));
        return { status: 0, stderrTail: '' };
      },
    });
    runAbiSelfHeal(deps);
    expect(markerAtRebuildTime).toBe(true);
  });

  it('refuses to loop when the marker is already present', () => {
    const probeErr = new Error('NODE_MODULE_VERSION 127 requires NODE_MODULE_VERSION 145');
    const fsMock = makeFsMock({
      [path.join(deps.appRoot, 'node_modules', '.bin', 'electron-rebuild')]: 'x',
      [selfHealMarkerPath(deps.userDataDir)]: JSON.stringify({ error: 'last attempt failed', ts: 0 }),
    });
    let rebuildCalls = 0;
    deps = makeDeps({
      fs: fsMock,
      probeBetterSqlite3: () => probeErr,
      runRebuild: () => {
        rebuildCalls += 1;
        return { status: 0, stderrTail: '' };
      },
    });
    const result = runAbiSelfHeal(deps);
    expect(rebuildCalls).toBe(0); // critical: did NOT loop into another rebuild
    expect(result.kind).toBe('already-tried');
    if (result.kind === 'already-tried') {
      expect(result.lastError).toContain('last attempt failed');
    }
  });

  it('reports rebuild-failed when the rebuild subprocess returns non-zero', () => {
    const probeErr = new Error('NODE_MODULE_VERSION 127 requires NODE_MODULE_VERSION 145');
    deps = makeDeps({
      probeBetterSqlite3: () => probeErr,
      runRebuild: () => ({ status: 1, stderrTail: 'gyp ERR! permission denied' }),
    });
    const result = runAbiSelfHeal(deps);
    expect(result.kind).toBe('rebuild-failed');
    if (result.kind === 'rebuild-failed') {
      expect(result.error).toContain('exited with code 1');
      expect(result.error).toContain('gyp ERR');
    }
  });

  it('degrades gracefully in packaged builds when electron-rebuild is missing', () => {
    const probeErr = new Error('NODE_MODULE_VERSION 127 requires NODE_MODULE_VERSION 145');
    // Empty fs — rebuild bin does NOT exist (mimics packaged install).
    const fsMock = makeFsMock({});
    deps = makeDeps({
      isPackaged: true,
      probeBetterSqlite3: () => probeErr,
      fs: fsMock,
    });
    const result = runAbiSelfHeal(deps);
    expect(result.kind).toBe('rebuild-failed');
    if (result.kind === 'rebuild-failed') {
      expect(result.error).toContain('not available');
    }
    // Marker written so we don't try-and-fail on every launch.
    expect(fsMock.store.has(selfHealMarkerPath(deps.userDataDir))).toBe(true);
  });

  it('uses the .cmd bin name on Windows', () => {
    const probeErr = new Error('NODE_MODULE_VERSION 127 requires NODE_MODULE_VERSION 145');
    const cmdPath = path.join(deps.appRoot, 'node_modules', '.bin', 'electron-rebuild.cmd');
    const fsMock = makeFsMock({ [cmdPath]: 'x' });
    let usedBin = '';
    deps = makeDeps({
      platform: 'win32',
      fs: fsMock,
      probeBetterSqlite3: () => probeErr,
      runRebuild: (rebuildBin) => {
        usedBin = rebuildBin;
        return { status: 0, stderrTail: '' };
      },
    });
    const result = runAbiSelfHeal(deps);
    expect(usedBin).toBe(cmdPath);
    expect(result.kind).toBe('healed');
  });
});
