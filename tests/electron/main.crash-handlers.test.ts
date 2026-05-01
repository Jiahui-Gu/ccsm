// tests/electron/main.crash-handlers.test.ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireCrashHandlers } from '../../electron/main-crash-wiring';

describe('wireCrashHandlers', () => {
  it('uncaughtException routes to collector with surface=main', () => {
    const calls: any[] = [];
    const collector = { recordIncident: (i: any) => { calls.push(i); return '/tmp/x'; }, flush: async () => {}, pruneRetention: () => {} };
    const proc = new EventEmitter();
    wireCrashHandlers({ collector, processRef: proc as any });
    proc.emit('uncaughtException', new Error('boom'));
    expect(calls.length).toBe(1);
    expect(calls[0].surface).toBe('main');
    expect(calls[0].error.message).toBe('boom');
  });

  it('unhandledRejection routes to collector', () => {
    const calls: any[] = [];
    const collector = { recordIncident: (i: any) => { calls.push(i); return '/tmp/x'; }, flush: async () => {}, pruneRetention: () => {} };
    const proc = new EventEmitter();
    wireCrashHandlers({ collector, processRef: proc as any });
    proc.emit('unhandledRejection', new Error('rej'));
    expect(calls.length).toBe(1);
    expect(calls[0].error.message).toBe('rej');
  });
});
