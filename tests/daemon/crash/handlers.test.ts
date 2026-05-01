// tests/daemon/crash/handlers.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { installCrashHandlers } from '../../../daemon/src/crash/handlers';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-d-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('installCrashHandlers', () => {
  it('writes marker file and exits with code 70 on uncaught', () => {
    const exits: number[] = [];
    const proc = new EventEmitter();
    (proc as any).exit = (c: number) => { exits.push(c); };
    installCrashHandlers({
      logger: pino({ level: 'silent' }),
      bootNonce: 'BN1',
      runtimeRoot: tmp,
      getLastTraceId: () => 'TR1',
      processRef: proc as any,
    });
    proc.emit('uncaughtException', new Error('boom'));
    const marker = path.join(tmp, 'crash', 'BN1.json');
    expect(fs.existsSync(marker)).toBe(true);
    const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
    expect(m.bootNonce).toBe('BN1');
    expect(m.surface).toBe('daemon-uncaught');
    expect(m.kind).toBe('uncaughtException');
    expect(m.message).toBe('boom');
    expect(m.lastTraceId).toBe('TR1');
    expect(exits).toEqual([70]);
  });

  it('handles unhandledRejection', () => {
    const exits: number[] = [];
    const proc = new EventEmitter();
    (proc as any).exit = (c: number) => { exits.push(c); };
    installCrashHandlers({
      logger: pino({ level: 'silent' }), bootNonce: 'BN2',
      runtimeRoot: tmp, getLastTraceId: () => undefined, processRef: proc as any,
    });
    proc.emit('unhandledRejection', new Error('rej'));
    const m = JSON.parse(fs.readFileSync(path.join(tmp, 'crash', 'BN2.json'), 'utf8'));
    expect(m.kind).toBe('unhandledRejection');
    expect(exits).toEqual([70]);
  });
});
