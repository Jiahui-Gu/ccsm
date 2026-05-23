// Unit tests for the shared PII / secret scrubber.
//
// Lives under `tests/` per project convention (renderer-side tests are not
// colocated with src files). The design doc specifies
// `src/shared/__tests__/log.scrub.test.ts` "or equivalent" — `tests/` is the
// equivalent here and matches vitest.config.ts's include glob.
//
// Reverse-verify: each branch has positive + negative cases. To confirm a
// test is non-tautological, comment out the corresponding regex in
// `src/shared/scrub.ts` and run the suite — those tests should fail.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  scrub,
  normalizeError,
  setHomeDir,
} from '../src/shared/scrub';

describe('scrub: env-var key masking', () => {
  beforeEach(() => setHomeDir(null));

  it('redacts ANTHROPIC_* prefix (case-insensitive)', () => {
    expect(scrub({ ANTHROPIC_API_KEY: 'sk-abc' })).toEqual({ ANTHROPIC_API_KEY: '[redacted]' });
    expect(scrub({ anthropic_secret: 'x' })).toEqual({ anthropic_secret: '[redacted]' });
  });
  it('redacts CLAUDE_* prefix', () => {
    expect(scrub({ CLAUDE_MODEL_OVERRIDE: 'x' })).toEqual({ CLAUDE_MODEL_OVERRIDE: '[redacted]' });
  });
  it('redacts AWS_* prefix', () => {
    expect(scrub({ AWS_ACCESS_KEY_ID: 'AKIA...' })).toEqual({
      AWS_ACCESS_KEY_ID: '[redacted]',
    });
    expect(scrub({ AWS_REGION: 'us-east-1' })).toEqual({ AWS_REGION: '[redacted]' });
  });
  it('redacts TOKEN / KEY / SECRET / PASSWORD / AUTH / COOKIE suffixes', () => {
    expect(scrub({ GITHUB_TOKEN: 'ghp_x' })).toEqual({ GITHUB_TOKEN: '[redacted]' });
    expect(scrub({ OPENAI_API_KEY: 'sk-x' })).toEqual({ OPENAI_API_KEY: '[redacted]' });
    expect(scrub({ MY_SECRET: 's' })).toEqual({ MY_SECRET: '[redacted]' });
    expect(scrub({ DB_PASSWORD: 'p' })).toEqual({ DB_PASSWORD: '[redacted]' });
    expect(scrub({ BASIC_AUTH: 'u:p' })).toEqual({ BASIC_AUTH: '[redacted]' });
    expect(scrub({ SESSION_COOKIE: 'c' })).toEqual({ SESSION_COOKIE: '[redacted]' });
  });
  it('redacts _PASS / _URI / _URL / _CREDENTIALS suffixes', () => {
    expect(scrub({ DB_PASS: 'x' })).toEqual({ DB_PASS: '[redacted]' });
    expect(scrub({ REDIS_URI: 'x' })).toEqual({ REDIS_URI: '[redacted]' });
    expect(scrub({ REDIS_URL: 'redis://localhost' })).toEqual({
      REDIS_URL: '[redacted]',
    });
    expect(scrub({ GCP_CREDENTIALS: '{}' })).toEqual({ GCP_CREDENTIALS: '[redacted]' });
  });
  it('does NOT redact unrelated keys', () => {
    expect(scrub({ sid: 'abc-123', count: 5 })).toEqual({ sid: 'abc-123', count: 5 });
    expect(scrub({ debug: true })).toEqual({ debug: true });
  });
});

describe('scrub: home-dir replacement', () => {
  it('replaces Windows-style homedir with ~', () => {
    setHomeDir('C:\\Users\\Jiahui');
    const out = scrub({ reason: 'C:\\Users\\Jiahui\\projects\\ccsm' });
    // Path regex *also* matches `C:\Users\…`, so the leading drive prefix
    // ends up as `[path]`. The home-dir scrub runs first → leaves `~\…`.
    // The `~\…` no longer matches the path regex (no drive letter / system
    // dir prefix). End state: `~\projects\ccsm`.
    expect(out).toEqual({ reason: '~\\projects\\ccsm' });
  });
  it('replaces POSIX homedir with ~', () => {
    setHomeDir('/Users/jiahui');
    expect(scrub({ reason: '/Users/jiahui/repo/file.ts' })).toEqual({
      reason: '~/repo/file.ts',
    });
  });
  it('handles WSL paths via the path regex (no homedir match needed)', () => {
    setHomeDir(null);
    const out = scrub({ reason: '/mnt/c/Users/jiahui/repo' }) as { reason: string };
    expect(out.reason).toBe('[path]');
  });
  it('handles UNC paths', () => {
    setHomeDir(null);
    const out = scrub({ reason: '\\\\?\\C:\\Users\\j\\file' }) as { reason: string };
    expect(out.reason).toBe('[path]');
  });
});

describe('scrub: connection-string detection', () => {
  it('catches mongodb / mongodb+srv', () => {
    expect(scrub({ conn: 'mongodb://u:p@host:27017/db' })).toEqual({
      conn: '[connection-string]',
    });
    expect(scrub({ conn: 'mongodb+srv://u:p@cluster.example.com/db' })).toEqual({
      conn: '[connection-string]',
    });
  });
  it('catches postgres / postgresql', () => {
    expect(scrub({ conn: 'postgres://u:p@host/db' })).toEqual({
      conn: '[connection-string]',
    });
    expect(scrub({ conn: 'postgresql://u:p@host/db' })).toEqual({
      conn: '[connection-string]',
    });
  });
  it('catches mysql / redis', () => {
    expect(scrub({ conn: 'mysql://u:p@host/db' })).toEqual({
      conn: '[connection-string]',
    });
    expect(scrub({ conn: 'redis://localhost:6379' })).toEqual({
      conn: '[connection-string]',
    });
  });
  it('catches userinfo-bearing http(s) URLs', () => {
    expect(scrub({ conn: 'https://user:pw@example.com/x' })).toEqual({
      conn: '[connection-string]',
    });
    expect(scrub({ conn: 'http://api_user:secret@internal.local/' })).toEqual({
      conn: '[connection-string]',
    });
  });
  it('does NOT catch plain https URLs without userinfo', () => {
    const out = scrub({ conn: 'https://example.com/path' });
    expect(out).toEqual({ conn: 'https://example.com/path' });
  });
});

describe('scrub: forbidden field drops', () => {
  it('drops every forbidden key, keeps allowlisted scalars', () => {
    const input = {
      sid: 'abc',
      bytes: 42,
      content: 'this is the actual clipboard content',
      data: 'whatever',
      buffer: Buffer.from('x').toString(),
      text: 'pasted text',
      clipboard: 'clip',
      composition: 'こん',
      name: 'My Session',
      env: { ANTHROPIC_API_KEY: 'x' },
      body: 'http body',
      payload: 'p',
      raw: 'r',
      input: 'i',
      output: 'o',
      stdin: 's',
      stdout: 's',
      stderr: 's',
      args: ['claude', '--resume'],
      argv: [],
      cmdline: 'claude --resume',
      command: 'claude',
      query: 'select 1',
      params: { a: 1 },
      headers: { auth: 'x' },
      cookies: 'k=v',
      authorization: 'Bearer x',
      message: 'user-supplied content',
    };
    const out = scrub(input) as Record<string, unknown>;
    expect(out).toEqual({ sid: 'abc', bytes: 42 });
  });
});

describe('scrub: recursion depth limit', () => {
  it('terminates at depth 4 with a sentinel', () => {
    const deep: Record<string, unknown> = { sid: 'a' };
    deep.next = { sid: 'b', next: { sid: 'c', next: { sid: 'd', next: { sid: 'e' } } } };
    const out = scrub(deep) as { next: { next: { next: { next: unknown } } } };
    // Each level decrements depth by 1; the 5th level should hit the sentinel.
    expect(out.next.next.next.next).toBe('[depth-limit]');
  });
});

describe('scrub: Error.stack scrubbing', () => {
  beforeEach(() => setHomeDir('C:\\Users\\Jiahui'));

  it('scrubs paths from a multi-frame stack', () => {
    const e = new Error('boom');
    e.stack =
      'Error: boom\n' +
      '    at fn (C:\\Users\\Jiahui\\repos\\ccsm\\src\\foo.ts:10:5)\n' +
      '    at other (/Users/jiahui/x.ts:1:1)';
    const norm = normalizeError(e);
    expect(norm.name).toBe('Error');
    expect(norm.message).toBe('boom');
    expect(norm.stack).toContain('~');
    expect(norm.stack).not.toContain('C:\\Users\\Jiahui\\repos');
    expect(norm.stack).not.toContain('/Users/jiahui');
  });

  it('preserves error class name (TypeError etc.) — NOT treated as PII', () => {
    const e = new TypeError('bad');
    const norm = normalizeError(e);
    expect(norm.name).toBe('TypeError');
  });
});

describe('normalizeError: cause chains', () => {
  it('walks `cause` recursively', () => {
    const inner = new Error('inner-cause');
    const outer = new Error('outer');
    (outer as Error & { cause?: unknown }).cause = inner;
    const norm = normalizeError(outer);
    expect(norm.cause?.message).toBe('inner-cause');
    expect(norm.cause?.name).toBe('Error');
  });
  it('handles non-Error inputs gracefully', () => {
    const norm = normalizeError('a string');
    expect(norm.name).toBe('NonError');
    expect(norm.message).toBe('a string');
  });
});

describe('scrub: passthrough of allowed scalars + booleans', () => {
  it('keeps numbers, booleans, null, undefined', () => {
    expect(scrub({ cols: 80, rows: 24, ok: true, bad: false, n: null })).toEqual({
      cols: 80,
      rows: 24,
      ok: true,
      bad: false,
      n: null,
    });
  });
  it('recurses through arrays', () => {
    setHomeDir(null);
    const out = scrub({ items: ['/Users/x/a', 'plain'] }) as { items: string[] };
    expect(out.items[0]).toBe('[path]');
    expect(out.items[1]).toBe('plain');
  });
});
