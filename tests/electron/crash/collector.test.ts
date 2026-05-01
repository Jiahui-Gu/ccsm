// tests/electron/crash/collector.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { startCrashCollector } from '../../../electron/crash/collector';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-coll-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('crash collector', () => {
  it('recordIncident writes meta.json with surface and ts', () => {
    const c = startCrashCollector({ crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'), appVersion: '0.3.0', electronVersion: '41.3.0' });
    const dir = c.recordIncident({ surface: 'main', error: { message: 'boom', stack: 'at x' } });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta.surface).toBe('main');
    expect(meta.schemaVersion).toBe(1);
    expect(typeof meta.ts).toBe('string');
  });

  it('recordIncident writes stderr-tail and stdout-tail when supplied', () => {
    const c = startCrashCollector({ crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'), appVersion: '0.3.0', electronVersion: '41.3.0' });
    const dir = c.recordIncident({
      surface: 'daemon-exit', exitCode: null, signal: 'SIGSEGV',
      stderrTail: ['err1', 'err2'], stdoutTail: ['out1'],
      lastTraceId: '01ARZ3', bootNonce: 'BN1',
    });
    expect(fs.readFileSync(path.join(dir, 'stderr-tail.txt'), 'utf8')).toBe('err1\nerr2\n');
    expect(fs.readFileSync(path.join(dir, 'stdout-tail.txt'), 'utf8')).toBe('out1\n');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta.backend.signal).toBe('SIGSEGV');
    expect(meta.backend.lastTraceId).toBe('01ARZ3');
  });

  it('adoptDmpStaging moves *.dmp into incident dir as frontend.dmp', () => {
    const staging = path.join(tmp, '_dmp-staging');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'a.dmp'), 'D1');
    const c = startCrashCollector({ crashRoot: tmp, dmpStaging: staging, appVersion: '0.3.0', electronVersion: '41.3.0' });
    const dir = c.recordIncident({ surface: 'main' });
    expect(fs.existsSync(path.join(dir, 'frontend.dmp'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'a.dmp'))).toBe(false);
  });

  it('retention prunes only entries that are BOTH older than maxAgeDays AND beyond maxCount (spec §10 AND-prune)', () => {
    // 21 incidents; oldest is 31 days old; expect exactly 1 pruned (the >30d one beyond the 20-newest window).
    const c = startCrashCollector({ crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'), appVersion: '0.3.0', electronVersion: '41.3.0' });
    const dirs: string[] = [];
    for (let i = 0; i < 21; i++) dirs.push(c.recordIncident({ surface: 'main' }));
    const dayMs = 24 * 3600 * 1000;
    const now = Date.now();
    // Backdate mtimes spanning ~31 days: dirs[0] is 31 days old, dirs[20] is today.
    for (let i = 0; i < 21; i++) {
      const ageDays = 31 - (i * (31 / 20)); // 31, ~29.45, ..., 0
      const t = (now - ageDays * dayMs) / 1000;
      fs.utimesSync(dirs[i]!, t, t);
    }
    c.pruneRetention({ maxCount: 20, maxAgeDays: 30 });
    const remaining = fs.readdirSync(tmp).filter(n => !n.startsWith('_'));
    expect(remaining.length).toBe(20);
    // The 31-day-old entry (dirs[0]) must be the one pruned.
    expect(fs.existsSync(dirs[0]!)).toBe(false);
    expect(fs.existsSync(dirs[20]!)).toBe(true);
  });

  it('retention does NOT prune when count exceeds limit but all are recent (age alone does not trigger)', () => {
    // 25 incidents all dated today → 0 pruned (none are >30d, even though 5 are over the 20-count limit).
    const c = startCrashCollector({ crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'), appVersion: '0.3.0', electronVersion: '41.3.0' });
    for (let i = 0; i < 25; i++) c.recordIncident({ surface: 'main' });
    c.pruneRetention({ maxCount: 20, maxAgeDays: 30 });
    const remaining = fs.readdirSync(tmp).filter(n => !n.startsWith('_'));
    expect(remaining.length).toBe(25);
  });

  it('retention does NOT prune when entries are old but count is under limit (count alone does not trigger)', () => {
    // 5 incidents all 35 days old → 0 pruned (under the 20-count window, so kept regardless of age).
    const c = startCrashCollector({ crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'), appVersion: '0.3.0', electronVersion: '41.3.0' });
    const dirs: string[] = [];
    for (let i = 0; i < 5; i++) dirs.push(c.recordIncident({ surface: 'main' }));
    const old = (Date.now() - 35 * 24 * 3600 * 1000) / 1000;
    for (const d of dirs) fs.utimesSync(d, old, old);
    c.pruneRetention({ maxCount: 20, maxAgeDays: 30 });
    const remaining = fs.readdirSync(tmp).filter(n => !n.startsWith('_'));
    expect(remaining.length).toBe(5);
  });
});
