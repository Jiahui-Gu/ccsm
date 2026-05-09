/**
 * R-47 audit-P0 (Task #162, F-Q-1 + F-T-7): logger smoke tests.
 *
 * Three behaviours we lock in:
 *   1. Default minLevel is `info` — debug events are dropped. This is the
 *      load-bearing assertion for "hot path doesn't spam stderr": the
 *      tunnel-rx narrative log lines (`tunnel.hello`, `tunnel.close`,
 *      etc.) emit at debug, so without the env opt-in production stays
 *      quiet.
 *   2. `CCSM_DEBUG_R39=1` flips the default to `debug`, restoring the
 *      legacy R-39 hello-trace surface for one-off forensics. Without
 *      this gate the only way to see those lines was a code patch.
 *   3. Sensitive keys are redacted. We don't want a future patch handing
 *      a raw `{ access_token, ... }` to `logger.info(...)` to leak the
 *      token into stderr. The denylist is a substring match, so any
 *      key containing `token` / `secret` / `password` / etc. is
 *      replaced with `'[REDACTED]'`.
 *
 * The Logger constructor reads `process.env` once, so each test
 * mutates env, constructs a fresh Logger, and asserts. We restore env
 * + the captured sink in afterEach.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/logger.mjs';

interface CapturedLine {
  level: string;
  raw: string;
  parsed: Record<string, unknown> | null;
}

function makeCapture(): {
  lines: CapturedLine[];
  sink: (level: string, line: string) => void;
} {
  const lines: CapturedLine[] = [];
  return {
    lines,
    sink: (level, line) => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      lines.push({ level, raw: line, parsed });
    },
  };
}

const ENV_KEYS = ['CCSM_DEBUG_R39', 'CCSM_LOG_LEVEL'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('Logger default-quiet (F-Q-1)', () => {
  it('default minLevel=info drops debug events', () => {
    delete process.env.CCSM_DEBUG_R39;
    delete process.env.CCSM_LOG_LEVEL;
    const cap = makeCapture();
    const log = new Logger({ sink: cap.sink });
    log.debug('tunnel.hello', { sid: 'X' });
    log.debug('tunnel.close', { code: 1000 });
    log.info('daemon.http_req', { id: 'r1', path: '/x' });
    expect(cap.lines.length).toBe(1);
    expect(cap.lines[0]?.parsed?.event).toBe('daemon.http_req');
  });

  it('default minLevel=info still emits warn / error', () => {
    delete process.env.CCSM_DEBUG_R39;
    delete process.env.CCSM_LOG_LEVEL;
    const cap = makeCapture();
    const log = new Logger({ sink: cap.sink });
    log.debug('debug.event');
    log.warn('warn.event');
    log.error('error.event');
    const events = cap.lines
      .map((l) => l.parsed?.event)
      .filter((e) => typeof e === 'string');
    expect(events).toEqual(['warn.event', 'error.event']);
  });
});

describe('Logger CCSM_DEBUG_R39 opt-in (F-Q-1)', () => {
  it('CCSM_DEBUG_R39=1 surfaces debug events', () => {
    process.env.CCSM_DEBUG_R39 = '1';
    delete process.env.CCSM_LOG_LEVEL;
    const cap = makeCapture();
    const log = new Logger({ sink: cap.sink });
    log.debug('tunnel.hello', { sid: 'X', last_seq: 5 });
    log.debug('tunnel.close', { code: 1000 });
    expect(cap.lines.length).toBe(2);
    const events = cap.lines.map((l) => l.parsed?.event);
    expect(events).toContain('tunnel.hello');
    expect(events).toContain('tunnel.close');
    // Fields survive through redaction (these are not sensitive keys).
    const hello = cap.lines.find((l) => l.parsed?.event === 'tunnel.hello');
    expect(hello?.parsed?.fields).toMatchObject({ sid: 'X', last_seq: 5 });
  });

  it('CCSM_DEBUG_R39 with any value other than "1" is treated as off', () => {
    process.env.CCSM_DEBUG_R39 = 'true'; // not the literal '1'
    delete process.env.CCSM_LOG_LEVEL;
    const cap = makeCapture();
    const log = new Logger({ sink: cap.sink });
    log.debug('tunnel.hello');
    expect(cap.lines.length).toBe(0);
  });

  it('CCSM_LOG_LEVEL=debug also opens up debug', () => {
    delete process.env.CCSM_DEBUG_R39;
    process.env.CCSM_LOG_LEVEL = 'debug';
    const cap = makeCapture();
    const log = new Logger({ sink: cap.sink });
    log.debug('tunnel.hello');
    expect(cap.lines.length).toBe(1);
  });
});

describe('Logger redaction (F-T-3 parity with cf-worker logger)', () => {
  it('drops keys containing "token" / "secret" / "password" / "cookie"', () => {
    delete process.env.CCSM_DEBUG_R39;
    const cap = makeCapture();
    const log = new Logger({ sink: cap.sink });
    log.info('auth.event', {
      access_token: 'gho_xyz_should_not_appear',
      refresh_token: 'rt_xyz_should_not_appear',
      client_secret: 'cs_xyz_should_not_appear',
      password: 'p_xyz_should_not_appear',
      cookie: 'c_xyz_should_not_appear',
      ok_field: 'visible',
    });
    expect(cap.lines.length).toBe(1);
    const raw = cap.lines[0]!.raw;
    expect(raw).not.toContain('gho_xyz');
    expect(raw).not.toContain('rt_xyz');
    expect(raw).not.toContain('cs_xyz');
    expect(raw).not.toContain('p_xyz');
    expect(raw).not.toContain('c_xyz');
    expect(raw).toContain('visible');
  });

  it('child(requestId) stamps request_id on every record', () => {
    delete process.env.CCSM_DEBUG_R39;
    const cap = makeCapture();
    const log = new Logger({ sink: cap.sink }).child('req-abc');
    log.info('event.a');
    log.info('event.b');
    expect(cap.lines.length).toBe(2);
    expect(cap.lines[0]?.parsed?.request_id).toBe('req-abc');
    expect(cap.lines[1]?.parsed?.request_id).toBe('req-abc');
  });
});
