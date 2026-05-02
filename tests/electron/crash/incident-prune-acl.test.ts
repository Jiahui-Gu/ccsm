// tests/electron/crash/incident-prune-acl.test.ts
// Task #131 — 30-day retention prune + 0600 ACL verify.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  pruneIncidents,
  schedulePruneIncidents,
  verifyAndFixCrashAcl,
  createIncidentDir,
} from '../../../electron/crash/incident-dir';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-crash-prune-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const DAY = 24 * 3600 * 1000;

function mkIncident(name: string, ageDays: number): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}');
  const t = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(dir, t, t);
  return dir;
}

describe('pruneIncidents (Task #131)', () => {
  it('removes incident dirs older than 30 days, keeps younger ones', () => {
    const old = mkIncident('2026-04-01-old', 31);
    const fresh = mkIncident('2026-04-30-fresh', 29);
    const log = { warn: vi.fn(), info: vi.fn() };
    const r = pruneIncidents(tmp, { logger: log });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(r.removedCount).toBe(1);
    expect(r.keptCount).toBe(1);
    expect(r.oldestMtime).not.toBeNull();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('crash_prune_complete'));
    expect(log.info.mock.calls[0]![0]).toContain('removed_count=1');
    expect(log.info.mock.calls[0]![0]).toContain('kept_count=1');
  });

  it('skips _dmp-staging and dotfiles', () => {
    fs.mkdirSync(path.join(tmp, '_dmp-staging'), { recursive: true });
    fs.utimesSync(path.join(tmp, '_dmp-staging'),
      (Date.now() - 90 * DAY) / 1000, (Date.now() - 90 * DAY) / 1000);
    const log = { warn: vi.fn(), info: vi.fn() };
    const r = pruneIncidents(tmp, { logger: log });
    expect(fs.existsSync(path.join(tmp, '_dmp-staging'))).toBe(true);
    expect(r.removedCount).toBe(0);
  });

  it('fail-soft when readdir fails', () => {
    const log = { warn: vi.fn(), info: vi.fn() };
    const r = pruneIncidents(path.join(tmp, 'does-not-exist'), { logger: log });
    expect(r.removedCount).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('crash_prune_skip'));
  });

  it('respects maxAgeDays override', () => {
    const a = mkIncident('week-old', 8);
    const b = mkIncident('day-old', 1);
    const log = { warn: vi.fn(), info: vi.fn() };
    pruneIncidents(tmp, { maxAgeDays: 7, logger: log });
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(true);
  });
});

describe('schedulePruneIncidents', () => {
  it('runs immediately + can be stopped', () => {
    mkIncident('old', 40);
    const log = { warn: vi.fn(), info: vi.fn() };
    const h = schedulePruneIncidents(tmp, { logger: log, intervalMs: 60_000 });
    try {
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('crash_prune_complete'));
    } finally {
      h.stop();
    }
  });

  it('does not throw if root vanishes between ticks', () => {
    const log = { warn: vi.fn(), info: vi.fn() };
    const h = schedulePruneIncidents(path.join(tmp, 'gone'), { logger: log, intervalMs: 60_000 });
    h.stop();
    // No exception => pass.
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('verifyAndFixCrashAcl', () => {
  const isWin = process.platform === 'win32';

  it.skipIf(isWin)('chmods POSIX dirs to 0700 and files to 0600 when wrong', () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.chmodSync(tmp, 0o755);
    const dir = path.join(tmp, '2026-05-01-abc');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
    const file = path.join(dir, 'meta.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o644);

    const log = { warn: vi.fn(), info: vi.fn() };
    const r = verifyAndFixCrashAcl(tmp, { logger: log });

    expect(fs.statSync(tmp).mode & 0o777).toBe(0o700);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(r.fixedCount).toBe(3);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('crash_acl_fixed'));
    expect(log.info.mock.calls.some(c => c[0].includes('after="0600"'))).toBe(true);
    expect(log.info.mock.calls.some(c => c[0].includes('after="0700"'))).toBe(true);
  });

  it.skipIf(isWin)('no-ops when modes are already correct', () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.chmodSync(tmp, 0o700);
    const dir = path.join(tmp, '2026-05-01-abc');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700);
    const log = { warn: vi.fn(), info: vi.fn() };
    const r = verifyAndFixCrashAcl(tmp, { logger: log });
    expect(r.fixedCount).toBe(0);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('Win path invokes injected icacls runner', () => {
    fs.mkdirSync(tmp, { recursive: true });
    const dir = path.join(tmp, '2026-05-01-abc');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), '{}');
    process.env.USERNAME = process.env.USERNAME ?? process.env.USER ?? 'testuser';
    const calls: Array<{ target: string; args: string[] }> = [];
    const runIcacls = (target: string, args: string[]): boolean => {
      calls.push({ target, args }); return true;
    };
    const log = { warn: vi.fn(), info: vi.fn() };
    const r = verifyAndFixCrashAcl(tmp, { platform: 'win32', runIcacls, logger: log });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some(c => c.args.includes('/inheritance:r'))).toBe(true);
    expect(calls.some(c => c.args[0] === '/grant:r')).toBe(true);
    expect(r.fixedCount).toBe(r.checkedCount);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('crash_acl_fixed'));
  });

  it('returns 0/0 when root does not exist', () => {
    const r = verifyAndFixCrashAcl(path.join(tmp, 'nope'));
    expect(r).toEqual({ fixedCount: 0, checkedCount: 0 });
  });
});

describe('createIncidentDir POSIX 0700', () => {
  it.skipIf(process.platform === 'win32')('new incident dir is 0700', () => {
    const dir = createIncidentDir(tmp);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});
