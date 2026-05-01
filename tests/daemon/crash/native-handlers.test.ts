// tests/daemon/crash/native-handlers.test.ts
//
// Phase 3 crash observability (spec §5.2 option A, plan Task 11).
//
// Verifies the POSIX signal trap:
//   * registers a handler when running on POSIX
//   * is a no-op on Windows (no POSIX signals)
//   * subscribes to all signals in TRAPPED_SIGNALS
//   * on synthetic signal emission, writes the marker file via the
//     injected writeFileSyncImpl seam to the expected path
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import {
  installNativeCrashHandlers,
  TRAPPED_SIGNALS,
  _resetForTest,
  _registeredHandlerForTest,
} from '../../../daemon/src/crash/native-handlers';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-nat-'));
  _resetForTest();
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function makeFakeProc(platform: NodeJS.Platform): NodeJS.Process {
  const proc = new EventEmitter() as unknown as NodeJS.Process;
  Object.defineProperty(proc, 'platform', { value: platform, configurable: true });
  Object.defineProperty(proc, 'pid', { value: 12345, configurable: true });
  Object.defineProperty(proc, 'arch', { value: 'x64', configurable: true });
  Object.defineProperty(proc, 'versions', { value: { node: '20.0.0' }, configurable: true });
  Object.defineProperty(proc, 'env', { value: { npm_package_version: '0.4.0' }, configurable: true });
  (proc as unknown as { exit: (c?: number) => void }).exit = () => { /* swallow */ };
  return proc;
}

describe('installNativeCrashHandlers', () => {
  it('is a no-op on win32', () => {
    const proc = makeFakeProc('win32');
    const result = installNativeCrashHandlers({
      runtimeRoot: tmp, bootNonce: 'BN1', processRef: proc,
    });
    expect(result).toBeNull();
    expect(_registeredHandlerForTest()).toBeNull();
  });

  it('registers on POSIX with marker path under <runtimeRoot>/crash/<bootNonce>-native.dmp', () => {
    const proc = makeFakeProc('linux');
    const result = installNativeCrashHandlers({
      runtimeRoot: tmp, bootNonce: 'BN1', processRef: proc,
    });
    expect(result).not.toBeNull();
    expect(result?.dmpPath).toBe(path.join(tmp, 'crash', 'BN1-native.dmp'));
  });

  it('subscribes to all TRAPPED_SIGNALS (SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT)', () => {
    const proc = makeFakeProc('linux');
    installNativeCrashHandlers({ runtimeRoot: tmp, bootNonce: 'BN2', processRef: proc });
    // Each signal should have at least one listener attached by the install.
    for (const sig of TRAPPED_SIGNALS) {
      const listeners = proc.listeners(sig as NodeJS.Signals);
      expect(listeners.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('writes a marker file via the writeFileSyncImpl seam on synthetic signal', () => {
    const proc = makeFakeProc('linux');
    const writes: { p: string; data: string }[] = [];
    installNativeCrashHandlers({
      runtimeRoot: tmp,
      bootNonce: 'BN3',
      processRef: proc,
      writeFileSyncImpl: (p, data) => writes.push({ p, data }),
    });
    // Emit a synthetic SIGSEGV through the fake process.
    (proc as unknown as EventEmitter).emit('SIGSEGV');
    expect(writes.length).toBe(1);
    expect(writes[0]!.p).toBe(path.join(tmp, 'crash', 'BN3-native.dmp'));
    const marker = JSON.parse(writes[0]!.data);
    expect(marker.schemaVersion).toBe(1);
    expect(marker.signal).toBe('SIGSEGV');
    expect(marker.bootNonce).toBe('BN3');
    expect(marker.pid).toBe(12345);
    expect(marker.surface).toBe('daemon-native');
  });
});
