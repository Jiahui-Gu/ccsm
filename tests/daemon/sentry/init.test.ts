// tests/daemon/sentry/init.test.ts
//
// Phase 2 crash observability (spec §5.2 / §6, plan Task 8) — daemon-side
// @sentry/node init. Verifies:
//   * no-op when DSN env unset / empty / `***REDACTED***`
//   * Sentry.init called with `tags.surface = 'daemon'` + bootNonce when DSN set
//   * flushDaemonSentry / captureDaemonException swallow transport errors
//
// Uses the SentryLike DI seam exposed by daemon/src/sentry/init.ts (npm
// workspaces resolve @sentry/node to a daemon-local copy that vi.mock can't
// reliably intercept; DI is more robust and equally clear).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  initDaemonSentry,
  flushDaemonSentry,
  captureDaemonException,
  _resetDaemonSentryForTesting,
  type SentryLike,
} from '../../../daemon/src/sentry/init';

function makeSpy(): { sentry: SentryLike; init: any; flush: any; captureException: any } {
  const init = vi.fn();
  const flush = vi.fn().mockResolvedValue(true);
  const captureException = vi.fn();
  return { sentry: { init, flush, captureException }, init, flush, captureException };
}

beforeEach(() => {
  _resetDaemonSentryForTesting();
});

describe('initDaemonSentry', () => {
  it('returns false (no init) when DSN is empty string', () => {
    const { sentry, init } = makeSpy();
    const ok = initDaemonSentry({ dsn: '', release: '0.3.0', bootNonce: 'BN', consent: 'opted-in', sentry });
    expect(ok).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('returns false when DSN is the redacted placeholder', () => {
    const { sentry, init } = makeSpy();
    const ok = initDaemonSentry({ dsn: '***REDACTED***', release: '0.3.0', bootNonce: 'BN', consent: 'opted-in', sentry });
    expect(ok).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('returns false when DSN is whitespace only', () => {
    const { sentry, init } = makeSpy();
    const ok = initDaemonSentry({ dsn: '   ', release: '0.3.0', bootNonce: 'BN', consent: 'opted-in', sentry });
    expect(ok).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('initializes with surface=daemon + bootNonce tag when DSN set', () => {
    const { sentry, init } = makeSpy();
    const ok = initDaemonSentry({
      dsn: 'https://x@y.ingest.sentry.io/1',
      release: '0.3.0',
      bootNonce: 'BN-XYZ',
      consent: 'opted-in',
      sentry,
    });
    expect(ok).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    const arg = init.mock.calls[0][0];
    expect(arg.dsn).toBe('https://x@y.ingest.sentry.io/1');
    expect(arg.release).toBe('0.3.0');
    expect(arg.initialScope.tags.surface).toBe('daemon');
    expect(arg.initialScope.tags.bootNonce).toBe('BN-XYZ');
  });

  // Phase 4 consent gate.
  it('returns false when consent is pending (default), even with valid DSN', () => {
    const { sentry, init } = makeSpy();
    const ok = initDaemonSentry({
      dsn: 'https://x@y.ingest.sentry.io/1',
      release: '0.3.0',
      bootNonce: 'BN',
      // consent omitted — defaults to 'pending'
      sentry,
    });
    expect(ok).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('returns false when consent is opted-out, even with valid DSN', () => {
    const { sentry, init } = makeSpy();
    const ok = initDaemonSentry({
      dsn: 'https://x@y.ingest.sentry.io/1',
      release: '0.3.0',
      bootNonce: 'BN',
      consent: 'opted-out',
      sentry,
    });
    expect(ok).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('flushDaemonSentry swallows transport errors', async () => {
    const { sentry, flush } = makeSpy();
    flush.mockRejectedValueOnce(new Error('network down'));
    initDaemonSentry({ dsn: 'https://x@y/1', release: '0', bootNonce: 'B', consent: 'opted-in', sentry });
    await expect(flushDaemonSentry(50)).resolves.toBeUndefined();
    expect(flush).toHaveBeenCalledWith(50);
  });

  it('captureDaemonException swallows transport errors', () => {
    const { sentry, captureException } = makeSpy();
    captureException.mockImplementationOnce(() => { throw new Error('boom'); });
    initDaemonSentry({ dsn: 'https://x@y/1', release: '0', bootNonce: 'B', consent: 'opted-in', sentry });
    expect(() => captureDaemonException(new Error('x'))).not.toThrow();
    expect(captureException).toHaveBeenCalled();
  });
});
