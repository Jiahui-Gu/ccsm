// tests/electron/daemon/supervisor.crash.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { attachCrashCapture } from '../../../electron/daemon/supervisor';
import { startCrashCollector } from '../../../electron/crash/collector';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-sup-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = Readable.from(['out line 1\nout line 2\n'], { objectMode: false });
  child.stderr = Readable.from(['err line 1\nerr line 2\n'], { objectMode: false });
  return child;
}

describe('attachCrashCapture', () => {
  it('captures last N lines of stderr/stdout and writes incident on exit', async () => {
    const collector = startCrashCollector({
      crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0', electronVersion: '41.3.0',
    });
    const handle = {
      child: makeFakeChild(),
      bootNonce: 'BN1',
      lastTraceId: 'TR1',
      runtimeRoot: tmp,
      onCrash: (incidentDir: string, payload: any) => { (collector as any)._lastPayload = { incidentDir, payload }; },
    };
    attachCrashCapture(handle as any, collector);

    // wait for stream drain, then emit exit.
    await new Promise(r => setTimeout(r, 20));
    handle.child.emit('exit', null, 'SIGSEGV');
    await new Promise(r => setTimeout(r, 20));

    const dirs = fs.readdirSync(tmp).filter(n => !n.startsWith('_'));
    expect(dirs.length).toBe(1);
    const dir = path.join(tmp, dirs[0]!);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta.surface).toBe('daemon-exit');
    expect(meta.backend.signal).toBe('SIGSEGV');
    expect(meta.backend.bootNonce).toBe('BN1');
    expect(meta.backend.lastTraceId).toBe('TR1');
    const stderr = fs.readFileSync(path.join(dir, 'stderr-tail.txt'), 'utf8');
    expect(stderr).toContain('err line 2');
  });

  it('adopts <runtimeRoot>/crash/<bootNonce>.json marker', async () => {
    fs.mkdirSync(path.join(tmp, 'crash'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'crash', 'BN2.json'),
      JSON.stringify({ schemaVersion: 1, bootNonce: 'BN2', surface: 'daemon-uncaught', kind: 'uncaughtException', message: 'm', ts: 't' }));
    const collector = startCrashCollector({
      crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0', electronVersion: '41.3.0',
    });
    const handle = { child: makeFakeChild(), bootNonce: 'BN2', lastTraceId: undefined, runtimeRoot: tmp, onCrash: () => {} };
    attachCrashCapture(handle as any, collector);
    await new Promise(r => setTimeout(r, 10));
    handle.child.emit('exit', 70, null);
    await new Promise(r => setTimeout(r, 20));
    const dirs = fs.readdirSync(tmp).filter(n => !n.startsWith('_') && n !== 'crash');
    const dir = path.join(tmp, dirs[0]!);
    expect(fs.existsSync(path.join(dir, 'daemon-marker.json'))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta.backend.markerPresent).toBe(true);
  });
});
