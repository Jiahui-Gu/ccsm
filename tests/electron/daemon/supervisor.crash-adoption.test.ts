// tests/electron/daemon/supervisor.crash-adoption.test.ts
//
// Phase 3 crash observability (spec §5.2 / §10, plan Task 11).
//
// Verifies that the supervisor's `attachCrashCapture` adopts a daemon native
// crash marker (`<runtimeRoot>/crash/<bootNonce>-native.dmp`) into the
// umbrella incident dir as `backend.dmp` on abnormal child exit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { attachCrashCapture } from '../../../electron/daemon/supervisor';
import { startCrashCollector } from '../../../electron/crash/collector';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-supadopt-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = Readable.from(['out\n'], { objectMode: false });
  child.stderr = Readable.from(['err\n'], { objectMode: false });
  return child;
}

function findIncidentDir(root: string): string {
  const dirs = fs.readdirSync(root).filter((n) => !n.startsWith('_') && n !== 'crash');
  expect(dirs.length).toBe(1);
  return path.join(root, dirs[0]!);
}

describe('supervisor crash-marker adoption (phase 3)', () => {
  it('adopts <bootNonce>-native.dmp as backend.dmp on SIGSEGV exit', async () => {
    fs.mkdirSync(path.join(tmp, 'crash'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'crash', 'BN-N1-native.dmp'),
      JSON.stringify({ schemaVersion: 1, signal: 'SIGSEGV', surface: 'daemon-native' }),
    );
    const collector = startCrashCollector({
      crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.4.0', electronVersion: '41.3.0',
    });
    const handle = {
      child: makeFakeChild(), bootNonce: 'BN-N1', lastTraceId: undefined,
      runtimeRoot: tmp, onCrash: () => { /* noop */ },
    };
    attachCrashCapture(handle as any, collector);
    await new Promise((r) => setTimeout(r, 10));
    handle.child.emit('exit', null, 'SIGSEGV');
    await new Promise((r) => setTimeout(r, 20));

    const dir = findIncidentDir(tmp);
    const adopted = path.join(dir, 'backend.dmp');
    expect(fs.existsSync(adopted)).toBe(true);
    // Original marker was renamed (moved), not copied.
    expect(fs.existsSync(path.join(tmp, 'crash', 'BN-N1-native.dmp'))).toBe(false);
  });

  it('adopts <bootNonce>-native.dmp on non-zero non-70 exit code', async () => {
    fs.mkdirSync(path.join(tmp, 'crash'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'crash', 'BN-N2-native.dmp'),
      JSON.stringify({ schemaVersion: 1, signal: 'SIGABRT', surface: 'daemon-native' }),
    );
    const collector = startCrashCollector({
      crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.4.0', electronVersion: '41.3.0',
    });
    const handle = {
      child: makeFakeChild(), bootNonce: 'BN-N2', lastTraceId: undefined,
      runtimeRoot: tmp, onCrash: () => { /* noop */ },
    };
    attachCrashCapture(handle as any, collector);
    await new Promise((r) => setTimeout(r, 10));
    handle.child.emit('exit', 134, null); // SIGABRT-style abnormal code
    await new Promise((r) => setTimeout(r, 20));

    const dir = findIncidentDir(tmp);
    expect(fs.existsSync(path.join(dir, 'backend.dmp'))).toBe(true);
  });

  it('does NOT adopt on orderly exit (code === 0)', async () => {
    fs.mkdirSync(path.join(tmp, 'crash'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'crash', 'BN-N3-native.dmp'),
      JSON.stringify({ schemaVersion: 1, signal: 'SIGSEGV', surface: 'daemon-native' }),
    );
    const collector = startCrashCollector({
      crashRoot: tmp, dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.4.0', electronVersion: '41.3.0',
    });
    const handle = {
      child: makeFakeChild(), bootNonce: 'BN-N3', lastTraceId: undefined,
      runtimeRoot: tmp, onCrash: () => { /* noop */ },
    };
    attachCrashCapture(handle as any, collector);
    await new Promise((r) => setTimeout(r, 10));
    handle.child.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 20));

    const dir = findIncidentDir(tmp);
    expect(fs.existsSync(path.join(dir, 'backend.dmp'))).toBe(false);
    // Marker remains untouched on disk because we didn't scan.
    expect(fs.existsSync(path.join(tmp, 'crash', 'BN-N3-native.dmp'))).toBe(true);
  });
});
