/**
 * R-46 audit-P0 (Task #158, F-T-1): logger module unit tests.
 *
 * Locks JSON wire format, level filtering, redaction of sensitive fields,
 * cf-ray-based request_id derivation, and child(requestId) propagation.
 *
 * Redaction tests are load-bearing for F-T-3: the OAuth event log paths
 * must NEVER leak access_token / refresh_token / cookie body / JWT body.
 * If a future patch hands a raw object containing these keys to
 * `logger.info(...)`, this test ensures sanitizeFields drops them.
 */
import { describe, it, expect } from 'vitest';
import {
  Logger,
  sanitizeFields,
  shortSub,
  deriveRequestId,
} from '../src/logger';

interface CapturedLine {
  level: string;
  parsed: Record<string, unknown>;
}

function capture(): {
  lines: CapturedLine[];
  sink: (level: 'debug' | 'info' | 'warn' | 'error', line: string) => void;
} {
  const lines: CapturedLine[] = [];
  return {
    lines,
    sink: (level, line) => {
      lines.push({ level, parsed: JSON.parse(line) as Record<string, unknown> });
    },
  };
}

describe('Logger — wire format', () => {
  it('emits one JSON line per call with ts/level/event', () => {
    const cap = capture();
    const log = new Logger({
      sink: cap.sink,
      clock: () => Date.UTC(2026, 4, 10, 3, 24, 59, 123),
    });
    log.info('worker.route', { path: '/api/foo', upgrade: false });
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]!.parsed).toEqual({
      ts: '2026-05-10T03:24:59.123Z',
      level: 'info',
      event: 'worker.route',
      fields: { path: '/api/foo', upgrade: false },
    });
  });

  it('omits fields when none supplied', () => {
    const cap = capture();
    const log = new Logger({ sink: cap.sink });
    log.info('worker.boot');
    expect(cap.lines[0]!.parsed.fields).toBeUndefined();
    expect(cap.lines[0]!.parsed.event).toBe('worker.boot');
  });

  it('routes warn/error to matching console methods', () => {
    const cap = capture();
    const log = new Logger({ sink: cap.sink });
    log.debug('a'); // dropped by default minLevel=info
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(cap.lines.map((l) => l.level)).toEqual(['info', 'warn', 'error']);
  });
});

describe('Logger — level filter', () => {
  it('drops records below minLevel', () => {
    const cap = capture();
    const log = new Logger({ sink: cap.sink, minLevel: 'warn' });
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(cap.lines.map((l) => (l.parsed as { event: string }).event)).toEqual([
      'c',
      'd',
    ]);
  });

  it('debug minLevel emits everything', () => {
    const cap = capture();
    const log = new Logger({ sink: cap.sink, minLevel: 'debug' });
    log.debug('a');
    log.info('b');
    expect(cap.lines).toHaveLength(2);
  });
});

describe('Logger — sensitive field redaction (F-T-3)', () => {
  it('redacts access_token / refresh_token / jwt / cookie / authorization keys', () => {
    const cap = capture();
    const log = new Logger({ sink: cap.sink });
    log.info('oauth.callback_ok', {
      login: 'octocat',
      access_token: 'gho_supersecret123456789',
      refresh_token: 'rfsh_topsecret',
      web_jwt: 'eyJhbGc.payload.sig',
      cookie: 'web_jwt=eyJhbGc...',
      Authorization: 'Bearer eyJhbGc.payload.sig',
      sub_prefix: 'abcd1234',
    });
    expect(cap.lines).toHaveLength(1);
    const line = JSON.stringify(cap.lines[0]!.parsed);
    // Hard guard: no plaintext secret material in the rendered line.
    expect(line).not.toContain('gho_supersecret');
    expect(line).not.toContain('rfsh_topsecret');
    expect(line).not.toContain('eyJhbGc.payload.sig');
    expect(line).not.toContain('Bearer ');
    // Non-sensitive fields survive.
    expect((cap.lines[0]!.parsed.fields as Record<string, unknown>).login).toBe(
      'octocat',
    );
    expect(
      (cap.lines[0]!.parsed.fields as Record<string, unknown>).sub_prefix,
    ).toBe('abcd1234');
  });

  it('redaction is case-insensitive and substring-based', () => {
    expect(sanitizeFields({ ACCESS_TOKEN: 'x' })).toEqual({
      ACCESS_TOKEN: '[REDACTED]',
    });
    expect(sanitizeFields({ user_password: 'x' })).toEqual({
      user_password: '[REDACTED]',
    });
    expect(sanitizeFields({ 'set-cookie': 'x' })).toEqual({
      'set-cookie': '[REDACTED]',
    });
    // Non-sensitive look-alike survives.
    expect(sanitizeFields({ token_prefix: 'gho_a' })).toEqual({
      token_prefix: '[REDACTED]', // contains "token"
    });
    expect(sanitizeFields({ jti: 'abc123' })).toEqual({ jti: 'abc123' });
  });

  it('redacts nested objects recursively', () => {
    const out = sanitizeFields({
      meta: {
        login: 'octocat',
        access_token: 'gho_x',
      },
    });
    expect(out).toEqual({
      meta: { login: 'octocat', access_token: '[REDACTED]' },
    });
  });
});

describe('Logger — child(requestId) propagation', () => {
  it('binds request_id to every emitted record', () => {
    const cap = capture();
    const root = new Logger({ sink: cap.sink });
    const child = root.child('req-abc-123');
    child.info('worker.route', { path: '/api/foo' });
    child.warn('oauth.callback_fail', { reason: 'csrf_mismatch' });
    expect(cap.lines).toHaveLength(2);
    expect(cap.lines[0]!.parsed.request_id).toBe('req-abc-123');
    expect(cap.lines[1]!.parsed.request_id).toBe('req-abc-123');
  });

  it('root logger emits no request_id when unbound', () => {
    const cap = capture();
    const root = new Logger({ sink: cap.sink });
    root.info('worker.boot');
    expect(cap.lines[0]!.parsed.request_id).toBeUndefined();
  });
});

describe('shortSub', () => {
  it('returns first 8 chars', () => {
    expect(shortSub('1234567890abcdef')).toBe('12345678');
  });
  it('returns - for empty/null/undefined', () => {
    expect(shortSub(undefined)).toBe('-');
    expect(shortSub(null)).toBe('-');
    expect(shortSub('')).toBe('-');
  });
  it('passes through short subs unchanged', () => {
    expect(shortSub('abc')).toBe('abc');
  });
});

describe('deriveRequestId', () => {
  it('uses cf-ray when present', () => {
    const req = new Request('http://x/y', {
      headers: { 'cf-ray': '8aabbccddee0001-IAD' },
    });
    expect(deriveRequestId(req)).toBe('8aabbccddee0001-IAD');
  });
  it('falls back to uuid when cf-ray absent', () => {
    const req = new Request('http://x/y');
    const id = deriveRequestId(req);
    // uuid v4 shape (36 chars, 8-4-4-4-12)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
