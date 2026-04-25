import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the legacy + SDK runners so the factory can be exercised without
// touching real spawn / SDK code paths.
vi.mock('../../agent/sessions', () => {
  return {
    SessionRunner: vi.fn().mockImplementation((id: string) => ({ __kind: 'legacy', id })),
  };
});
vi.mock('../sessions', () => {
  return {
    SdkSessionRunner: vi.fn().mockImplementation((id: string) => ({ __kind: 'sdk', id })),
  };
});

import { createRunner, isSdkRunnerEnabled } from '../runner-factory';

describe('agent-sdk/runner-factory', () => {
  const orig = process.env.CCSM_USE_SDK;

  beforeEach(() => {
    delete process.env.CCSM_USE_SDK;
  });

  afterEach(() => {
    if (orig === undefined) delete process.env.CCSM_USE_SDK;
    else process.env.CCSM_USE_SDK = orig;
  });

  describe('isSdkRunnerEnabled', () => {
    it('returns false when env var is unset', () => {
      delete process.env.CCSM_USE_SDK;
      expect(isSdkRunnerEnabled()).toBe(false);
    });

    it('returns false for empty string', () => {
      process.env.CCSM_USE_SDK = '';
      expect(isSdkRunnerEnabled()).toBe(false);
    });

    it.each(['1', 'true', 'TRUE', 'yes', '  yes  '])('returns true for %s', (v) => {
      process.env.CCSM_USE_SDK = v;
      expect(isSdkRunnerEnabled()).toBe(true);
    });

    it.each(['0', 'false', 'no', 'random'])('returns false for %s', (v) => {
      process.env.CCSM_USE_SDK = v;
      expect(isSdkRunnerEnabled()).toBe(false);
    });
  });

  describe('createRunner', () => {
    const noop = () => {};

    it('returns the legacy runner by default', () => {
      const r = createRunner('s1', noop, noop, noop, noop) as unknown as { __kind: string };
      expect(r.__kind).toBe('legacy');
    });

    it('returns the SDK runner when flag is on', () => {
      process.env.CCSM_USE_SDK = '1';
      const r = createRunner('s2', noop, noop, noop, noop) as unknown as { __kind: string };
      expect(r.__kind).toBe('sdk');
    });

    it('falls back to the legacy runner when flag becomes off again', () => {
      process.env.CCSM_USE_SDK = '1';
      const a = createRunner('a', noop, noop, noop, noop) as unknown as { __kind: string };
      expect(a.__kind).toBe('sdk');

      process.env.CCSM_USE_SDK = '0';
      const b = createRunner('b', noop, noop, noop, noop) as unknown as { __kind: string };
      expect(b.__kind).toBe('legacy');
    });
  });
});
