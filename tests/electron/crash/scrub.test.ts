// tests/electron/crash/scrub.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scrubHomePath, redactEnv } from '../../../electron/crash/scrub';

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
});
