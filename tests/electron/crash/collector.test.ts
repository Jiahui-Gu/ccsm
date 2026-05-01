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

  it('retention prunes beyond max(20 incidents, 30 days)', () => {
    // Create 25 incidents all dated today, expect 5 oldest pruned (>20, all within 30d).
    const c = startCrashCollector({ crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'), appVersion: '0.3.0', electronVersion: '41.3.0' });
    for (let i = 0; i < 25; i++) c.recordIncident({ surface: 'main' });
    c.pruneRetention({ maxCount: 20, maxAgeDays: 30 });
    const remaining = fs.readdirSync(tmp).filter(n => !n.startsWith('_'));
    expect(remaining.length).toBe(20);
  });
});
