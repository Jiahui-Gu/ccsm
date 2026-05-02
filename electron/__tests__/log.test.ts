// electron/__tests__/log.test.ts
//
// v0.3 task #125 / frag-6-7 §6.6.2 — pino logger contract tests.
//
// Three required gates from the task brief:
//   1. base fields ({ side: 'electron', v, pid, boot })
//   2. redact list scrubs secrets
//   3. pino.final crash hooks fire (logger.flush is invoked) on
//      app.before-quit / uncaughtException / unhandledRejection.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import {
  createLogger,
  installCrashHooks,
  installRendererLogForwarder,
  isRendererLogForwardEnabled,
  resolveElectronLogDir,
  maintainCurrentSymlink,
  ELECTRON_REDACT_PATHS,
  ELECTRON_LOG_CURRENT_SYMLINK,
  RENDERER_LOG_FORWARD_CHANNEL,
  RENDERER_LOG_FORWARD_ENV,
  electronBootNonce,
  __setLoggerForTest,
} from '../log';

/** Capture every line pino writes to a Writable so we can JSON.parse and
 *  assert structural shape. */
function makeSink(): { dest: Writable; lines: () => Array<Record<string, unknown>> } {
  const buf: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      buf.push(chunk.toString('utf8'));
      cb();
    },
  });
  return {
    dest,
    lines: () => buf
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

beforeEach(() => {
  __setLoggerForTest(undefined);
});

describe('electron/log — base fields', () => {
  it('emits { side, v, pid, boot } on every line', () => {
    const { dest, lines } = makeSink();
    const log = createLogger({ appVersion: '0.3.0-test', destination: dest, bootNonce: 'BOOT_TEST_ULID' });
    log.info('hello');
    log.warn('world');
    const out = lines();
    expect(out).toHaveLength(2);
    for (const line of out) {
      expect(line.side).toBe('electron');
      expect(line.v).toBe('0.3.0-test');
      expect(line.pid).toBe(process.pid);
      expect(line.boot).toBe('BOOT_TEST_ULID');
    }
  });

  it('falls back to module electronBootNonce when bootNonce omitted', () => {
    const { dest, lines } = makeSink();
    const log = createLogger({ appVersion: '0.3.0', destination: dest });
    log.info('x');
    expect(lines()[0]?.boot).toBe(electronBootNonce);
  });

  it('mirrors daemon side discriminator (NEVER "daemon")', () => {
    const { dest, lines } = makeSink();
    const log = createLogger({ appVersion: '1.0', destination: dest });
    log.info('x');
    expect(lines()[0]?.side).toBe('electron');
  });
});

describe('electron/log — redact list', () => {
  it('redacts task #125 minimum keys (secret/password/token/authorization/imposterSecret/daemon.secret)', () => {
    const { dest, lines } = makeSink();
    const log = createLogger({ appVersion: '0.3', destination: dest });
    log.info({
      authorization: 'Bearer abc',
      imposterSecret: 'SHOULD_NOT_LEAK',
      daemon: { secret: 'NOPE' },
      nested: {
        password: 'hunter2',
        token: 'tok_abc',
        secret: 's3cr3t',
      },
    }, 'redact-test');

    const line = lines()[0]!;
    const flat = JSON.stringify(line);
    expect(flat).not.toContain('Bearer abc');
    expect(flat).not.toContain('SHOULD_NOT_LEAK');
    expect(flat).not.toContain('hunter2');
    expect(flat).not.toContain('tok_abc');
    expect(flat).not.toContain('s3cr3t');
    expect(flat).not.toContain('NOPE');
    expect(flat).toContain('[Redacted]');
  });

  it('exposes the canonical redact paths constant including all six task-required keys', () => {
    expect(ELECTRON_REDACT_PATHS).toEqual(expect.arrayContaining([
      '*.secret',
      '*.password',
      '*.token',
      'daemon.secret',
      'imposterSecret',
      'authorization',
    ]));
  });

  it('redacts spec-mandated cross-side keys (helloNonceHmac, daemonSecret, ANTHROPIC_API_KEY)', () => {
    const { dest, lines } = makeSink();
    const log = createLogger({ appVersion: '0.3', destination: dest });
    log.info({
      helloNonceHmac: 'HMAC_VAL',
      daemonSecret: 'DAE_SEC',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
    }, 'spec-redact');
    const flat = JSON.stringify(lines()[0]);
    expect(flat).not.toContain('HMAC_VAL');
    expect(flat).not.toContain('DAE_SEC');
    expect(flat).not.toContain('sk-ant-xxx');
  });
});

describe('electron/log — installCrashHooks (pino.final analog)', () => {
  it('flushes logger on app.before-quit', () => {
    const flushed = vi.fn();
    const fakeLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      fatal: vi.fn(),
      flush: flushed,
    } as unknown as Parameters<typeof installCrashHooks>[1] extends { logger?: infer L } ? L : never;

    let beforeQuitHandler: (() => void) | undefined;
    const fakeApp = {
      on(event: string, h: () => void) {
        if (event === 'before-quit') beforeQuitHandler = h;
      },
    };
    const fakeProc = {
      on: vi.fn(),
      exit: vi.fn(),
    } as unknown as NodeJS.Process;

    installCrashHooks(fakeApp, { logger: fakeLogger as never, processRef: fakeProc, exitOnFatal: false });
    expect(beforeQuitHandler).toBeDefined();
    beforeQuitHandler?.();
    expect(flushed).toHaveBeenCalled();
  });

  it('flushes logger + logs fatal on uncaughtException', () => {
    const fatal = vi.fn();
    const flushed = vi.fn();
    const exited = vi.fn();
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const fakeProc = {
      on(event: string, h: (...a: unknown[]) => void) { handlers.set(event, h); },
      exit: exited,
    } as unknown as NodeJS.Process;
    const fakeApp = { on: vi.fn() };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), fatal, flush: flushed } as never;

    installCrashHooks(fakeApp, { logger: fakeLogger, processRef: fakeProc, exitOnFatal: false });

    const handler = handlers.get('uncaughtException');
    expect(handler).toBeDefined();
    handler?.(new Error('boom'));
    expect(fatal).toHaveBeenCalled();
    expect(flushed).toHaveBeenCalled();
    expect(exited).not.toHaveBeenCalled(); // exitOnFatal:false
  });

  it('flushes + exits on uncaughtException when exitOnFatal:true', () => {
    const exited = vi.fn();
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const fakeProc = {
      on(event: string, h: (...a: unknown[]) => void) { handlers.set(event, h); },
      exit: exited,
    } as unknown as NodeJS.Process;
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), fatal: vi.fn(), flush: vi.fn() } as never;

    installCrashHooks({ on: vi.fn() }, { logger: fakeLogger, processRef: fakeProc, exitOnFatal: true });
    handlers.get('uncaughtException')?.(new Error('boom'));
    expect(exited).toHaveBeenCalledWith(70);
  });

  it('handles unhandledRejection (non-Error reason wrapped)', () => {
    const fatal = vi.fn();
    const flushed = vi.fn();
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const fakeProc = {
      on(event: string, h: (...a: unknown[]) => void) { handlers.set(event, h); },
      exit: vi.fn(),
    } as unknown as NodeJS.Process;
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), fatal, flush: flushed } as never;

    installCrashHooks({ on: vi.fn() }, { logger: fakeLogger, processRef: fakeProc, exitOnFatal: false });
    handlers.get('unhandledRejection')?.('string-reason-not-error');
    expect(fatal).toHaveBeenCalled();
    expect(flushed).toHaveBeenCalled();
  });
});

describe('electron/log — renderer log forward gating', () => {
  it('isRendererLogForwardEnabled honours CCSM_RENDERER_LOG_FORWARD=1', () => {
    expect(isRendererLogForwardEnabled({ [RENDERER_LOG_FORWARD_ENV]: '1' })).toBe(true);
    expect(isRendererLogForwardEnabled({ [RENDERER_LOG_FORWARD_ENV]: '0' })).toBe(false);
    expect(isRendererLogForwardEnabled({})).toBe(false);
  });

  it('installRendererLogForwarder is a no-op when env unset (returns false)', () => {
    const ipcMain = { on: vi.fn() };
    const installed = installRendererLogForwarder(ipcMain, { env: {} });
    expect(installed).toBe(false);
    expect(ipcMain.on).not.toHaveBeenCalled();
  });

  it('installRendererLogForwarder subscribes to log:write when gate ON', () => {
    const ipcMain = { on: vi.fn() };
    const installed = installRendererLogForwarder(ipcMain, {
      env: { [RENDERER_LOG_FORWARD_ENV]: '1' },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as never,
    });
    expect(installed).toBe(true);
    expect(ipcMain.on).toHaveBeenCalledWith(RENDERER_LOG_FORWARD_CHANNEL, expect.any(Function));
  });

  it('renderer-forwarded payload is logged at requested level', () => {
    let handler: ((event: unknown, payload: unknown) => void) | undefined;
    const ipcMain = {
      on(_ch: string, h: (event: unknown, payload: unknown) => void) { handler = h; },
    };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
    installRendererLogForwarder(ipcMain, {
      env: { [RENDERER_LOG_FORWARD_ENV]: '1' },
      logger: fakeLogger as never,
    });
    // Pass the fromMainFrame guard: senderFrame === sender.mainFrame.
    const mainFrame = { id: 'main' };
    const event = { senderFrame: mainFrame, sender: { mainFrame } };
    handler?.(event, { level: 'warn', args: ['hello', { a: 1 }] });
    expect(fakeLogger.warn).toHaveBeenCalled();
    const callArgs = fakeLogger.warn.mock.calls[0]!;
    expect(callArgs[0]).toMatchObject({ event: 'renderer_console_forward', source: 'renderer' });
    expect(typeof callArgs[1]).toBe('string');
  });

  it('drops payload from sub-frame senders (fromMainFrame guard)', () => {
    let handler: ((event: unknown, payload: unknown) => void) | undefined;
    const ipcMain = {
      on(_ch: string, h: (event: unknown, payload: unknown) => void) { handler = h; },
    };
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
    installRendererLogForwarder(ipcMain, {
      env: { [RENDERER_LOG_FORWARD_ENV]: '1' },
      logger: fakeLogger as never,
    });
    const mainFrame = { id: 'main' };
    const subFrame = { id: 'iframe' };
    const event = { senderFrame: subFrame, sender: { mainFrame } };
    handler?.(event, { level: 'warn', args: ['evil-iframe-injection'] });
    expect(fakeLogger.warn).not.toHaveBeenCalled();
    expect(fakeLogger.info).not.toHaveBeenCalled();
  });
});

describe('electron/log — log dir resolution', () => {
  it('resolves to <dataRoot>/logs/electron', () => {
    const dir = resolveElectronLogDir({
      platform: 'linux',
      home: '/home/u',
      env: { CCSM_DATA_ROOT: '/tmp/ccsm-test' },
    });
    expect(dir).toBe(path.join('/tmp/ccsm-test', 'logs', 'electron'));
  });
});

// POSIX-only: Windows requires developer mode (or admin) to create
// symlinks via fs.symlinkSync — exactly the failure mode the daemon
// hit and that this port is designed to swallow. We verify behaviour
// where it actually runs (Linux/macOS CI + dev). Windows path is
// covered by the swallow-error semantics in maintainCurrentSymlink.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('electron/log — maintainCurrentSymlink (POSIX)', () => {
  it('creates electron.log symlink pointing at the newest rotated file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-elog-'));
    try {
      // Write two rotated-style files; touch the second one to be newer.
      const older = path.join(dir, 'electron.2026-05-01.log');
      const newer = path.join(dir, 'electron.2026-05-02.log');
      fs.writeFileSync(older, 'old\n');
      fs.writeFileSync(newer, 'new\n');
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(older, past, past);

      maintainCurrentSymlink(dir);

      const linkPath = path.join(dir, ELECTRON_LOG_CURRENT_SYMLINK);
      const lst = fs.lstatSync(linkPath);
      expect(lst.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(linkPath)).toBe('electron.2026-05-02.log');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op (no throw) when log dir has no electron.* files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-elog-empty-'));
    try {
      expect(() => maintainCurrentSymlink(dir)).not.toThrow();
      expect(fs.existsSync(path.join(dir, ELECTRON_LOG_CURRENT_SYMLINK))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('swallows errors when log dir does not exist', () => {
    expect(() => maintainCurrentSymlink('/nonexistent/ccsm/elog/dir')).not.toThrow();
  });
});
