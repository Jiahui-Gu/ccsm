// daemon/src/crash/__tests__/scrub.test.ts
//
// Task #60 — daemon-surface crash-scrub coverage. Daemon redactSecrets() is a
// deliberate mirror of electron/crash/scrub.ts; both must be kept in sync.
// The test below covers both the pure scrubber and the installCrashHandlers()
// integration (marker-JSON write redacts secrets from err.stack).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { redactSecrets } from '../scrub';
import { installCrashHandlers } from '../handlers';

describe('daemon redactSecrets (Task #60)', () => {
  it('(a) redacts Authorization: Bearer <token> in stack-trace strings', () => {
    const stack = 'Error: boom\n  at fetch (Authorization: Bearer sk-ant-deadbeef)\n  at run (foo.ts:1:1)';
    const out = redactSecrets(stack);
    expect(out).toContain('Authorization: <REDACTED>');
    expect(out).not.toContain('sk-ant-deadbeef');
  });
  it('(b) redacts ANTHROPIC_API_KEY=sk-xxx env-style assignments', () => {
    const line = 'spawn failed: ANTHROPIC_API_KEY=sk-ant-api-7777 PATH=/usr/bin node main.js';
    const out = redactSecrets(line);
    expect(out).toContain('ANTHROPIC_API_KEY=<REDACTED>');
    expect(out).not.toContain('sk-ant-api-7777');
    expect(out).toContain('PATH=/usr/bin');
  });
  it('(c) redacts object property obj.daemonSecret value', () => {
    const obj = { daemonSecret: 'super-sekret-value', ok: 'safe' };
    const out = redactSecrets(obj);
    expect(out.daemonSecret).toBe('<REDACTED>');
    expect(out.ok).toBe('safe');
  });
  it('also redacts helloNonceHmac + nested *.secret + Cookie', () => {
    const obj = {
      daemon: { secret: 'leak1', port: 9000 },
      helloNonceHmac: 'leak2',
      headers: 'Cookie: sid=abcd',
    };
    const out = redactSecrets(obj);
    expect((out.daemon as any).secret).toBe('<REDACTED>');
    expect((out.daemon as any).port).toBe(9000);
    expect(out.helloNonceHmac).toBe('<REDACTED>');
    expect(out.headers).toContain('Cookie: <REDACTED>');
  });
});

describe('installCrashHandlers writes redacted marker (Task #60)', () => {
  let runtimeRoot: string;
  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-daemon-crash-'));
  });
  afterEach(() => {
    try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function fakeLogger(): any {
    return { fatal: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }

  it('redacts Authorization header + ANTHROPIC_API_KEY from err.stack before writing marker', () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    (proc as any).exit = vi.fn(); // prevent real exit(70) — handler calls it
    const logger = fakeLogger();
    installCrashHandlers({
      logger,
      bootNonce: 'BOOT123',
      runtimeRoot,
      getLastTraceId: () => 'trace-abc',
      processRef: proc,
    });

    const err = new Error('boot failure: ANTHROPIC_API_KEY=sk-ant-XYZ');
    err.stack = 'Error: boot failure\n  at fetch (Authorization: Bearer sk-ant-zzz)\n  ANTHROPIC_API_KEY=sk-ant-XYZ';
    (proc as unknown as EventEmitter).emit('uncaughtException', err);

    const markerPath = path.join(runtimeRoot, 'crash', 'BOOT123.json');
    expect(fs.existsSync(markerPath)).toBe(true);
    const raw = fs.readFileSync(markerPath, 'utf8');
    // (a) Authorization
    expect(raw).toContain('Authorization: <REDACTED>');
    expect(raw).not.toContain('sk-ant-zzz');
    // (b) ANTHROPIC_API_KEY env-style
    expect(raw).toContain('ANTHROPIC_API_KEY=<REDACTED>');
    expect(raw).not.toContain('sk-ant-XYZ');
    // sanity: lastTraceId still recorded
    expect(raw).toContain('trace-abc');
  });

  it('(c) redacts daemonSecret embedded as JSON property in stack', () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    (proc as any).exit = vi.fn();
    const logger = fakeLogger();
    installCrashHandlers({
      logger,
      bootNonce: 'BOOT456',
      runtimeRoot,
      getLastTraceId: () => undefined,
      processRef: proc,
    });

    const err = new Error('config: {"daemonSecret":"super-sekret-9"}');
    err.stack = 'Error: config: {"daemonSecret":"super-sekret-9"}\n  at boot';
    (proc as unknown as EventEmitter).emit('uncaughtException', err);

    const raw = fs.readFileSync(path.join(runtimeRoot, 'crash', 'BOOT456.json'), 'utf8');
    expect(raw).not.toContain('super-sekret-9');
    expect(raw).toContain('<REDACTED>');
  });
});
