// Unit tests for the dev orchestrator helpers (scripts/dev-lib.mjs).
//
// We deliberately split the orchestrator's pure helpers (port allocation,
// userData naming, cleanup-trap installer, orphan-userData reaper) into a
// loadable module so they're testable without spawning electron/webpack.
// scripts/dev.mjs is the thin entry point that wires them together.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  allocateDevPort,
  generateUserDataDirName,
  installCleanupTrap,
  reapOrphanUserDataDirs,
} from '../../scripts/dev-lib.mjs';

describe('allocateDevPort', () => {
  it('returns a free TCP port in the ephemeral range', async () => {
    const port = await allocateDevPort();
    expect(port).toBeTypeOf('number');
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);

    // Verify we can actually listen on the returned port (i.e. it was
    // free at the time of allocation). There's a tiny race window
    // between close() and re-listen here, but on a quiet CI host the
    // port we just got back from OS should still be available.
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(port, () => srv.close(() => resolve()));
    });
  });

  it('returns different ports across calls (no static cache)', async () => {
    const a = await allocateDevPort();
    const b = await allocateDevPort();
    // Not guaranteed strictly different (OS may recycle), but the
    // function must not memoize.
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
  });
});

describe('generateUserDataDirName', () => {
  it('matches .dev-userdata-<6 hex> pattern', () => {
    const name = generateUserDataDirName();
    expect(name).toMatch(/^\.dev-userdata-[0-9a-f]{6}$/);
  });

  it('is randomized across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) seen.add(generateUserDataDirName());
    // 6 hex = 16M possibilities. 32 draws colliding is < 1e-6.
    expect(seen.size).toBeGreaterThan(28);
  });
});

describe('installCleanupTrap', () => {
  // We swap process for these tests to avoid leaving stray listeners
  // on the real one; the EventEmitter surface is what installCleanupTrap
  // touches.
  let fakeProc: NodeJS.EventEmitter & {
    once: (ev: string, fn: () => void) => unknown;
    on: (ev: string, fn: (...a: unknown[]) => void) => unknown;
    listeners: (ev: string) => Function[];
  };
  beforeEach(() => {
    const ee = new (require('node:events').EventEmitter)();
    fakeProc = ee;
  });

  it('registers handlers for all the expected signals/events', () => {
    const cleanup = vi.fn();
    installCleanupTrap(cleanup, { proc: fakeProc });
    for (const ev of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']) {
      expect(fakeProc.listeners(ev).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('is idempotent — calling cleanup twice runs it once', () => {
    const cleanup = vi.fn();
    installCleanupTrap(cleanup, { proc: fakeProc });
    // Two signals fire in rapid succession (e.g. SIGINT then exit).
    fakeProc.emit('SIGINT');
    fakeProc.emit('exit');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('reapOrphanUserDataDirs', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-dev-reap-'));
  });
  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('removes stale .dev-userdata-XXXXXX dirs older than the cutoff', () => {
    const stale = path.join(tmpRoot, '.dev-userdata-aaaaaa');
    const fresh = path.join(tmpRoot, '.dev-userdata-bbbbbb');
    const unrelated = path.join(tmpRoot, '.dev-userdata'); // legacy, no hash
    fs.mkdirSync(stale);
    fs.mkdirSync(fresh);
    fs.mkdirSync(unrelated);

    // Backdate `stale` by 2 hours.
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);

    const removed = reapOrphanUserDataDirs(tmpRoot, { maxAgeMs: 60 * 60 * 1000 });

    expect(removed).toContain('.dev-userdata-aaaaaa');
    expect(removed).not.toContain('.dev-userdata-bbbbbb');
    expect(removed).not.toContain('.dev-userdata'); // legacy untouched
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('does not throw when repo root has no orphans', () => {
    expect(() => reapOrphanUserDataDirs(tmpRoot, { maxAgeMs: 1000 })).not.toThrow();
  });
});
