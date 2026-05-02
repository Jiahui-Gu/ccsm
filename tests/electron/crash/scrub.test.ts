// tests/electron/crash/scrub.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scrubHomePath, redactEnv, redactSecrets } from '../../../electron/crash/scrub';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

import * as os from 'node:os';

beforeEach(() => {
  vi.mocked(os.homedir).mockReset();
});

describe('scrubHomePath', () => {
  it('replaces forward-slash home with ~', () => {
    vi.mocked(os.homedir).mockReturnValue('/Users/alice');
    expect(scrubHomePath('opened /Users/alice/foo')).toBe('opened ~/foo');
  });
  it('replaces back-slash home with ~', () => {
    vi.mocked(os.homedir).mockReturnValue('C:\\Users\\alice');
    expect(scrubHomePath('opened C:\\Users\\alice\\foo')).toBe('opened ~\\foo');
  });
});

describe('redactEnv', () => {
  it('keeps allowlisted keys only', () => {
    const out = redactEnv({
      NODE_ENV: 'production',
      CCSM_FOO: 'x',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: '/usr/bin',
      HOME: '/h',
      SECRET: 's',
    });
    expect(out).toEqual({ NODE_ENV: 'production', CCSM_FOO: 'x', ELECTRON_RUN_AS_NODE: '1' });
  });
  // Task #60 — CCSM_DAEMON_SECRET previously slipped through the CCSM_*
  // allowlist. It must now be excluded so daemon HMAC secrets never land in
  // crash-meta env snapshots. See frag-6-7 §6.6.3.
  it('excludes CCSM_DAEMON_SECRET even though it matches CCSM_*', () => {
    const out = redactEnv({
      CCSM_DAEMON_SECRET: 'super-sekret',
      CCSM_OTHER: 'ok',
    });
    expect(out).toEqual({ CCSM_OTHER: 'ok' });
    expect(out.CCSM_DAEMON_SECRET).toBeUndefined();
  });
});

// Task #60 — three canonical secret patterns must be redacted to <REDACTED>
// across all three crash surfaces. This is the electron/main suite.
describe('redactSecrets (electron main surface)', () => {
  it('(a) redacts Authorization: Bearer <token> in stack-trace strings', () => {
    const stack = 'Error: boom\n  at fetch (Authorization: Bearer sk-ant-1234567890abcdef)\n  at run (foo.ts:1:1)';
    const out = redactSecrets(stack);
    expect(out).toContain('Authorization: <REDACTED>');
    expect(out).not.toContain('sk-ant-1234567890abcdef');
    expect(out).not.toContain('Bearer ');
  });
  it('(b) redacts ANTHROPIC_API_KEY=sk-xxx env-style assignments', () => {
    const line = 'spawn failed: ANTHROPIC_API_KEY=sk-ant-api-9999 PATH=/usr/bin node main.js';
    const out = redactSecrets(line);
    expect(out).toContain('ANTHROPIC_API_KEY=<REDACTED>');
    expect(out).not.toContain('sk-ant-api-9999');
    expect(out).toContain('PATH=/usr/bin');
  });
  it('(c) redacts object property obj.daemonSecret value', () => {
    const obj = { daemonSecret: 'super-sekret-value', ok: 'safe' };
    const out = redactSecrets(obj);
    expect(out.daemonSecret).toBe('<REDACTED>');
    expect(out.ok).toBe('safe');
  });
  it('also redacts nested *.secret keys + helloNonceHmac + Cookie header', () => {
    const obj = {
      daemon: { secret: 'leak-me', port: 9000 },
      helloNonceHmac: 'xx',
      headers: 'Cookie: sid=abcd; other=1',
      authorization: 'Bearer leak2',
    };
    const out = redactSecrets(obj);
    expect((out.daemon as any).secret).toBeDefined();
    // daemon.secret is a nested object property; the inner "secret" key is in
    // the SECRET_KEY_NAMES set so it MUST be redacted.
    expect((out.daemon as any).secret).toBe('<REDACTED>');
    expect((out.daemon as any).port).toBe(9000);
    expect(out.helloNonceHmac).toBe('<REDACTED>');
    expect(out.headers).toContain('Cookie: <REDACTED>');
    expect(out.authorization).toBe('<REDACTED>');
  });
  it('handles cycles without throwing', () => {
    const a: any = { x: 1 };
    a.self = a;
    const out = redactSecrets(a);
    expect(out.x).toBe(1);
    expect(out.self).toBe('[Circular]');
  });
  it('passes primitives through unchanged', () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(true)).toBe(true);
  });
});
